import { storage } from "./storage";
import { getOnChainBalance } from "./sui-verify";
import { getAdapter } from "./dex/index";
import { TypusAdapter } from "./dex/typus-adapter";
import { getThrottledSuiClient } from "./rpc-throttle";

const pendingRecoveryCloses: Array<{ agentId: string; positionId: string }> = [];
export function getPendingRecoveryCloses() { return [...pendingRecoveryCloses]; }
export function clearPendingRecoveryCloses() { pendingRecoveryCloses.length = 0; }

const suiClient = getThrottledSuiClient();

async function voidRewardsForPosition(pos: { id: string; agentId: string; closedAt: Date | string | null }, agentName: string, reason: string): Promise<string> {
  try {
    if (!pos.closedAt) return "";
    const allRewards = await storage.getRewards();
    const closedTime = new Date(pos.closedAt).getTime();
    const agentRewards = allRewards.filter(r =>
      r.agentId === pos.agentId &&
      r.status === "pending" &&
      r.createdAt &&
      Math.abs(new Date(r.createdAt).getTime() - closedTime) < 10000
    );

    let voided = 0;
    for (const reward of agentRewards) {
      await storage.voidReward(reward.id);
      voided++;
      console.log(`[integrity] Voided reward ${reward.id} (${reward.amount} SUI) for ${agentName}: ${reason}`);
    }
    if (voided > 0) return ` Voided ${voided} associated reward(s).`;
  } catch (err: any) {
    console.log(`[integrity] Failed to void rewards for position ${pos.id}: ${err.message}`);
  }
  return "";
}

export async function runStartupIntegrityChecks(): Promise<void> {
  console.log("[integrity] Running startup data integrity checks...");

  try {
    await cleanupBogusRecoveries();
    await reopenPhantomClosedPositions();
    await recoverUnfilledCloseOrders();
    await cancelStaleUnfilledOpenOrders();
    await fixCorruptedPositions();
    await scanOnChainLiquidationEvents();
    await reclassifyMisidentifiedLiquidations();
    await voidRewardsFromLiquidatedPositions();
    await recalculateClosedPositionPnls();
    await recoverOnChainPositionIds();
    await fixLiquidationPrices();
    await recalculateAgentBalances();
    await backfillRewardAgentNames();
    await detectUntrackedPositions();
    await recoverOrphanedTypusOrders();
    await voidDuplicatePendingRewards();
    console.log("[integrity] Startup integrity checks completed.");
  } catch (err: any) {
    console.error("[integrity] Startup integrity check error:", err.message);
  }
}

async function cleanupBogusRecoveries(): Promise<void> {
  const allAgents = await storage.getAgents();
  let totalDeleted = 0;
  let totalRecalculated = 0;

  for (const agent of allAgents) {
    const positions = await storage.getPositions(agent.id);

    const previouslyMarkedBogus = positions.filter(p =>
      p.closeReason === "deleted_bogus_recovery"
    );

    const recoveryPositions = positions.filter(p =>
      (p.txDigest?.startsWith("recovered_order_") ||
       p.txDigest?.startsWith("recovered_onchain_") ||
       p.txDigest?.startsWith("reopened_order_") ||
       p.txDigest?.startsWith("reopened_")) &&
      p.closeReason !== "deleted_bogus_recovery"
    );

    const positionsToDelete: typeof positions = [];

    for (const pos of previouslyMarkedBogus) {
      positionsToDelete.push(pos);
    }

    for (const pos of recoveryPositions) {
      if (positionsToDelete.some(d => d.id === pos.id)) continue;

      if (pos.entryPrice === 0 || pos.entryPrice === null) {
        positionsToDelete.push(pos);
        continue;
      }

      if ((pos as any).closeTxDigest === "position_gone_onchain" || (pos as any).closeReason === "liquidated") {
        positionsToDelete.push(pos);
        continue;
      }

      const posCollateral = pos.sizeSui / (agent.leverage || 25);
      const posPnl = Math.abs(pos.unrealizedPnl || 0);
      if (posCollateral > 0 && posPnl > posCollateral * 5) {
        console.log(`[integrity] Recovery position ${pos.id} has inflated PnL: ${(pos.unrealizedPnl || 0).toFixed(4)} vs collateral ${posCollateral.toFixed(4)} — marking as bogus`);
        positionsToDelete.push(pos);
        continue;
      }

      if (pos.onChainPositionId) {
        const realDuplicate = positions.find(p =>
          p.id !== pos.id &&
          p.onChainPositionId === pos.onChainPositionId &&
          !p.txDigest?.startsWith("recovered_order_") &&
          !p.txDigest?.startsWith("recovered_onchain_") &&
          p.closeReason !== "deleted_bogus_recovery"
        );
        if (realDuplicate) {
          positionsToDelete.push(pos);
          continue;
        }

        const allRecoveriesForId = recoveryPositions.filter(p =>
          p.onChainPositionId === pos.onChainPositionId
        );
        if (allRecoveriesForId.length > 1) {
          const sorted = allRecoveriesForId.sort((a, b) =>
            new Date(b.openedAt || 0).getTime() - new Date(a.openedAt || 0).getTime()
          );
          for (let i = 1; i < sorted.length; i++) {
            if (!positionsToDelete.some(d => d.id === sorted[i].id)) {
              positionsToDelete.push(sorted[i]);
            }
          }
        }
      }
    }

    const isRecovery = (d: typeof positions[0]) =>
      d.txDigest?.startsWith("recovered_") || d.txDigest?.startsWith("reopened_");
    const score = (d: typeof positions[0]) => {
      let s = 0;
      if (d.entryPrice > 0) s += 10;
      if (d.status === "open") s += 5;
      if (d.verified) s += 3;
      if (!isRecovery(d)) s += 2;
      return s;
    };

    const seenOnChainIds = new Map<string, typeof positions[0]>();
    for (const pos of positions) {
      if (!pos.onChainPositionId || positionsToDelete.some(d => d.id === pos.id)) continue;
      const existing = seenOnChainIds.get(pos.onChainPositionId);
      if (existing) {
        const existingScore = score(existing);
        const posScore = score(pos);
        const dupToRemove = posScore > existingScore ? existing : pos;
        const keeper = posScore > existingScore ? pos : existing;
        if (!positionsToDelete.some(d => d.id === dupToRemove.id)) {
          console.log(`[integrity] Duplicate on-chain position ${pos.onChainPositionId} for ${agent.name}: keeping ${keeper.id} (score=${Math.max(existingScore, posScore)}), removing ${dupToRemove.id} (score=${Math.min(existingScore, posScore)})`);
          positionsToDelete.push(dupToRemove);
          if (posScore > existingScore) seenOnChainIds.set(pos.onChainPositionId, pos);
        }
      } else {
        seenOnChainIds.set(pos.onChainPositionId, pos);
      }
    }

    const openPositions = positions.filter(p =>
      (p.status === "open" || p.status === "pending_open") &&
      !positionsToDelete.some(d => d.id === p.id)
    );
    const contentKey = (p: typeof positions[0]) =>
      `${p.side}_${p.entryPrice.toFixed(6)}_${p.sizeSui.toFixed(2)}`;
    const seenByContent = new Map<string, typeof positions[0]>();
    for (const pos of openPositions) {
      if (positionsToDelete.some(d => d.id === pos.id)) continue;
      const key = contentKey(pos);
      const existing = seenByContent.get(key);
      if (existing) {
        const existingScore = score(existing);
        const posScore = score(pos);
        const dupToRemove = posScore > existingScore ? existing : pos;
        const keeper = posScore > existingScore ? pos : existing;
        if (!positionsToDelete.some(d => d.id === dupToRemove.id)) {
          console.log(`[integrity] Content-duplicate position for ${agent.name}: ${key} (posIds: ${keeper.onChainPositionId} vs ${dupToRemove.onChainPositionId}): keeping ${keeper.id} (score=${Math.max(existingScore, posScore)}), removing ${dupToRemove.id} (score=${Math.min(existingScore, posScore)})`);
          positionsToDelete.push(dupToRemove);
          if (posScore > existingScore) seenByContent.set(key, pos);
        }
      } else {
        seenByContent.set(key, pos);
      }
    }

    if (positionsToDelete.length > 0) {
      for (const bogus of positionsToDelete) {
        try {
          await voidRewardsForPosition(bogus, agent.name, "bogus recovery position hard-deleted");
          const deleted = await storage.deletePosition(bogus.id);
          if (deleted) {
            totalDeleted++;
            console.log(`[integrity] HARD-DELETED bogus position ${bogus.id} for ${agent.name}: txDigest=${(bogus.txDigest || '').slice(0,40)}, entry=$${bogus.entryPrice}, pnl=${(bogus.unrealizedPnl || 0).toFixed(4)}, posId=${bogus.onChainPositionId}, status=${bogus.status}`);
          }
        } catch (err: any) {
          console.log(`[integrity] Failed to hard-delete position ${bogus.id}: ${err.message}`);
        }
      }

      const freshPositions = await storage.getPositions(agent.id);
      const closedValid = freshPositions.filter(p =>
        p.status === "closed" &&
        p.closeReason !== "deleted_bogus_recovery" &&
        p.closeReason !== "cancelled" &&
        !p.txDigest?.startsWith("recovered_onchain_") &&
        !p.txDigest?.startsWith("recovered_order_")
      );
      let recalcPnl = 0;
      let wins = 0;
      let losses = 0;
      for (const cp of closedValid) {
        const pnl = cp.unrealizedPnl || 0;
        recalcPnl += pnl;
        if (pnl > 0) wins++;
        else if (pnl < 0) losses++;
      }
      const totalTrades = wins + losses;
      const winRate = totalTrades > 0 ? wins / totalTrades : 0;

      let recalcBalance = agent.balance;
      if (agent.walletAddress) {
        try {
          const onChain = await getOnChainBalance(agent.walletAddress);
          const openRemaining = freshPositions.filter(p => p.status === "open" || p.status === "pending_open");
          const lockedCollateral = openRemaining.reduce((s, p) => s + (p.collateral || p.sizeSui / (agent.leverage || 25)), 0);
          const computedBalance = onChain.sui + lockedCollateral;
          if (computedBalance > agent.balance) {
            recalcBalance = computedBalance;
          }
          console.log(`[integrity] ${agent.name} balance recalc: onChain=${onChain.sui.toFixed(4)}, locked=${lockedCollateral.toFixed(4)}, computed=${computedBalance.toFixed(4)}, using=${recalcBalance.toFixed(4)}`);
        } catch (balErr: any) {
          console.log(`[integrity] Balance recalc failed for ${agent.name}: ${balErr.message} — keeping DB balance`);
        }
      }

      console.log(`[integrity] Recalculating ${agent.name} stats after cleanup: totalPnl ${agent.totalPnl?.toFixed(4)} → ${recalcPnl.toFixed(4)}, trades ${agent.totalTrades} → ${totalTrades}, winRate ${(agent.winRate || 0).toFixed(2)} → ${winRate.toFixed(2)}, balance ${agent.balance.toFixed(4)} → ${recalcBalance.toFixed(4)}`);
      await storage.updateAgent(agent.id, {
        totalPnl: recalcPnl,
        totalTrades,
        winRate,
        balance: recalcBalance,
      });
      totalRecalculated++;
    }
  }

  if (totalDeleted > 0 || totalRecalculated > 0) {
    console.log(`[integrity] Cleanup: hard-deleted ${totalDeleted} bogus/recovery positions, recalculated ${totalRecalculated} agent stats.`);
  } else {
    console.log(`[integrity] No bogus recovery positions found.`);
  }
}

async function cancelStaleUnfilledOpenOrders(): Promise<void> {
  const allAgents = await storage.getAgents();
  let totalCancelled = 0;
  let totalRecovered = 0;

  const adapter = getAdapter("typus");
  if (!(adapter instanceof TypusAdapter) || !adapter.isReady()) {
    console.log("[integrity] Typus adapter not ready — skipping unfilled order scan.");
    return;
  }

  for (const agent of allAgents) {
    if (!agent.walletAddress || !agent.agentWallet) continue;

    try {
      const recentTxs = await suiClient.queryTransactionBlocks({
        filter: { FromAddress: agent.walletAddress },
        options: { showEvents: true, showEffects: true, showInput: true },
        limit: 20,
        order: "descending" as any,
      });

      if (!recentTxs?.data) continue;

      const unfilledOrderIds: string[] = [];
      const filledOrderIds = new Set<string>();
      const orderNotFoundIds = new Set<string>();
      const createdOrderIds = new Set<string>();

      for (const txBlock of recentTxs.data) {
        const events = (txBlock as any).events;
        if (!events) continue;
        for (const evt of events) {
          const parsed = (evt as any).parsedJson;
          if (!parsed) continue;
          const evtType = (evt as any).type || "";

          if (evtType.includes("OrderFilledEvent") && parsed.order_id) {
            filledOrderIds.add(String(parsed.order_id));
          }

          if (evtType.includes("CreateTradingOrderEvent") &&
              parsed.filled === false &&
              parsed.reduce_only === false &&
              (parsed.linked_position_id === null || parsed.linked_position_id === "null" || parsed.linked_position_id === undefined) &&
              parsed.order_id) {
            unfilledOrderIds.push(String(parsed.order_id));
            createdOrderIds.add(String(parsed.order_id));
          }
        }
      }

      for (const txBlock of recentTxs.data) {
        const status = (txBlock as any).effects?.status;
        if (status?.status === "failure" && status.error?.includes("order_not_found")) {
          const inputs = (txBlock as any).transaction?.data?.transaction?.inputs || [];
          for (const inp of inputs) {
            if (inp.type === "pure" && inp.valueType === "u64") {
              const val = String(inp.value);
              if (createdOrderIds.has(val)) {
                orderNotFoundIds.add(val);
              }
            }
          }
        }
      }
      if (orderNotFoundIds.size > 0) {
        console.log(`[integrity] ${agent.name}: ${orderNotFoundIds.size} order(s) already gone from Typus (order_not_found in prior cancel TXs): ${[...orderNotFoundIds].join(", ")}`);
      }

      let pendingOrderIds = unfilledOrderIds.filter(id => !filledOrderIds.has(id) && !orderNotFoundIds.has(id));

      if (pendingOrderIds.length === 0) continue;

      try {
        const onChainPositions = await adapter.getPositions(agent.walletAddress!);
        if (onChainPositions.length > 0) {
          const onChainOrderIds = new Set<string>();
          for (const pos of onChainPositions) {
            if (pos.orderId) onChainOrderIds.add(String(pos.orderId));
          }
          const beforeCount = pendingOrderIds.length;
          pendingOrderIds = pendingOrderIds.filter(id => !onChainOrderIds.has(id));
          if (beforeCount > pendingOrderIds.length) {
            console.log(`[integrity] ${agent.name}: ${beforeCount - pendingOrderIds.length} "unfilled" order(s) are actually filled (position exists on-chain) — skipping cancel`);
          }
        }
      } catch (posErr: any) {
        console.log(`[integrity] ${agent.name}: Could not verify on-chain positions: ${posErr.message}`);
      }

      if (pendingOrderIds.length === 0) continue;

      console.log(`[integrity] Found ${pendingOrderIds.length} unfilled open order(s) for ${agent.name}: ${pendingOrderIds.join(", ")}. Cancelling to recover collateral...`);

      for (const orderId of pendingOrderIds) {
        try {
          const cancelResult = await adapter.cancelUnfilledOrder(agent.agentWallet, orderId);
          if (cancelResult.cancelled) {
            console.log(`[integrity] Cancelled unfilled order ${orderId} for ${agent.name}: tx=${cancelResult.txDigest}, collateralReturned=${cancelResult.collateralReturned}`);
            totalCancelled++;
            if (cancelResult.collateralReturned) totalRecovered++;
          } else if (cancelResult.error && (cancelResult.error.includes("order_not_found") || cancelResult.error.includes("position_not_found"))) {
            console.log(`[integrity] Order ${orderId} for ${agent.name} already filled/cancelled on-chain — skipping`);
          } else {
            console.log(`[integrity] Failed to cancel order ${orderId} for ${agent.name}: ${cancelResult.error}`);
          }
        } catch (cancelErr: any) {
          console.log(`[integrity] Cancel error for order ${orderId} (${agent.name}): ${cancelErr.message}`);
        }
      }

      if (totalCancelled > 0) {
        try {
          const onChain = await getOnChainBalance(agent.walletAddress);
          const openPositions = await storage.getOpenPositions(agent.id);
          const lockedCollateral = openPositions.reduce((s, p) => s + p.sizeSui / agent.leverage, 0);
          const correctedBalance = onChain.sui + lockedCollateral;
          console.log(`[integrity] ${agent.name} balance synced after cancel: on-chain=${onChain.sui.toFixed(4)}, locked=${lockedCollateral.toFixed(4)}, total=${correctedBalance.toFixed(4)}`);
          await storage.updateAgent(agent.id, {
            balance: correctedBalance,
            lastExecutionError: `Recovered collateral from ${totalCancelled} stale unfilled order(s) at startup`,
          });
        } catch (balErr: any) {
          console.log(`[integrity] Balance sync failed for ${agent.name}: ${balErr.message}`);
        }
      }
    } catch (err: any) {
      console.log(`[integrity] Error scanning unfilled orders for ${agent.name}: ${err.message}`);
    }
  }

  if (totalCancelled > 0) {
    console.log(`[integrity] Cancelled ${totalCancelled} stale unfilled orders (${totalRecovered} with collateral confirmed returned).`);
  } else {
    console.log("[integrity] No stale unfilled open orders found.");
  }
}

async function reopenPhantomClosedPositions(): Promise<void> {
  const allAgents = await storage.getAgents();
  let totalReopened = 0;

  for (const agent of allAgents) {
    let agentReopened = 0;
    const positions = await storage.getPositions(agent.id);
    const FAKE_CLOSE_DIGESTS = ["closed_externally", "closed_external", "settled_onchain"];
    const phantomCloses = positions.filter(p =>
      p.status === "closed" &&
      (!p.closeTxDigest || FAKE_CLOSE_DIGESTS.includes(p.closeTxDigest)) &&
      p.txDigest &&
      !p.txDigest.startsWith("sim_")
    );

    if (phantomCloses.length === 0) continue;

    for (const pos of phantomCloses) {
      const hasFakeDigest = pos.closeTxDigest && FAKE_CLOSE_DIGESTS.includes(pos.closeTxDigest);

      if (hasFakeDigest && agent.walletAddress) {
        let confirmedOnChainClose = false;
        let confirmedCloseTxDigest: string | null = null;
        const scanForCloseEvents = async (filter: any) => {
          const recentTxs = await suiClient.queryTransactionBlocks({
            filter,
            options: { showEvents: true },
            limit: 25,
            order: "descending" as any,
          });
          if (!recentTxs?.data) return;
          for (const txBlock of recentTxs.data) {
            const events = (txBlock as any).events;
            if (!events) continue;
            for (const evt of events) {
              const parsed = (evt as any).parsedJson;
              if (!parsed) continue;
              const evtType = (evt as any).type || "";
              const matchesPosition =
                String(parsed.position_id || parsed.new_position_id || "") === pos.onChainPositionId ||
                String(parsed.linked_position_id || "") === pos.onChainPositionId;
              if (
                (evtType.includes("OrderFilledEvent") || evtType.includes("LiquidateEvent")) &&
                matchesPosition
              ) {
                const isClose = evtType.includes("LiquidateEvent") || parsed.reduce_only === true || parsed.is_reduce_only === true ||
                  (parsed.new_position_id === undefined || parsed.new_position_id === null || String(parsed.new_position_id) === "0");
                if (isClose) {
                  confirmedOnChainClose = true;
                  confirmedCloseTxDigest = (txBlock as any).digest;
                  console.log(`[integrity] On-chain close/liquidation event found for ${agent.name} position ${pos.onChainPositionId} in tx ${confirmedCloseTxDigest} — NOT reopening.`);
                  return;
                }
              }
            }
          }
        };
        try {
          await scanForCloseEvents({ ToAddress: agent.walletAddress });
          if (!confirmedOnChainClose) {
            await scanForCloseEvents({ FromAddress: agent.walletAddress });
          }
        } catch (err: any) {
          console.log(`[integrity] On-chain close verification failed for ${agent.name}: ${err.message} — skipping reopen to be safe`);
          continue;
        }

        if (confirmedOnChainClose) {
          if (confirmedCloseTxDigest && pos.closeTxDigest !== confirmedCloseTxDigest) {
            console.log(`[integrity] Updating closeTxDigest for ${agent.name} position ${pos.id}: ${pos.closeTxDigest} → ${confirmedCloseTxDigest}`);
            await storage.updatePosition(pos.id, { closeTxDigest: confirmedCloseTxDigest });
          }
          continue;
        }
      }

      const wasForceSettled = pos.closeTxDigest === "settled_onchain";
      const hasValidOnChainId = pos.onChainPositionId && !pos.onChainPositionId.includes("-");

      if (wasForceSettled && !hasValidOnChainId && agent.walletAddress) {
        let resolvedId: string | null = null;
        try {
          if (pos.txDigest && !pos.txDigest.startsWith("sim_")) {
            resolvedId = await resolvePositionIdFromOpenTx(agent.walletAddress, pos.txDigest);
          }
          if (!resolvedId) {
            const orderId = pos.onChainPositionId || pos.txDigest;
            if (orderId) {
              resolvedId = await TypusAdapter.resolvePositionIdFromOrderId(suiClient as any, agent.walletAddress, orderId);
            }
          }
          if (!resolvedId) {
            const adapter = getAdapter(agent.venue || "typus");
            if (adapter && agent.walletAddress) {
              const openOnChain = await adapter.getPositions(agent.walletAddress);
              const match = openOnChain.find((op: any) => op.side === pos.side && Math.abs(op.size - pos.sizeSui) < 1);
              if (match && match.positionId) {
                resolvedId = match.positionId;
                console.log(`[integrity] Force-settled position matched on-chain by side/size: ${match.positionId}`);
              }
            }
          }
        } catch (resolveErr: any) {
          console.log(`[integrity] Position ID resolution failed for force-settled ${pos.id}: ${resolveErr.message}`);
        }

        if (resolvedId) {
          console.log(`[integrity] Resolved on-chain position_id for force-settled ${agent.name}: ${resolvedId}`);
          await storage.updatePosition(pos.id, { onChainPositionId: resolvedId });
        } else {
          console.log(`[integrity] WARNING: Cannot resolve on-chain position_id for force-settled ${agent.name} pos ${pos.id}. Will reopen but close may fail until ID is resolved.`);
        }
      }

      const rewardResult = await voidRewardsForPosition(pos, agent.name, wasForceSettled ? "force-settled position reopened" : "phantom close detected");

      console.log(`[integrity] PHANTOM CLOSE detected for ${agent.name}: position ${pos.id} (${pos.side} ${pos.sizeSui} SUI) closed in DB but no on-chain close TX (closeTxDigest=${pos.closeTxDigest || 'null'}). Reopening for on-chain close.${rewardResult}`);
      await storage.updatePosition(pos.id, {
        status: "open",
        markPrice: pos.entryPrice,
        unrealizedPnl: 0,
        closedAt: null,
        closeTxDigest: null,
        closeReason: null,
      });
      pendingRecoveryCloses.push({ agentId: agent.id, positionId: pos.id });
      console.log(`[integrity] Queued position ${pos.id} for recovery close`);
      agentReopened++;
      totalReopened++;
    }

    if (agentReopened > 0) {
      try {
        const freshPositions = await storage.getPositions(agent.id);
        const closedPositions = freshPositions.filter(p => p.status === "closed");
        const openPositions = freshPositions.filter(p => (p.status === "open" || p.status === "pending_open"));
        console.log(`[integrity] Agent ${agent.name} post-reopen: ${openPositions.length} open, ${closedPositions.length} closed positions`);

        const wins = closedPositions.filter(p => (p.unrealizedPnl || 0) > 0).length;
        const winRate = closedPositions.length > 0 ? wins / closedPositions.length : 0;

        let recalcPnl = 0;
        for (const p of closedPositions) {
          if (p.closeTxDigest) {
            recalcPnl += p.unrealizedPnl || 0;
          }
        }

        let lockedCollateral = 0;
        for (const p of openPositions) {
          lockedCollateral += p.sizeSui / agent.leverage;
        }

        let correctBalance = agent.balance;
        if (agent.walletAddress) {
          try {
            const onChain = await getOnChainBalance(agent.walletAddress);
            correctBalance = onChain.sui + lockedCollateral;
            console.log(`[integrity] Agent ${agent.name} balance calc: onChain=${onChain.sui.toFixed(4)}, locked=${lockedCollateral.toFixed(4)}, total=${correctBalance.toFixed(4)}`);
          } catch (balErr: any) {
            console.log(`[integrity] getOnChainBalance failed for ${agent.name}: ${balErr.message} — using DB balance ${agent.balance.toFixed(4)}`);
          }
        }

        await storage.updateAgent(agent.id, {
          totalPnl: recalcPnl,
          totalTrades: freshPositions.length,
          winRate,
          balance: correctBalance,
        });

        try {
          const allRewards = await storage.getRewards();
          const agentRewards = allRewards.filter((r: any) =>
            r.agentId === agent.id &&
            r.status !== "voided" &&
            !r.escrowTxDigest
          );
          for (const reward of agentRewards) {
            await storage.voidReward(reward.id);
            console.log(`[integrity] Voided non-escrowed reward ${reward.id} (${reward.amount.toFixed(4)} SUI) for ${agent.name} — associated with phantom close`);
          }
        } catch (rewardErr: any) {
          console.error(`[integrity] Error voiding rewards for ${agent.name}: ${rewardErr.message}`);
        }

        console.log(`[integrity] Agent ${agent.name}: reopened ${agentReopened} phantom positions, recalculated balance=${correctBalance.toFixed(4)}, PnL=${recalcPnl.toFixed(4)}, winRate=${winRate.toFixed(2)}`);
      } catch (recalcErr: any) {
        console.error(`[integrity] Recalculation failed for ${agent.name} after reopening ${agentReopened} phantom positions: ${recalcErr.message}`);
      }
    }
  }

  if (totalReopened > 0) {
    console.log(`[integrity] Reopened ${totalReopened} phantom-closed positions for on-chain settlement.`);
  } else {
    console.log("[integrity] No phantom-closed positions found.");
  }
}

async function recoverUnfilledCloseOrders(): Promise<void> {
  const allAgents = await storage.getAgents();
  let totalRecovered = 0;
  const voidedRewardIds = new Set<string>();

  for (const agent of allAgents) {
    if (!agent.walletAddress || !agent.agentWallet) continue;

    const positions = await storage.getPositions(agent.id);
    const closedWithTx = positions.filter(p =>
      p.status === "closed" &&
      p.closeTxDigest &&
      !p.closeTxDigest.startsWith("sim_") &&
      p.closeTxDigest !== "liquidated_onchain" &&
      p.closeTxDigest !== "closed_externally" &&
      p.closeTxDigest !== "closed_external" &&
      p.closeTxDigest !== "settled_onchain" &&
      p.closeTxDigest !== "prior_fill" &&
      p.onChainPositionId
    );

    if (closedWithTx.length === 0) continue;

    let agentRecovered = 0;

    for (const pos of closedWithTx) {
      try {
        const txData = await suiClient.getTransactionBlock({
          digest: pos.closeTxDigest!,
          options: { showEvents: true, showBalanceChanges: true },
        });

        const events = (txData as any).events || [];
        let orderFilled = true;
        for (const evt of events) {
          const parsed = (evt as any).parsedJson;
          if (!parsed) continue;
          const evtType = (evt as any).type || "";
          if (evtType.includes("CreateTradingOrderEvent")) {
            if (parsed.filled === false) {
              orderFilled = false;
            }
          }
        }

        if (orderFilled) continue;

        const balChanges = (txData as any).balanceChanges || [];
        const agentBc = balChanges.filter((c: any) =>
          (c.owner?.AddressOwner || '') === agent.walletAddress
        );
        const netSuiChange = agentBc.reduce((s: number, c: any) => s + parseInt(c.amount || '0'), 0) / 1e9;
        const collateral = pos.sizeSui / agent.leverage;

        const onlyGasCost = netSuiChange < 0 && Math.abs(netSuiChange) < 0.05;

        if (!onlyGasCost) {
          console.log(`[integrity] Position ${pos.id}: close TX shows filled=false but balance change ${netSuiChange.toFixed(4)} suggests collateral returned. Skipping.`);
          continue;
        }

        console.log(`[integrity] Position ${pos.id} (${pos.side} ${pos.sizeSui} SUI, collateral=${collateral.toFixed(4)}): close TX ${pos.closeTxDigest} was NOT filled (reduce-only order pending). Collateral still locked in Typus. Reopening position for re-close.`);

        const allRewards = await storage.getRewards();
        const pendingUnfundedRewards = allRewards.filter((r: any) =>
          r.agentId === agent.id &&
          !r.escrowTxDigest &&
          r.status === "pending" &&
          !voidedRewardIds.has(r.id)
        );
        if (pendingUnfundedRewards.length > 0) {
          console.log(`[integrity] WARNING: Agent ${agent.name} has ${pendingUnfundedRewards.length} pending unfunded rewards that may be invalid due to unfilled close. Manual review recommended. Reward IDs: ${pendingUnfundedRewards.map((r: any) => r.id).join(', ')}`);
        }

        await storage.updatePosition(pos.id, {
          status: "open",
          closedAt: null as any,
          closeTxDigest: null as any,
          unrealizedPnl: 0,
        });

        pendingRecoveryCloses.push({ agentId: agent.id, positionId: pos.id });
        agentRecovered++;
        totalRecovered++;
      } catch (err: any) {
        console.log(`[integrity] Error checking close TX for position ${pos.id}: ${err.message}`);
      }
    }

    if (agentRecovered > 0) {
      let onChainBalance: number;
      try {
        const onChain = await getOnChainBalance(agent.walletAddress);
        onChainBalance = onChain.sui;
      } catch {
        continue;
      }

      const freshPositions = await storage.getPositions(agent.id);
      const nowOpen = freshPositions.filter(p => (p.status === "open" || p.status === "pending_open"));
      const nowClosed = freshPositions.filter(p => p.status === "closed");
      const newLockedCollateral = nowOpen.reduce((sum, p) => sum + p.sizeSui / agent.leverage, 0);
      const newBalance = onChainBalance + newLockedCollateral;
      const newPnl = nowClosed.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
      const wins = nowClosed.filter(p => (p.unrealizedPnl || 0) > 0).length;
      const winRate = nowClosed.length > 0 ? wins / nowClosed.length : 0;

      await storage.updateAgent(agent.id, {
        balance: newBalance,
        totalPnl: newPnl,
        winRate,
      });

      console.log(`[integrity] Agent ${agent.name} balance updated: ${newBalance.toFixed(4)} SUI (on-chain=${onChainBalance.toFixed(4)} + locked=${newLockedCollateral.toFixed(4)}). ${agentRecovered} positions reopened for re-close.`);
    }
  }

  if (totalRecovered > 0) {
    console.log(`[integrity] Recovered ${totalRecovered} positions with unfilled close orders. Positions reopened — agent will re-close them automatically.`);
  } else {
    console.log("[integrity] No unfilled close orders detected.");
  }
}

async function scanOnChainLiquidationEvents(): Promise<void> {
  const allAgents = await storage.getAgents();
  let totalFixed = 0;

  for (const agent of allAgents) {
    if (!agent.walletAddress) continue;
    const positions = await storage.getPositions(agent.id);

    const closedWithSyntheticDigest = positions.filter(p =>
      p.status === "closed" &&
      (p.closeTxDigest === "settled_onchain" ||
       p.closeTxDigest === "liquidated_onchain" ||
       p.closeTxDigest === "closed_externally" ||
       p.closeTxDigest === "closed_external") &&
      p.onChainPositionId
    );

    if (closedWithSyntheticDigest.length === 0) continue;

    try {
      const allTxBlocks: any[] = [];

      for (const direction of ["ToAddress", "FromAddress"] as const) {
        try {
          const txs = await suiClient.queryTransactionBlocks({
            filter: { [direction]: agent.walletAddress } as any,
            options: { showEvents: true, showBalanceChanges: true },
            limit: 50,
            order: "descending" as any,
          });
          if (txs?.data) {
            for (const tx of txs.data) {
              if (!allTxBlocks.some(t => t.digest === tx.digest)) {
                allTxBlocks.push(tx);
              }
            }
          }
        } catch (dirErr: any) {
          console.log(`[integrity] ${direction} query failed for ${agent.name}: ${dirErr.message}`);
        }
      }

      if (allTxBlocks.length === 0) continue;

      for (const pos of closedWithSyntheticDigest) {
        let positionFixed = false;

        let effectivePositionId = pos.onChainPositionId;
        for (const txBlock of allTxBlocks) {
          if (positionFixed) break;
          const events = (txBlock as any).events;
          if (!events) continue;
          for (const evt of events) {
            const parsed = (evt as any).parsedJson;
            if (!parsed) continue;
            if ((evt as any).type?.includes("OrderFilledEvent") && String(parsed.order_id) === pos.onChainPositionId) {
              const newPosId = parsed.new_position_id !== undefined ? String(parsed.new_position_id) : null;
              if (newPosId && newPosId !== pos.onChainPositionId) {
                console.log(`[integrity] FILL EVENT: position ${pos.id} (${agent.name}) order_id=${pos.onChainPositionId} → actual position_id=${newPosId}`);
                effectivePositionId = newPosId;
                await storage.updatePosition(pos.id, { onChainPositionId: newPosId });
              }
            }
          }
        }

        for (const txBlock of allTxBlocks) {
          if (positionFixed) break;
          const events = (txBlock as any).events;
          if (!events) continue;
          for (const evt of events) {
            const parsed = (evt as any).parsedJson;
            if (!parsed) continue;
            if ((evt as any).type?.includes("LiquidateEvent") && String(parsed.position_id) === effectivePositionId) {
              const collateral = pos.sizeSui / agent.leverage;
              const closedAt = txBlock.timestampMs ? new Date(parseInt(txBlock.timestampMs)) : pos.closedAt;
              console.log(`[integrity] ON-CHAIN LIQUIDATION for position ${pos.id} (${agent.name}): position_id=${effectivePositionId}, tx=${txBlock.digest}`);
              await storage.updatePosition(pos.id, {
                closeTxDigest: txBlock.digest,
                closeReason: "liquidated",
                unrealizedPnl: -collateral,
                closedAt,
              });
              totalFixed++;
              positionFixed = true;
              break;
            }
          }
        }
      }
    } catch (err: any) {
      console.log(`[integrity] Error scanning on-chain events for ${agent.name}: ${err.message}`);
    }
  }

  if (totalFixed > 0) {
    console.log(`[integrity] Fixed ${totalFixed} positions with real on-chain liquidation TX digests.`);
  } else {
    console.log("[integrity] No on-chain liquidation events found for synthetic-digest positions.");
  }
}

async function reclassifyMisidentifiedLiquidations(): Promise<void> {
  const allAgents = await storage.getAgents();
  let totalReclassified = 0;
  let totalReverted = 0;

  for (const agent of allAgents) {
    if (!agent.walletAddress) continue;
    const positions = await storage.getPositions(agent.id);

    let onChainBalance: number;
    try {
      const onChain = await getOnChainBalance(agent.walletAddress);
      onChainBalance = onChain.sui;
    } catch (err: any) {
      console.log(`[integrity] Could not get on-chain balance for ${agent.name}: ${err.message} — skipping reclassification checks`);
      continue;
    }

    const openPositions = positions.filter(p => (p.status === "open" || p.status === "pending_open"));
    const lockedCollateral = openPositions.reduce((s, p) => s + p.sizeSui / agent.leverage, 0);

    const deposits = await storage.getDepositsByAgent(agent.id);
    const netDeposited = deposits.reduce((sum: number, d: any) => sum + (d.amount || 0), 0);

    const allRewards = await storage.getRewards();
    const agentRewards = allRewards.filter((r: any) => r.agentId === agent.id && r.status !== "voided");
    const totalRewardsPaid = agentRewards
      .filter((r: any) => r.escrowTxDigest || r.status === "claimed")
      .reduce((sum: number, r: any) => sum + r.amount, 0);

    const impliedTotalPnl = (onChainBalance + lockedCollateral + totalRewardsPaid) - netDeposited;

    const closedPositions = positions.filter(p => p.status === "closed");

    for (const pos of closedPositions) {
      const collateral = pos.sizeSui / agent.leverage;
      const isCurrentlyExternal = pos.closeTxDigest === "closed_externally" || pos.closeTxDigest === "settled_onchain";
      const isCurrentlyLiquidated = pos.closeTxDigest === "liquidated_onchain";

      if (!isCurrentlyExternal && !isCurrentlyLiquidated) continue;
      if (pos.markPrice === null || pos.markPrice === undefined) continue;

      const pricePnl = pos.side === "long"
        ? (pos.markPrice - pos.entryPrice) * pos.sizeSui / pos.markPrice
        : (pos.entryPrice - pos.markPrice) * pos.sizeSui / pos.markPrice;

      const liquidationPnl = -collateral;

      const otherClosedPnl = closedPositions
        .filter(p => p.id !== pos.id)
        .reduce((s, p) => s + (p.unrealizedPnl || 0), 0);

      const totalPnlIfExternal = otherClosedPnl + pricePnl;
      const totalPnlIfLiquidated = otherClosedPnl + liquidationPnl;

      const diffExternal = Math.abs(impliedTotalPnl - totalPnlIfExternal);
      const diffLiquidated = Math.abs(impliedTotalPnl - totalPnlIfLiquidated);
      const notionalSize = pos.sizeSui;
      const typusTradingFeePct = 0.001;
      const estimatedTradingFees = notionalSize * typusTradingFeePct * 2;
      const estimatedFundingFee = collateral * 0.05;
      const gasEstimate = 0.15;
      const totalFeeEstimate = estimatedTradingFees + estimatedFundingFee + gasEstimate;
      const gasTolerance = Math.max(totalFeeEstimate, collateral * 0.3, 1.5);

      const priceMoveForLiqCheck = pos.side === "long"
        ? ((pos.markPrice - pos.entryPrice) / pos.entryPrice) * 100
        : ((pos.entryPrice - pos.markPrice) / pos.entryPrice) * 100;
      const collateralLossPctFromPrice = Math.abs(Math.min(0, priceMoveForLiqCheck)) * agent.leverage;
      const priceSaysLiquidationPossible = collateralLossPctFromPrice >= 80;

      if (isCurrentlyExternal && diffLiquidated < diffExternal && diffLiquidated < gasTolerance && priceSaysLiquidationPossible) {
        console.log(`[integrity] REVERTING position ${pos.id} (${agent.name}): impliedPnl=${impliedTotalPnl.toFixed(4)}, ifExternal=${totalPnlIfExternal.toFixed(4)} (diff=${diffExternal.toFixed(4)}), ifLiquidated=${totalPnlIfLiquidated.toFixed(4)} (diff=${diffLiquidated.toFixed(4)}), tolerance=${gasTolerance.toFixed(4)} (fees=${totalFeeEstimate.toFixed(4)}), priceCollLoss=${collateralLossPctFromPrice.toFixed(1)}% — liquidation matches on-chain`);
        await storage.updatePosition(pos.id, {
          closeTxDigest: "liquidated_onchain",
          unrealizedPnl: liquidationPnl,
          closeReason: "liquidated",
        });
        await storage.updateAgent(agent.id, { totalPnl: impliedTotalPnl });
        console.log(`[integrity] Agent ${agent.name} totalPnl set to on-chain-derived: ${impliedTotalPnl.toFixed(4)}`);
        totalReverted++;
      } else if (isCurrentlyExternal && !priceSaysLiquidationPossible && diffLiquidated < diffExternal) {
        const impliedPnlForPos = impliedTotalPnl - otherClosedPnl;
        const onChainPnl = Math.max(-collateral, impliedPnlForPos);
        const storedPnl = pos.unrealizedPnl || 0;
        if (Math.abs(storedPnl - onChainPnl) > 0.01) {
          console.log(`[integrity] PNL RECONCILE for settled position ${pos.id} (${agent.name}): price says ${pricePnl.toFixed(4)}, on-chain implies ${onChainPnl.toFixed(4)}, stored=${storedPnl.toFixed(4)}. On-chain balance confirms loss. Updating PnL to on-chain truth.`);
          await storage.updatePosition(pos.id, { unrealizedPnl: onChainPnl });
          await storage.updateAgent(agent.id, { totalPnl: impliedTotalPnl });
          totalReclassified++;
        } else {
          console.log(`[integrity] Position ${pos.id} (${agent.name}) settled — PnL matches on-chain (stored=${storedPnl.toFixed(4)}, implied=${onChainPnl.toFixed(4)}). Price moved ${priceMoveForLiqCheck.toFixed(3)}%.`);
        }
      } else if (isCurrentlyExternal && (pos.unrealizedPnl || 0) !== 0) {
        const impliedPnlForPos = impliedTotalPnl - otherClosedPnl;
        const onChainPnl = Math.max(-collateral, impliedPnlForPos);
        const storedPnl = pos.unrealizedPnl || 0;
        if (Math.abs(storedPnl - onChainPnl) > Math.max(0.5, collateral * 0.05)) {
          console.log(`[integrity] PNL RECONCILE (general) for position ${pos.id} (${agent.name}): stored=${storedPnl.toFixed(4)}, on-chain implied=${onChainPnl.toFixed(4)} (diff=${Math.abs(storedPnl - onChainPnl).toFixed(4)}). Correcting to on-chain truth.`);
          await storage.updatePosition(pos.id, { unrealizedPnl: onChainPnl });
          await storage.updateAgent(agent.id, { totalPnl: impliedTotalPnl });
          totalReclassified++;
        }
      } else if (isCurrentlyLiquidated && !priceSaysLiquidationPossible) {
        const impliedPnlForPos = impliedTotalPnl - otherClosedPnl;
        const finalPnl = Math.max(-collateral, impliedPnlForPos);
        console.log(`[integrity] PRICE GUARD RECLASSIFY: position ${pos.id} (${agent.name}) marked as liquidated but price moved only ${priceMoveForLiqCheck.toFixed(3)}% (${collateralLossPctFromPrice.toFixed(1)}% collateral loss at ${agent.leverage}x). Cannot be liquidation. Reclassifying to settled with PnL=${finalPnl.toFixed(4)}`);
        await storage.updatePosition(pos.id, {
          closeTxDigest: "settled_onchain",
          unrealizedPnl: finalPnl,
          closeReason: pos.closeReason === "liquidated" ? "settled_onchain" : pos.closeReason,
        });
        await storage.updateAgent(agent.id, { totalPnl: impliedTotalPnl });
        totalReclassified++;
      } else if (isCurrentlyLiquidated && diffExternal < diffLiquidated && diffExternal < gasTolerance) {
        const impliedPnlForPos = impliedTotalPnl - otherClosedPnl;
        const adjustedPnl = impliedPnlForPos;
        const finalPnl = Math.max(-collateral, adjustedPnl);

        console.log(`[integrity] RECLASSIFYING position ${pos.id} (${agent.name}): impliedPnl=${impliedTotalPnl.toFixed(4)}, ifExternal=${totalPnlIfExternal.toFixed(4)} (diff=${diffExternal.toFixed(4)}), ifLiquidated=${totalPnlIfLiquidated.toFixed(4)} (diff=${diffLiquidated.toFixed(4)}), tolerance=${gasTolerance.toFixed(4)} — using on-chain-derived PnL=${finalPnl.toFixed(4)} (pricePnl=${pricePnl.toFixed(4)})`);

        await storage.updatePosition(pos.id, {
          closeTxDigest: "settled_onchain",
          unrealizedPnl: finalPnl,
        });
        totalReclassified++;

        await storage.updateAgent(agent.id, { totalPnl: impliedTotalPnl });
        console.log(`[integrity] Agent ${agent.name} totalPnl set to on-chain-derived: ${impliedTotalPnl.toFixed(4)}`);

        const rewardSharePct = agent.rewardSharePct ?? 50;
        if (finalPnl > 0 && rewardSharePct > 0) {
          const rewardAmount = finalPnl * (rewardSharePct / 100);
          const hasRewardByPosition = agentRewards.some((r: any) => r.positionId === pos.id);
          const hasRewardByAmount = agentRewards.some((r: any) => Math.abs(r.amount - rewardAmount) < 0.001);
          if (!hasRewardByPosition && !hasRewardByAmount) {
            await storage.createReward({
              agentId: agent.id,
              userId: agent.userId,
              amount: rewardAmount,
              agentName: agent.name,
              positionId: pos.id,
            });
            console.log(`[integrity] Created retroactive reward ${rewardAmount.toFixed(4)} SUI for ${agent.name} pos ${pos.id} (${rewardSharePct}% of ${finalPnl.toFixed(4)} profit)`);
          } else {
            console.log(`[integrity] Skipping duplicate reward for ${agent.name} pos ${pos.id}: byPosition=${hasRewardByPosition}, byAmount=${hasRewardByAmount}`);
          }
        }
      }
    }
  }

  if (totalReclassified > 0) {
    console.log(`[integrity] Reclassified ${totalReclassified} misidentified liquidations as external closes.`);
  }
  if (totalReverted > 0) {
    console.log(`[integrity] Reverted ${totalReverted} incorrect reclassifications back to liquidation (on-chain balance mismatch).`);
  }
  if (totalReclassified === 0 && totalReverted === 0) {
    console.log(`[integrity] No misidentified liquidations or incorrect reclassifications found.`);
  }
}

async function voidRewardsFromLiquidatedPositions(): Promise<void> {
  const allAgents = await storage.getAgents();
  const allRewards = await storage.getRewards();
  let totalVoided = 0;

  for (const agent of allAgents) {
    const positions = await storage.getPositions(agent.id);
    const liquidatedPositions = positions.filter(p =>
      p.status === "closed" &&
      (p.closeTxDigest === "settled_onchain" || p.closeTxDigest === "liquidated_onchain")
    );

    if (liquidatedPositions.length === 0) continue;

    const liquidatedClosedAts = liquidatedPositions
      .filter(p => p.closedAt)
      .map(p => new Date(p.closedAt!).getTime());

    const agentRewards = allRewards.filter(r =>
      r.agentId === agent.id &&
      r.status === "pending" &&
      r.createdAt
    );

    for (const reward of agentRewards) {
      const rewardTime = new Date(reward.createdAt!).getTime();
      const matchesLiquidation = liquidatedClosedAts.some(t => Math.abs(rewardTime - t) < 5000);

      if (matchesLiquidation) {
        await storage.voidReward(reward.id);
        totalVoided++;
        console.log(`[integrity] VOIDED reward ${reward.id} (${reward.amount.toFixed(4)} SUI) for ${agent.name} — generated from liquidated position`);
      }
    }
  }

  if (totalVoided > 0) {
    console.log(`[integrity] Voided ${totalVoided} rewards from liquidated positions.`);
  } else {
    console.log(`[integrity] No invalid rewards from liquidated positions found.`);
  }
}

async function fixCorruptedPositions(): Promise<void> {
  const allAgents = await storage.getAgents();
  const allRewards = await storage.getRewards();
  let totalFixed = 0;
  let totalVoided = 0;
  let totalReset = 0;

  for (const agent of allAgents) {
    const positions = await storage.getPositions(agent.id);
    const closedPositions = positions.filter(p => p.status === "closed");
    const bogusPositions = closedPositions.filter(p => {
      if (p.markPrice === null) return false;
      const deviation = Math.abs(p.markPrice - p.entryPrice) / p.entryPrice;
      return deviation > 0.50;
    });

    if (bogusPositions.length === 0) continue;

    for (const pos of bogusPositions) {
      const collateral = pos.sizeSui / agent.leverage;
      console.log(`[integrity] Fixing corrupted position ${pos.id}: markPrice=$${pos.markPrice?.toFixed(4)} vs entry=$${pos.entryPrice.toFixed(4)} — marking as liquidated loss (-${collateral.toFixed(4)} SUI)`);
      await storage.updatePosition(pos.id, {
        markPrice: pos.entryPrice,
        unrealizedPnl: -collateral,
      });
      totalFixed++;
    }

    const agentRewards = allRewards.filter(r => r.agentId === agent.id);
    for (const reward of agentRewards) {
      if (reward.status === "voided") continue;

      if (reward.amount > 5 && bogusPositions.length > 0) {
        await storage.voidReward(reward.id);
        totalVoided++;
      } else if (reward.status === "claimed" && !reward.txDigest) {
        await storage.resetRewardToPending(reward.id);
        totalReset++;
      } else if (reward.status === "claimed" && reward.txDigest) {
        const verified = await storage.getVerifiedTransactionByDigest(reward.txDigest);
        if (!verified || verified.txType !== "reward_claim") {
          await storage.resetRewardToPending(reward.id);
          totalReset++;
        }
      }
    }

    let recalcPnl = 0;
    let wins = 0;
    const freshPositions = await storage.getPositions(agent.id);
    const freshClosed = freshPositions.filter(p => p.status === "closed");
    for (const pos of freshClosed) {
      const collateral = pos.sizeSui / agent.leverage;
      const cappedPnl = Math.max(-collateral, pos.unrealizedPnl || 0);
      recalcPnl += cappedPnl;
      if (cappedPnl > 0) wins++;
    }

    const totalTrades = freshPositions.length;
    const winRate = freshClosed.length > 0 ? wins / freshClosed.length : 0;

    await storage.updateAgent(agent.id, {
      totalPnl: recalcPnl,
      totalTrades,
      winRate,
    });

    console.log(`[integrity] Agent ${agent.name}: fixed ${bogusPositions.length} positions, voided ${totalVoided} rewards, PnL: ${agent.totalPnl?.toFixed(2)} -> ${recalcPnl.toFixed(2)}`);
  }

  if (totalFixed > 0 || totalVoided > 0 || totalReset > 0) {
    console.log(`[integrity] Fixed ${totalFixed} corrupted positions, voided ${totalVoided} rewards, reset ${totalReset} rewards`);
  } else {
    console.log("[integrity] No corrupted data found.");
  }
}

async function recalculateClosedPositionPnls(): Promise<void> {
  const allAgents = await storage.getAgents();
  let totalFixed = 0;

  for (const agent of allAgents) {
    if (!agent.walletAddress) continue;

    const positions = await storage.getPositions(agent.id);
    const closedPositions = positions.filter(p => p.status === "closed");
    const openPositions = positions.filter(p => (p.status === "open" || p.status === "pending_open"));
    if (closedPositions.length === 0) continue;

    let onChainBalance: number;
    try {
      const onChain = await getOnChainBalance(agent.walletAddress);
      onChainBalance = onChain.sui;
    } catch {
      continue;
    }

    let lockedCollateral = openPositions.reduce((sum, p) => sum + p.sizeSui / agent.leverage, 0);

    const hasUnresolved = openPositions.some(p => !p.onChainPositionId || p.status === "pending_open");
    if (!hasUnresolved) {
      try {
        const adapter = getAdapter(agent.venue || "typus");
        if (adapter) {
          const onChainPos = await adapter.getPositions(agent.walletAddress);
          const openDbIds = new Set(openPositions.map(p => p.onChainPositionId).filter(Boolean));
          for (const ocp of onChainPos) {
            if (!openDbIds.has(ocp.positionId)) {
              lockedCollateral += ocp.collateral || (ocp.size / agent.leverage);
            }
          }
        }
      } catch {}
    }

    const deposits = await storage.getDepositsByAgent(agent.id);
    const netDeposited = deposits.reduce((sum: number, d: any) => sum + (d.amount || 0), 0);

    const allRewards = await storage.getRewards();
    const agentRewards = allRewards.filter((r: any) => r.agentId === agent.id && r.status !== "voided");
    const totalRewardsPaid = agentRewards
      .filter((r: any) => r.escrowTxDigest || r.status === "claimed")
      .reduce((sum: number, r: any) => sum + r.amount, 0);

    const impliedTotalPnl = (onChainBalance + lockedCollateral + totalRewardsPaid) - netDeposited;

    const unverifiedCloses = closedPositions.filter(p => !p.closeTxDigest);

    for (const pos of unverifiedCloses) {
      const collateral = pos.sizeSui / agent.leverage;
      const correctPnl = -collateral;
      const diff = Math.abs((pos.unrealizedPnl || 0) - correctPnl);
      if (diff > 0.01) {
        console.log(`[integrity] Position ${pos.id} (${pos.side} ${pos.sizeSui} SUI): PnL ${(pos.unrealizedPnl || 0).toFixed(4)} -> ${correctPnl.toFixed(4)} (no verified close TX — liquidation assumed)`);
        await storage.updatePosition(pos.id, { unrealizedPnl: correctPnl });
        totalFixed++;
      }
    }

    const verifiedCloses = closedPositions.filter(p => p.closeTxDigest && !["liquidated_onchain", "closed_externally", "closed_external", "prior_fill"].includes(p.closeTxDigest));
    for (const pos of verifiedCloses) {
      const collateral = pos.sizeSui / agent.leverage;
      const storedPnl = pos.unrealizedPnl || 0;

      const exitPrice = pos.markPrice || 0;
      if (exitPrice <= 0 || pos.entryPrice <= 0) continue;

      const closedAt = pos.closedAt ? new Date(pos.closedAt).getTime() : 0;
      const closedRecently = closedAt > 0 && (Date.now() - closedAt < 300_000);
      if (closedRecently) continue;

      const pricePnl = pos.side === "long"
        ? (exitPrice - pos.entryPrice) * pos.sizeSui / exitPrice
        : (pos.entryPrice - exitPrice) * pos.sizeSui / exitPrice;
      const correctPnl = Math.max(-collateral, pricePnl);

      const isSettledOnChain = pos.closeTxDigest === "settled_onchain";

      if (isSettledOnChain && (storedPnl > 0) !== (correctPnl > 0)) {
        console.log(`[integrity] SETTLED_ONCHAIN position ${pos.id} (${pos.side} ${pos.sizeSui} SUI): PnL sign mismatch stored=${storedPnl.toFixed(4)} vs price-based=${correctPnl.toFixed(4)} (entry=${pos.entryPrice}, exit=${exitPrice}). Gas costs likely corrupted PnL — correcting.`);
        await storage.updatePosition(pos.id, { unrealizedPnl: correctPnl });
        totalFixed++;
      } else if (isSettledOnChain && storedPnl <= -collateral * 0.85 && correctPnl > -collateral * 0.5) {
        console.log(`[integrity] SETTLED_ONCHAIN position ${pos.id} (${pos.side} ${pos.sizeSui} SUI): Full loss stored=${storedPnl.toFixed(4)} but price says=${correctPnl.toFixed(4)} — was misclassified as liquidation. Correcting.`);
        await storage.updatePosition(pos.id, { unrealizedPnl: correctPnl });
        totalFixed++;
      } else if (storedPnl < -collateral - 0.01) {
        console.log(`[integrity] Position ${pos.id} (${pos.side} ${pos.sizeSui} SUI): PnL ${storedPnl.toFixed(4)} exceeds collateral ${collateral.toFixed(4)} — correcting to price-based ${correctPnl.toFixed(4)}`);
        await storage.updatePosition(pos.id, { unrealizedPnl: correctPnl });
        totalFixed++;
      } else if ((storedPnl > 0) !== (correctPnl > 0) && Math.abs(storedPnl - correctPnl) > collateral * 0.5) {
        console.log(`[integrity] Position ${pos.id} (${pos.side} ${pos.sizeSui} SUI): PnL sign mismatch stored=${storedPnl.toFixed(4)} vs price-based=${correctPnl.toFixed(4)} (entry=${pos.entryPrice}, exit=${exitPrice}) — correcting`);
        await storage.updatePosition(pos.id, { unrealizedPnl: correctPnl });
        totalFixed++;
      }
    }

    const storedTotalPnl = agent.totalPnl || 0;

    const updatedClosedPositions = await storage.getPositions(agent.id);
    const allClosed = updatedClosedPositions.filter(p => p.status === "closed");
    const updatedPnlSum = allClosed.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
    const wins = allClosed.filter(p => (p.unrealizedPnl || 0) > 0).length;
    const winRate = allClosed.length > 0 ? wins / allClosed.length : 0;

    const onChainTotal = onChainBalance + lockedCollateral;
    const storedBalance = agent.balance || 0;

    if (Math.abs(updatedPnlSum - storedTotalPnl) > 0.01 || Math.abs(onChainTotal - storedBalance) > 0.05) {
      console.log(`[integrity] Agent ${agent.name}: totalPnl corrected ${storedTotalPnl.toFixed(4)} -> ${updatedPnlSum.toFixed(4)} (position-based), balance ${storedBalance.toFixed(4)} -> ${onChainTotal.toFixed(4)} (onChain=${onChainBalance.toFixed(4)}, locked=${lockedCollateral.toFixed(4)})`);

      await storage.updateAgent(agent.id, {
        totalPnl: updatedPnlSum,
        balance: onChainTotal,
        winRate,
      });
      totalFixed++;
    }
  }

  if (totalFixed > 0) {
    console.log(`[integrity] Corrected totalPnl for ${totalFixed} agents using on-chain balance.`);
  } else {
    console.log("[integrity] All agent totalPnl values verified against on-chain balance.");
  }
}

async function recoverOnChainPositionIds(): Promise<void> {
  const allAgents = await storage.getAgents();
  let recovered = 0;
  let corrected = 0;

  for (const agent of allAgents) {
    if (!agent.walletAddress) continue;
    const positions = await storage.getPositions(agent.id);

    const needsRecovery = positions.filter(p => 
      (p.status === "open" || p.status === "pending_open") && 
      p.txDigest && 
      !p.txDigest.startsWith("sim_") &&
      !p.onChainPositionId
    );

    const needsVerification = positions.filter(p =>
      (p.status === "open" || p.status === "pending_open") &&
      p.txDigest &&
      !p.txDigest.startsWith("sim_") &&
      p.onChainPositionId
    );

    const alsoNeedsRecovery = positions.filter(p =>
      (p.status === "open" || p.status === "pending_open") &&
      p.onChainPositionId && p.onChainPositionId.includes("-")
    );
    needsRecovery.push(...alsoNeedsRecovery);

    for (const pos of needsRecovery) {
      try {
        let resolvedId: string | null = null;
        if (pos.txDigest && !pos.txDigest.startsWith("sim_")) {
          resolvedId = await resolvePositionIdFromOpenTx(agent.walletAddress, pos.txDigest);
        }
        if (!resolvedId) {
          const orderId = pos.onChainPositionId || pos.txDigest;
          if (orderId) {
            resolvedId = await TypusAdapter.resolvePositionIdFromOrderId(suiClient as any, agent.walletAddress, orderId);
          }
        }
        if (!resolvedId) {
          const adapter = getAdapter(agent.venue || "typus");
          if (adapter && agent.walletAddress) {
            const openOnChain = await adapter.getPositions(agent.walletAddress);
            const match = openOnChain.find((op: any) => op.side === pos.side && Math.abs(op.size - pos.sizeSui) < 1);
            if (match && match.positionId) {
              resolvedId = match.positionId;
              console.log(`[integrity] Matched position by side/size for ${agent.name}: ${pos.id.slice(0, 8)} → ${resolvedId}`);
            }
          }
        }
        if (resolvedId) {
          await storage.updatePosition(pos.id, { onChainPositionId: resolvedId });
          console.log(`[integrity] Recovered onChainPositionId=${resolvedId} for position ${pos.id} (${agent.name})`);
          recovered++;
        } else {
          console.log(`[integrity] Could not find positionId for position ${pos.id} from tx ${pos.txDigest} (${agent.name})`);
        }
      } catch (err: any) {
        console.log(`[integrity] Failed to recover positionId for ${pos.id}: ${err.message}`);
      }
    }

    for (const pos of needsVerification) {
      try {
        const resolvedId = await resolvePositionIdFromOpenTx(agent.walletAddress, pos.txDigest!);
        if (resolvedId && resolvedId !== pos.onChainPositionId) {
          console.log(`[integrity] POSITION ID CORRECTION for ${agent.name}: stored=${pos.onChainPositionId} (order_id), actual=${resolvedId} (position_id from fill event)`);
          await storage.updatePosition(pos.id, { onChainPositionId: resolvedId });
          corrected++;
        }
      } catch (err: any) {
        console.log(`[integrity] Failed to verify positionId for ${pos.id}: ${err.message}`);
      }
    }
  }

  if (recovered > 0 || corrected > 0) {
    console.log(`[integrity] Position ID recovery: ${recovered} recovered, ${corrected} corrected from fill events.`);
  }
}

async function resolvePositionIdFromOpenTx(walletAddress: string, openTxDigest: string): Promise<string | null> {
  const txData = await suiClient.getTransactionBlock({
    digest: openTxDigest,
    options: { showEvents: true }
  });

  if (!txData.events) return null;

  let orderId: string | undefined;
  let positionIdFromEvents: string | undefined;

  for (const evt of txData.events) {
    const parsed = (evt as any).parsedJson;
    if (!parsed) continue;

    if ((evt as any).type?.includes("CreateTradingOrderEvent")) {
      orderId = parsed.order_id !== undefined ? String(parsed.order_id) : undefined;
      if (parsed.linked_position_id) {
        positionIdFromEvents = String(parsed.linked_position_id);
      }
    }

    if ((evt as any).type?.includes("OrderFilledEvent")) {
      if (parsed.new_position_id !== undefined) {
        return String(parsed.new_position_id);
      }
    }
  }

  if (positionIdFromEvents) return positionIdFromEvents;

  if (orderId) {
    try {
      const queries = [
        suiClient.queryTransactionBlocks({
          filter: { ToAddress: walletAddress },
          options: { showEvents: true },
          limit: 25,
          order: "descending" as any,
        }),
        suiClient.queryTransactionBlocks({
          filter: { FromAddress: walletAddress },
          options: { showEvents: true },
          limit: 15,
          order: "descending" as any,
        }),
      ];

      const results = await Promise.all(queries);

      for (const recentTxs of results) {
        if (!recentTxs?.data) continue;

        for (const txBlock of recentTxs.data) {
          const events = (txBlock as any).events;
          if (!events) continue;

          for (const evt of events) {
            const parsed = (evt as any).parsedJson;
            if (!parsed) continue;
            const evtType = (evt as any).type || "";

            if (evtType.includes("OrderFilledEvent") && String(parsed.order_id) === orderId) {
              if (parsed.new_position_id !== undefined) {
                return String(parsed.new_position_id);
              }
            }

            if ((evtType.includes("FillTradingOrderEvent") || evtType.includes("PositionChangeEvent")) && String(parsed.order_id) === orderId) {
              if (parsed.position_id !== undefined) {
                return String(parsed.position_id);
              }
              if (parsed.new_position_id !== undefined) {
                return String(parsed.new_position_id);
              }
            }
          }
        }
      }
    } catch (err: any) {
      console.log(`[integrity] Fill TX search failed for order_id=${orderId}: ${err.message}`);
    }

    return orderId;
  }

  return null;
}

export async function recalculateAgentBalances(): Promise<void> {
  const allAgents = await storage.getAgents();
  let fixed = 0;

  for (const agent of allAgents) {
    if (!agent.walletAddress) continue;

    try {
      const onChain = await getOnChainBalance(agent.walletAddress);
      const positions = await storage.getPositions(agent.id);
      const openPositions = positions.filter(p => (p.status === "open" || p.status === "pending_open"));

      let lockedCollateral = 0;
      let hasAdapterData = false;
      for (const pos of openPositions) {
        lockedCollateral += pos.collateral || (pos.sizeSui / agent.leverage);
      }

      const hasUnresolvedDbPositions = openPositions.some(p => !p.onChainPositionId || p.status === "pending_open");
      if (!hasUnresolvedDbPositions) {
        try {
          const adapter = getAdapter(agent.venue || "typus");
          if (adapter) {
            const onChainPositions = await adapter.getPositions(agent.walletAddress);
            if (onChainPositions.length > 0 || openPositions.length === 0) {
              hasAdapterData = true;
            }
            const dbPositionIds = new Set(openPositions.map(p => p.onChainPositionId).filter(Boolean));
            for (const ocp of onChainPositions) {
              if (!dbPositionIds.has(ocp.positionId)) {
                const untrackedColl = ocp.collateral || (ocp.size / agent.leverage);
                lockedCollateral += untrackedColl;
                console.log(`[integrity] Agent ${agent.name}: untracked on-chain position ${ocp.positionId} with ${untrackedColl.toFixed(4)} SUI locked — included in balance`);
              }
            }
          }
        } catch {}
      }

      const correctBalance = onChain.sui + lockedCollateral;

      const hasFullData = hasAdapterData || openPositions.length === 0;
      const diff = Math.abs(correctBalance - agent.balance);
      if (hasFullData ? diff > 0.01 : correctBalance > agent.balance + 0.01) {
        await storage.updateAgent(agent.id, { balance: correctBalance });
        console.log(`[integrity] Agent ${agent.name}: balance corrected ${agent.balance.toFixed(4)} -> ${correctBalance.toFixed(4)} SUI (onChain=${onChain.sui.toFixed(4)}, locked=${lockedCollateral.toFixed(4)}, adapterData=${hasAdapterData})`);
        fixed++;
      }

      if ((agent.totalDeposited || 0) > 0) {
        const closedPos = positions.filter(p =>
          p.status === "closed" &&
          p.closeReason !== "deleted_bogus_recovery" &&
          p.closeReason !== "cancelled" &&
          !p.txDigest?.startsWith("recovered_onchain_") &&
          !p.txDigest?.startsWith("recovered_order_")
        );
        const positionBasedPnl = closedPos.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
        const currentPnl = agent.totalPnl || 0;
        const wins = closedPos.filter(p => (p.unrealizedPnl || 0) > 0).length;
        const losses = closedPos.filter(p => (p.unrealizedPnl || 0) < 0).length;
        const totalTrades = wins + losses;
        const winRate = totalTrades > 0 ? wins / totalTrades : 0;

        const needsPnlFix = Math.abs(positionBasedPnl - currentPnl) > 0.5;
        const needsTradeCountFix = totalTrades !== (agent.totalTrades || 0);
        const needsWinRateFix = Math.abs(winRate - (agent.winRate || 0)) > 0.01;

        if (needsPnlFix || needsTradeCountFix || needsWinRateFix) {
          console.log(`[integrity] Agent ${agent.name}: stats corrected — totalPnl ${currentPnl.toFixed(4)} → ${positionBasedPnl.toFixed(4)}, trades ${agent.totalTrades} → ${totalTrades}, winRate ${(agent.winRate || 0).toFixed(2)} → ${winRate.toFixed(2)}`);
          await storage.updateAgent(agent.id, {
            totalPnl: positionBasedPnl,
            totalTrades,
            winRate,
          });
        }

        for (const p of closedPos) {
          const collateral = p.sizeSui / agent.leverage;
          const storedPnl = p.unrealizedPnl || 0;
          if (storedPnl < -collateral - 0.01) {
            const cappedPnl = -collateral;
            console.log(`[integrity] Position ${p.id} PnL exceeds collateral: ${storedPnl.toFixed(4)} -> ${cappedPnl.toFixed(4)} (capped at -collateral ${collateral.toFixed(4)})`);
            await storage.updatePosition(p.id, { unrealizedPnl: cappedPnl });
          }
        }
      }
    } catch (err: any) {
      console.log(`[integrity] Could not recalculate balance for ${agent.name}: ${err.message}`);
    }
  }

  console.log(`[integrity] Recalculated ${fixed} agent balances.`);
}

async function syncAllAgentBalances(): Promise<void> {
  const allAgents = await storage.getAgents();
  let synced = 0;

  for (const agent of allAgents) {
    if (!agent.walletAddress) continue;

    try {
      const onChain = await getOnChainBalance(agent.walletAddress);
      const positions = await storage.getPositions(agent.id);
      const openPositions = positions.filter(p => (p.status === "open" || p.status === "pending_open"));
      let lockedCollateral = 0;
      let hasAdapterData = false;
      for (const pos of openPositions) {
        lockedCollateral += pos.collateral || (pos.sizeSui / agent.leverage);
      }

      if (openPositions.length > 0) {
        try {
          const { getAdapter } = await import("./dex/execution-engine");
          const adapter = getAdapter(agent.venue || "typus");
          if (adapter) {
            const onChainPositions = await adapter.getPositions(agent.walletAddress);
            if (onChainPositions.length > 0 || openPositions.length === 0) {
              hasAdapterData = true;
            }
            const dbPositionIds = new Set(openPositions.map(p => p.onChainPositionId).filter(Boolean));
            for (const ocp of onChainPositions) {
              if (!dbPositionIds.has(ocp.positionId)) {
                lockedCollateral += ocp.collateral || (ocp.size / agent.leverage);
              }
            }
          }
        } catch {}
      } else {
        hasAdapterData = true;
      }

      const effectiveBalance = onChain.sui + lockedCollateral;
      const canCorrectDown = hasAdapterData;
      const diff = Math.abs(effectiveBalance - agent.balance);
      const shouldUpdate = canCorrectDown ? diff > 0.001 : effectiveBalance > agent.balance + 0.001;

      if (shouldUpdate) {
        await storage.updateAgent(agent.id, { balance: effectiveBalance });
        console.log(`[integrity] Agent ${agent.name}: balance synced ${agent.balance.toFixed(4)} -> ${effectiveBalance.toFixed(4)} SUI (onChain=${onChain.sui.toFixed(4)}, locked=${lockedCollateral.toFixed(4)}, adapterData=${hasAdapterData})`);
        synced++;
      }
    } catch (err: any) {
      console.log(`[integrity] Could not sync balance for ${agent.name}: ${err.message}`);
    }
  }

  console.log(`[integrity] Synced ${synced} agent balances with on-chain data.`);
}

let syncInterval: ReturnType<typeof setInterval> | null = null;
let priceFnRef: (() => any) | null = null;

export function setPeriodicSyncPriceFn(fn: () => any): void {
  priceFnRef = fn;
}

export function startPeriodicBalanceSync(broadcastFn: (type: string, data: any) => void): void {
  if (syncInterval) return;

  const doSync = async () => {
    try {
      const allAgents = await storage.getAgents();
      let currentPrice = 0;
      try {
        if (priceFnRef) {
          const tick = priceFnRef();
          currentPrice = tick?.pyth?.price ?? tick?.blended ?? 0;
        }
      } catch {}

      for (const agent of allAgents) {
        if (!agent.walletAddress) continue;
        try {
          const onChain = await getOnChainBalance(agent.walletAddress);
          const positions = await storage.getPositions(agent.id);
          const openPositions = positions.filter(p => (p.status === "open" || p.status === "pending_open"));
          let lockedCollateral = 0;
          let totalUnrealizedPnl = 0;
          let hasAdapterData = false;

          for (const pos of openPositions) {
            const posCollateral = pos.collateral || (pos.sizeSui / agent.leverage);
            lockedCollateral += posCollateral;
            if (currentPrice > 0 && pos.entryPrice && pos.entryPrice > 0) {
              const rawPnl = pos.side === "long"
                ? (currentPrice - pos.entryPrice) * pos.sizeSui / currentPrice
                : (pos.entryPrice - currentPrice) * pos.sizeSui / currentPrice;
              totalUnrealizedPnl += Math.max(-posCollateral, rawPnl);
            }
          }

          if (openPositions.length > 0) {
            try {
              const { getAdapter } = await import("./dex/execution-engine");
              const adapter = getAdapter(agent.venue || "typus");
              if (adapter) {
                const onChainPositions = await adapter.getPositions(agent.walletAddress);
                if (onChainPositions.length > 0 || openPositions.length === 0) {
                  hasAdapterData = true;
                }
                const dbPositionIds = new Set(openPositions.map(p => p.onChainPositionId).filter(Boolean));
                for (const ocp of onChainPositions) {
                  if (!dbPositionIds.has(ocp.positionId)) {
                    const untrackedColl = ocp.collateral || (ocp.size / agent.leverage);
                    lockedCollateral += untrackedColl;
                    if (currentPrice > 0 && ocp.entryPrice > 0) {
                      const rawPnl = ocp.side === "long"
                        ? (currentPrice - ocp.entryPrice) * ocp.size / currentPrice
                        : (ocp.entryPrice - currentPrice) * ocp.size / currentPrice;
                      totalUnrealizedPnl += Math.max(-untrackedColl, rawPnl);
                    }
                  }
                }
                try {
                  const { setOnChainPositionsCache } = await import("./routes");
                  setOnChainPositionsCache(agent.id, onChainPositions.map(ocp => ({
                    positionId: ocp.positionId, side: ocp.side, size: ocp.size,
                    collateral: ocp.collateral || (ocp.size / agent.leverage), entryPrice: ocp.entryPrice || 0,
                  })), lockedCollateral);
                } catch {}
              }
            } catch {}
          } else {
            hasAdapterData = true;
          }

          const correctedBalance = onChain.sui + lockedCollateral;
          const portfolioValue = onChain.sui + lockedCollateral + totalUnrealizedPnl;

          const canCorrectDown = hasAdapterData || openPositions.length === 0;
          const diff = Math.abs(correctedBalance - agent.balance);
          const shouldUpdate = canCorrectDown ? diff > 0.001 : correctedBalance > agent.balance + 0.001;

          if (shouldUpdate) {
            const updated = await storage.updateAgent(agent.id, { balance: correctedBalance });
            if (updated) {
              const { agentWallet, ...safe } = updated;
              broadcastFn("agent:updated", { ...safe, _livePortfolio: portfolioValue, _liveUnrealizedPnl: totalUnrealizedPnl, _onChainSui: onChain.sui, _lockedCollateral: lockedCollateral });
            }
          } else {
            const { agentWallet, ...safe } = agent;
            broadcastFn("agent:balance-tick", { ...safe, _livePortfolio: portfolioValue, _liveUnrealizedPnl: totalUnrealizedPnl, _onChainSui: onChain.sui, _lockedCollateral: lockedCollateral });
          }
        } catch {}
      }
    } catch {}
  };

  setTimeout(doSync, 5000);
  syncInterval = setInterval(doSync, 20 * 1000);
}

async function backfillRewardAgentNames(): Promise<void> {
  try {
    const allRewards = await storage.getRewards();
    const allAgents = await storage.getAgents();
    const agentMap = new Map(allAgents.map(a => [a.id, a.name]));
    let updated = 0;

    for (const reward of allRewards) {
      if (!reward.agentName) {
        const agentName = agentMap.get(reward.agentId);
        if (agentName) {
          await storage.updateReward(reward.id, { agentName });
          updated++;
        }
      }
    }

    if (updated > 0) {
      console.log(`[integrity] Backfilled agent names for ${updated} rewards.`);
    }
  } catch (err: any) {
    console.error(`[integrity] Error backfilling reward agent names: ${err.message}`);
  }
}

async function fixLiquidationPrices(): Promise<void> {
  try {
    const agents = await storage.getAgents();
    let fixed = 0;
    for (const agent of agents) {
      const positions = await storage.getPositions(agent.id);
      const openPositions = positions.filter(p => (p.status === "open" || p.status === "pending_open"));
      const leverage = agent.leverage || 25;
      for (const pos of openPositions) {
        const correctLiq = pos.side === "long"
          ? pos.entryPrice * (1 - 1 / leverage)
          : pos.entryPrice * (1 + 1 / leverage);
        const currentLiq = pos.liquidationPrice || 0;
        const diff = Math.abs(currentLiq - correctLiq);
        if (diff > 0.0001) {
          console.log(`[integrity] Fixing liquidation price for ${agent.name} ${pos.side} @ $${pos.entryPrice.toFixed(4)}: $${currentLiq.toFixed(4)} -> $${correctLiq.toFixed(4)} (${leverage}x)`);
          await storage.updatePosition(pos.id, { liquidationPrice: correctLiq });
          fixed++;
        }
      }
    }
    if (fixed > 0) {
      console.log(`[integrity] Fixed ${fixed} position liquidation prices.`);
    } else {
      console.log(`[integrity] All position liquidation prices are correct.`);
    }
  } catch (err: any) {
    console.error(`[integrity] Error fixing liquidation prices: ${err.message}`);
  }
}

async function detectUntrackedPositions(): Promise<void> {
  try {
    const allAgents = await storage.getAgents();
    const typusAgents = allAgents.filter(a => a.venue === "typus" && a.agentWallet && a.walletAddress);
    let recovered = 0;

    for (const agent of typusAgents) {
      try {
        const positions = await storage.getPositions(agent.id);
        const openPositions = positions.filter(p => (p.status === "open" || p.status === "pending_open"));
        const lockedCollateral = openPositions.reduce((s, p) => s + (p.collateral || p.sizeSui / (agent.leverage || 25)), 0);

        let onChainBalance = 0;
        try {
          const bal = await suiClient.getBalance({ owner: agent.walletAddress!, coinType: "0x2::sui::SUI" });
          onChainBalance = Number(bal.totalBalance) / 1e9;
        } catch { continue; }

        const totalAccountedFor = onChainBalance + lockedCollateral;
        const closedPositions = positions.filter(p => p.status === "closed");
        const realizedPnl = closedPositions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
        const gasCosts = agent.totalDeposited - totalAccountedFor - (agent.protocolFeePaid || 0) - realizedPnl;
        const estimatedGas = Math.max(0.01, (agent.totalTrades || 0) * 0.012);
        const unaccountedGap = gasCosts - estimatedGas;

        if (agent.walletAddress) {
          try {
            const posAdapter = getAdapter("typus");
            if (posAdapter instanceof TypusAdapter && posAdapter.isReady()) {
              const freshPositions = await storage.getPositions(agent.id);
              const allDbPositionIds = new Set(freshPositions.map(p => p.onChainPositionId).filter(Boolean));
              const allDbTxDigests = new Set(freshPositions.map(p => p.txDigest).filter(Boolean));
              const onChainPositions = await posAdapter.getPositions(agent.walletAddress!);

              let verifiedStillOpen: string[] = [];
              try {
                const { TypusAdapter: TA } = await import("./dex/typus-adapter");
                for (const ocp of onChainPositions) {
                  if (!ocp.positionId) continue;
                  const priorFill = await posAdapter.checkPriorCloseFilled(agent.walletAddress!, ocp.positionId);
                  if (!priorFill.filled) {
                    verifiedStillOpen.push(ocp.positionId);
                  }
                }
              } catch {
                verifiedStillOpen = onChainPositions.map(ocp => ocp.positionId).filter(Boolean);
              }

              const openDbPositionIds = new Set(
                freshPositions.filter(p => p.status === "open" || p.status === "pending_open")
                  .map(p => p.onChainPositionId).filter(Boolean)
              );
              const allDbPositionIdsWithData = new Set(
                freshPositions.filter(p => p.onChainPositionId && p.entryPrice > 0)
                  .map(p => p.onChainPositionId)
              );

              for (const ocp of onChainPositions) {
                if (!ocp.positionId) continue;
                if (!verifiedStillOpen.includes(ocp.positionId)) {
                  console.log(`[integrity] Skipping on-chain position ${ocp.positionId} for ${agent.name}: already closed/liquidated on-chain.`);
                  continue;
                }
                if (openDbPositionIds.has(ocp.positionId)) continue;

                const closedDbMatch = freshPositions.find(p =>
                  p.onChainPositionId === ocp.positionId && p.status === "closed" &&
                  p.entryPrice > 0
                );
                if (closedDbMatch) {
                  console.log(`[integrity] Re-opening position ${closedDbMatch.id} for ${agent.name}: DB says closed but verified STILL OPEN on-chain (posId=${ocp.positionId})`);
                  try {
                    const posCollateral = ocp.collateral || (ocp.size / (agent.leverage || 25));
                    const leverage = agent.leverage || 25;
                    const correctLiq = (ocp.side || closedDbMatch.side) === "long"
                      ? (ocp.entryPrice || closedDbMatch.entryPrice) * (1 - 1 / leverage)
                      : (ocp.entryPrice || closedDbMatch.entryPrice) * (1 + 1 / leverage);
                    await storage.updatePosition(closedDbMatch.id, {
                      status: "open",
                      closeReason: null,
                      closeTxDigest: null,
                      closedAt: null,
                      unrealizedPnl: 0,
                      verified: true,
                      entryPrice: ocp.entryPrice || closedDbMatch.entryPrice,
                      sizeSui: ocp.size || closedDbMatch.sizeSui,
                      collateral: posCollateral,
                      liquidationPrice: correctLiq,
                    });
                    if (closedDbMatch.txDigest?.startsWith("recovered_")) {
                      await storage.updatePosition(closedDbMatch.id, {
                        txDigest: `reopened_${ocp.positionId}`,
                      });
                    }
                    recovered++;
                    console.log(`[integrity] Position ${closedDbMatch.id} re-opened for ${agent.name} — now managed by execution engine with SL/TP`);
                  } catch (reopenErr: any) {
                    console.log(`[integrity] Failed to re-open position ${closedDbMatch.id}: ${reopenErr.message}`);
                  }
                  continue;
                }

                if (allDbPositionIdsWithData.has(ocp.positionId)) {
                  console.log(`[integrity] Skipping on-chain position ${ocp.positionId} for ${agent.name}: already tracked in DB with valid entry price.`);
                  continue;
                }
                if (allDbTxDigests.has(`recovered_onchain_${ocp.positionId}`)) continue;
                if (allDbTxDigests.has(`reopened_${ocp.positionId}`)) continue;

                if (ocp.entryPrice && ocp.entryPrice > 0) {
                  const contentMatch = freshPositions.find(p =>
                    (p.status === "open" || p.status === "pending_open") &&
                    p.entryPrice > 0 &&
                    p.side === ocp.side &&
                    Math.abs(p.entryPrice - ocp.entryPrice) < 0.001 &&
                    Math.abs(p.sizeSui - (ocp.size || 0)) < 1
                  );
                  if (contentMatch) {
                    console.log(`[integrity] Skipping on-chain position ${ocp.positionId} for ${agent.name}: content-matches existing open position ${contentMatch.id} (posId=${contentMatch.onChainPositionId}, entry=$${contentMatch.entryPrice.toFixed(4)}, side=${contentMatch.side}, size=${contentMatch.sizeSui})`);
                    if (contentMatch.onChainPositionId !== ocp.positionId) {
                      console.log(`[integrity] Updating on-chain position ID for ${contentMatch.id}: ${contentMatch.onChainPositionId} → ${ocp.positionId}`);
                      await storage.updatePosition(contentMatch.id, { onChainPositionId: ocp.positionId });
                    }
                    continue;
                  }
                }

                const existingBogusRecord = freshPositions.find(p =>
                  p.onChainPositionId === ocp.positionId && (!p.entryPrice || p.entryPrice === 0)
                );

                if (!ocp.entryPrice || ocp.entryPrice === 0) {
                  console.log(`[integrity] Skipping on-chain position ${ocp.positionId} for ${agent.name}: no entry price available — would create bogus record.`);
                } else if (existingBogusRecord) {
                  const posCollateral = ocp.collateral || (ocp.size / (agent.leverage || 25));
                  const leverage = agent.leverage || 25;
                  const correctLiq = ocp.side === "long"
                    ? ocp.entryPrice * (1 - 1 / leverage)
                    : ocp.entryPrice * (1 + 1 / leverage);
                  console.log(`[integrity] Fixing BOGUS DB record ${existingBogusRecord.id} for ${agent.name}: updating with on-chain data (posId=${ocp.positionId}, entry=$${ocp.entryPrice.toFixed(4)}) instead of creating duplicate.`);
                  try {
                    await storage.updatePosition(existingBogusRecord.id, {
                      status: "open",
                      entryPrice: ocp.entryPrice,
                      sizeSui: ocp.size || posCollateral * leverage,
                      collateral: posCollateral,
                      markPrice: ocp.entryPrice,
                      unrealizedPnl: 0,
                      liquidationPrice: correctLiq,
                      verified: true,
                      closeReason: null,
                      closeTxDigest: null,
                      closedAt: null,
                      txDigest: `reopened_${ocp.positionId}`,
                    });
                    console.log(`[integrity] Updated existing record ${existingBogusRecord.id} for ${agent.name} (on-chain: ${ocp.positionId}) — SL/TP active`);
                    recovered++;
                  } catch (updateErr: any) {
                    console.log(`[integrity] Failed to update bogus record ${existingBogusRecord.id}: ${updateErr.message}`);
                  }
                } else {
                  const posCollateral = ocp.collateral || (ocp.size / (agent.leverage || 25));
                  const leverage = agent.leverage || 25;
                  const correctLiq = ocp.side === "long"
                    ? ocp.entryPrice * (1 - 1 / leverage)
                    : ocp.entryPrice * (1 + 1 / leverage);
                  console.log(`[integrity] Found VERIFIED OPEN on-chain position NOT in DB for ${agent.name}: posId=${ocp.positionId}, side=${ocp.side}, size=${ocp.size?.toFixed(2)}, collateral=${posCollateral.toFixed(4)} SUI, entry=$${ocp.entryPrice.toFixed(4)}. Auto-creating as managed position.`);
                  try {
                    const position = await storage.createPosition({
                      agentId: agent.id,
                      symbol: "SUI-USDC",
                      side: ocp.side || "long",
                      sizeSui: ocp.size || posCollateral * (agent.leverage || 25),
                      collateral: posCollateral,
                      entryPrice: ocp.entryPrice,
                      markPrice: ocp.entryPrice,
                      unrealizedPnl: 0,
                      liquidationPrice: correctLiq,
                      txDigest: `reopened_${ocp.positionId}`,
                    });
                    await storage.updatePosition(position.id, { onChainPositionId: ocp.positionId, verified: true });
                    console.log(`[integrity] Created managed position ${position.id} for ${agent.name} (on-chain: ${ocp.positionId}) — SL/TP active`);
                    recovered++;
                    const updatedBalance = onChainBalance + posCollateral;
                    await storage.updateAgent(agent.id, { balance: updatedBalance });
                    console.log(`[integrity] Updated ${agent.name} balance: ${onChainBalance.toFixed(4)} -> ${updatedBalance.toFixed(4)} SUI (added locked collateral)`);
                  } catch (createErr: any) {
                    console.log(`[integrity] Failed to create managed position: ${createErr.message}`);
                  }
                }
              }
            }
          } catch (ocpErr: any) {
            console.log(`[integrity] On-chain position check failed for ${agent.name}: ${ocpErr.message?.slice(0, 80)}`);
          }
        }

        const minCollateral = agent.leverage ? Math.ceil(10 / agent.leverage * 10) / 10 : 0.5;
        if (unaccountedGap >= minCollateral) {
          console.log(`[integrity] Agent ${agent.name}: ${unaccountedGap.toFixed(4)} SUI unaccounted (deposited=${agent.totalDeposited}, on-chain=${onChainBalance.toFixed(4)}, lockedColl=${lockedCollateral.toFixed(4)}, gas~=${estimatedGas.toFixed(4)}). Likely filled order with untracked position.`);

          const adapter = getAdapter("typus");
          if (adapter instanceof TypusAdapter && adapter.isReady()) {
            const { created, unfilled } = await adapter.findAllUnfilledOrderIds(agent.walletAddress!);
            const filledOrders = [...created.entries()].filter(([oid, info]) => !unfilled.includes(oid) && !info.isReduceOnly && info.collateral >= minCollateral);

            const trackedOrders = new Set<string>();
            for (const pos of positions) {
              if (pos.txDigest) {
                const orders = await storage.getOrders(agent.id);
                for (const o of orders) {
                  if (o.txDigest === pos.txDigest) trackedOrders.add(o.id);
                }
              }
            }

            const latestPositions = await storage.getPositions(agent.id);
            const allLatestDbIds = new Set(latestPositions.map(p => p.onChainPositionId).filter(Boolean));
            const allLatestDbDigests = new Set(latestPositions.map(p => p.txDigest).filter(Boolean));
            for (const [orderId, info] of filledOrders) {
              const positionId = await TypusAdapter.resolvePositionIdFromOrderId(suiClient, agent.walletAddress!, orderId);
              if (positionId) {
                if (allLatestDbIds.has(positionId)) continue;
                if (allLatestDbDigests.has(`recovered_order_${orderId}`)) continue;
                if (allLatestDbDigests.has(`reopened_order_${orderId}`)) continue;
                if (allLatestDbDigests.has(`recovered_onchain_${positionId}`)) continue;
                if (allLatestDbDigests.has(`reopened_${positionId}`)) continue;

                let stillOpenOnChain = false;
                try {
                  const priorFill = await adapter.checkPriorCloseFilled(agent.walletAddress!, positionId);
                  stillOpenOnChain = !priorFill.filled;
                } catch {
                  console.log(`[integrity] Could not verify position ${positionId} on-chain status — skipping to be safe.`);
                  continue;
                }
                if (!stillOpenOnChain) {
                  console.log(`[integrity] Skipping recovery for order ${orderId} / position ${positionId}: position is closed on-chain and not tracked in DB.`);
                  continue;
                }
                if (!info.triggerPrice || info.triggerPrice === 0) {
                  console.log(`[integrity] Skipping recovery for order ${orderId} / position ${positionId}: no entry price available — would create bogus record.`);
                  continue;
                }
                const resolvedSide = info.isLong ? "long" : "short";

                const contentDup = latestPositions.find(p =>
                  (p.status === "open" || p.status === "pending_open") &&
                  p.entryPrice > 0 &&
                  p.side === resolvedSide &&
                  Math.abs(p.entryPrice - info.triggerPrice) < 0.001 &&
                  Math.abs(p.sizeSui - info.collateral * (agent.leverage || 25)) < 1
                );
                if (contentDup) {
                  console.log(`[integrity] Skipping recovery for order ${orderId} / position ${positionId}: content-matches existing ${contentDup.id} (posId=${contentDup.onChainPositionId})`);
                  if (contentDup.onChainPositionId !== positionId) {
                    await storage.updatePosition(contentDup.id, { onChainPositionId: positionId });
                    console.log(`[integrity] Updated on-chain position ID for ${contentDup.id}: ${contentDup.onChainPositionId} → ${positionId}`);
                  }
                  continue;
                }

                const leverage = agent.leverage || 25;
                const correctLiq = resolvedSide === "long"
                  ? info.triggerPrice * (1 - 1 / leverage)
                  : info.triggerPrice * (1 + 1 / leverage);
                console.log(`[integrity] Found UNTRACKED position for ${agent.name}: order_id=${orderId}, position_id=${positionId}, side=${resolvedSide}, collateral=${info.collateral.toFixed(4)} SUI, entry=$${info.triggerPrice.toFixed(4)}. Creating managed DB record.`);
                try {
                  const position = await storage.createPosition({
                    agentId: agent.id,
                    symbol: "SUI-USDC",
                    side: resolvedSide,
                    sizeSui: info.collateral * (agent.leverage || 25),
                    collateral: info.collateral,
                    entryPrice: info.triggerPrice,
                    markPrice: info.triggerPrice,
                    unrealizedPnl: 0,
                    liquidationPrice: correctLiq,
                    txDigest: `reopened_order_${orderId}`,
                  });
                  await storage.updatePosition(position.id, { onChainPositionId: positionId, verified: true });
                  console.log(`[integrity] Created managed position ${position.id} for ${agent.name} (on-chain: ${positionId}) — SL/TP active`);
                  recovered++;
                } catch (err: any) {
                  console.log(`[integrity] Failed to create untracked position: ${err.message}`);
                }
              }
            }
          }
        }
      } catch (err: any) {
        console.log(`[integrity] Untracked position detection failed for ${agent.name}: ${err.message}`);
      }
    }

    if (recovered > 0) {
      console.log(`[integrity] Recovered ${recovered} untracked positions.`);
    } else {
      console.log(`[integrity] No untracked positions detected.`);
    }
  } catch (err: any) {
    console.error(`[integrity] Error in untracked position detection: ${err.message}`);
  }
}

async function recoverOrphanedTypusOrders(): Promise<void> {
  try {
    const adapter = getAdapter("typus");
    if (!adapter || !(adapter instanceof TypusAdapter) || !adapter.isReady()) {
      console.log("[integrity] Typus adapter not ready — skipping orphan order recovery.");
      return;
    }

    const allAgents = await storage.getAgents();
    const typusAgents = allAgents.filter(a => a.venue === "typus" && a.agentWallet);

    let totalRecovered = 0;
    for (const agent of typusAgents) {
      try {
        const result = await adapter.scanAndRecoverOrphanedOrders(agent.agentWallet!, agent.id);
        if (result.cancelled > 0 || result.filled > 0) {
          console.log(`[integrity] Agent ${agent.name}: recovered ${result.cancelled} orphaned orders (${result.recovered} with collateral), ${result.filled} filled by keeper`);
          totalRecovered += result.cancelled;
        }
      } catch (err: any) {
        console.log(`[integrity] Orphan recovery failed for ${agent.name}: ${err.message}`);
      }
    }

    if (totalRecovered > 0) {
      console.log(`[integrity] Recovered ${totalRecovered} total orphaned orders across ${typusAgents.length} agents.`);
    } else {
      console.log(`[integrity] No orphaned Typus orders found.`);
    }
  } catch (err: any) {
    console.error(`[integrity] Error in orphan order recovery: ${err.message}`);
  }
}

async function voidDuplicatePendingRewards(): Promise<void> {
  try {
    const allRewards = await storage.getRewards();
    const activeRewards = allRewards.filter(r => r.status === "pending" || r.status === "escrowed");
    const allAgents = await storage.getAgents();

    const rewardsByPosition = new Map<string, typeof activeRewards>();
    for (const r of activeRewards) {
      if (!r.positionId) continue;
      const existing = rewardsByPosition.get(r.positionId) || [];
      existing.push(r);
      rewardsByPosition.set(r.positionId, existing);
    }

    let totalVoided = 0;

    for (const [positionId, posRewards] of rewardsByPosition.entries()) {
      if (posRewards.length <= 1) continue;

      const agentId = posRewards[0].agentId;
      const agentPositions = await storage.getPositions(agentId);
      const position = agentPositions.find(p => p.id === positionId);
      const agentName = allAgents.find(a => a.id === agentId)?.name || agentId;

      if (position && position.status === "open") {
        console.log(`[integrity] Position ${positionId} for ${agentName} is OPEN — voiding ALL ${posRewards.length} rewards (rewards only valid for closed positions)`);
        for (const r of posRewards) {
          await storage.voidReward(r.id);
          totalVoided++;
        }
      } else {
        const sorted = [...posRewards].sort((a, b) => (new Date(b.createdAt || 0).getTime()) - (new Date(a.createdAt || 0).getTime()));
        const toVoid = sorted.slice(1);
        console.log(`[integrity] Position ${positionId} for ${agentName} has ${posRewards.length} rewards (pending+escrowed) — keeping latest (${sorted[0].amount.toFixed(4)} SUI), voiding ${toVoid.length} duplicates`);
        for (const r of toVoid) {
          await storage.voidReward(r.id);
          totalVoided++;
        }
      }
    }

    if (totalVoided > 0) {
      console.log(`[integrity] Voided ${totalVoided} bogus/duplicate rewards (pending+escrowed).`);
    } else {
      console.log(`[integrity] No duplicate rewards found.`);
    }
  } catch (err: any) {
    console.error(`[integrity] Error in voidDuplicatePendingRewards: ${err.message}`);
  }
}
