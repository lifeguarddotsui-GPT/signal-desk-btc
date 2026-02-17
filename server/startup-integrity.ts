import { storage } from "./storage";
import { getOnChainBalance } from "./sui-verify";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

const suiClient = new SuiJsonRpcClient({ url: "https://fullnode.mainnet.sui.io:443", network: "mainnet" });

export async function runStartupIntegrityChecks(): Promise<void> {
  console.log("[integrity] Running startup data integrity checks...");

  try {
    await reopenPhantomClosedPositions();
    await fixCorruptedPositions();
    await reclassifyMisidentifiedLiquidations();
    await voidRewardsFromLiquidatedPositions();
    await recalculateClosedPositionPnls();
    await recoverOnChainPositionIds();
    await recalculateAgentBalances();
    console.log("[integrity] Startup integrity checks completed.");
  } catch (err: any) {
    console.error("[integrity] Startup integrity check error:", err.message);
  }
}

async function reopenPhantomClosedPositions(): Promise<void> {
  const allAgents = await storage.getAgents();
  let totalReopened = 0;

  for (const agent of allAgents) {
    const positions = await storage.getPositions(agent.id);
    const FAKE_CLOSE_DIGESTS = ["closed_externally", "liquidated_onchain", "closed_external"];
    const phantomCloses = positions.filter(p =>
      p.status === "closed" &&
      (!p.closeTxDigest || FAKE_CLOSE_DIGESTS.includes(p.closeTxDigest)) &&
      p.txDigest &&
      !p.txDigest.startsWith("sim_") &&
      p.onChainPositionId
    );

    if (phantomCloses.length === 0) continue;

    for (const pos of phantomCloses) {
      const hasFakeDigest = pos.closeTxDigest && FAKE_CLOSE_DIGESTS.includes(pos.closeTxDigest);

      if (hasFakeDigest && agent.walletAddress) {
        let confirmedOnChainClose = false;
        try {
          const recentTxs = await suiClient.queryTransactionBlocks({
            filter: { ToAddress: agent.walletAddress },
            options: { showEvents: true },
            limit: 25,
            order: "descending" as any,
          });
          if (recentTxs?.data) {
            for (const txBlock of recentTxs.data) {
              const events = (txBlock as any).events;
              if (!events) continue;
              for (const evt of events) {
                const parsed = (evt as any).parsedJson;
                if (!parsed) continue;
                const evtType = (evt as any).type || "";
                if (
                  (evtType.includes("OrderFilledEvent") || evtType.includes("LiquidateEvent")) &&
                  String(parsed.position_id || parsed.new_position_id) === pos.onChainPositionId
                ) {
                  const isClose = evtType.includes("LiquidateEvent") || parsed.reduce_only === true || parsed.is_reduce_only === true;
                  if (isClose) {
                    confirmedOnChainClose = true;
                    console.log(`[integrity] On-chain close/liquidation event found for ${agent.name} position ${pos.onChainPositionId} in tx ${(txBlock as any).digest} — NOT reopening.`);
                    break;
                  }
                }
              }
              if (confirmedOnChainClose) break;
            }
          }
        } catch (err: any) {
          console.log(`[integrity] On-chain close verification failed for ${agent.name}: ${err.message} — skipping reopen to be safe`);
          continue;
        }

        if (confirmedOnChainClose) continue;
      }

      console.log(`[integrity] PHANTOM CLOSE detected for ${agent.name}: position ${pos.id} (${pos.side} ${pos.sizeSui} SUI) closed in DB but no on-chain close TX (closeTxDigest=${pos.closeTxDigest || 'null'}). Reopening for on-chain close.`);
      await storage.updatePosition(pos.id, {
        status: "open",
        markPrice: pos.entryPrice,
        unrealizedPnl: 0,
        closedAt: null,
        closeTxDigest: null,
      });
      totalReopened++;
    }

    if (phantomCloses.length > 0) {
      const freshPositions = await storage.getPositions(agent.id);
      const closedPositions = freshPositions.filter(p => p.status === "closed");
      const wins = closedPositions.filter(p => (p.unrealizedPnl || 0) > 0).length;
      const winRate = closedPositions.length > 0 ? wins / closedPositions.length : 0;

      let recalcPnl = 0;
      for (const p of closedPositions) {
        if (p.closeTxDigest) {
          recalcPnl += p.unrealizedPnl || 0;
        }
      }

      const openPositions = freshPositions.filter(p => p.status === "open");
      let lockedCollateral = 0;
      for (const p of openPositions) {
        lockedCollateral += p.sizeSui / agent.leverage;
      }

      let correctBalance = agent.balance;
      if (agent.walletAddress) {
        try {
          const onChain = await getOnChainBalance(agent.walletAddress);
          correctBalance = onChain.sui + lockedCollateral;
        } catch {}
      }

      await storage.updateAgent(agent.id, {
        totalPnl: recalcPnl,
        totalTrades: freshPositions.length,
        winRate,
        balance: correctBalance,
      });

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

      console.log(`[integrity] Agent ${agent.name}: reopened ${phantomCloses.length} phantom positions, recalculated balance=${correctBalance.toFixed(4)}, PnL=${recalcPnl.toFixed(4)}, winRate=${winRate.toFixed(2)}`);
    }
  }

  if (totalReopened > 0) {
    console.log(`[integrity] Reopened ${totalReopened} phantom-closed positions for on-chain settlement.`);
  } else {
    console.log("[integrity] No phantom-closed positions found.");
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

    const openPositions = positions.filter(p => p.status === "open");
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
      const isCurrentlyExternal = pos.closeTxDigest === "closed_externally";
      const isCurrentlyLiquidated = pos.closeTxDigest === "settled_onchain" || pos.closeTxDigest === "liquidated_onchain";

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

      if (isCurrentlyExternal && diffLiquidated < diffExternal && diffLiquidated < gasTolerance) {
        console.log(`[integrity] REVERTING position ${pos.id} (${agent.name}): impliedPnl=${impliedTotalPnl.toFixed(4)}, ifExternal=${totalPnlIfExternal.toFixed(4)} (diff=${diffExternal.toFixed(4)}), ifLiquidated=${totalPnlIfLiquidated.toFixed(4)} (diff=${diffLiquidated.toFixed(4)}), tolerance=${gasTolerance.toFixed(4)} (fees=${totalFeeEstimate.toFixed(4)}) — liquidation matches on-chain`);
        await storage.updatePosition(pos.id, {
          closeTxDigest: "liquidated_onchain",
          unrealizedPnl: liquidationPnl,
        });
        totalReverted++;
      } else if (isCurrentlyLiquidated && diffExternal < diffLiquidated && diffExternal < gasTolerance) {
        const impliedPnlForPos = impliedTotalPnl - otherClosedPnl;
        const adjustedPnl = impliedPnlForPos;
        const finalPnl = Math.max(-collateral, adjustedPnl);

        console.log(`[integrity] RECLASSIFYING position ${pos.id} (${agent.name}): impliedPnl=${impliedTotalPnl.toFixed(4)}, ifExternal=${totalPnlIfExternal.toFixed(4)} (diff=${diffExternal.toFixed(4)}), ifLiquidated=${totalPnlIfLiquidated.toFixed(4)} (diff=${diffLiquidated.toFixed(4)}), tolerance=${gasTolerance.toFixed(4)} — using on-chain-derived PnL=${finalPnl.toFixed(4)} (pricePnl=${pricePnl.toFixed(4)})`);

        await storage.updatePosition(pos.id, {
          closeTxDigest: "closed_externally",
          unrealizedPnl: finalPnl,
        });
        totalReclassified++;

        const pnlCorrection = finalPnl - (pos.unrealizedPnl || liquidationPnl);
        const currentTotalPnl = agent.totalPnl || 0;
        const newTotalPnl = currentTotalPnl + pnlCorrection;
        console.log(`[integrity] Agent ${agent.name} totalPnl corrected: ${currentTotalPnl.toFixed(4)} + ${pnlCorrection.toFixed(4)} = ${newTotalPnl.toFixed(4)}`);
        await storage.updateAgent(agent.id, { totalPnl: newTotalPnl });

        const rewardSharePct = agent.rewardSharePct ?? 50;
        if (finalPnl > 0 && rewardSharePct > 0) {
          const rewardAmount = finalPnl * (rewardSharePct / 100);
          const hasReward = agentRewards.some((r: any) => Math.abs(r.amount - rewardAmount) < 0.001);
          if (!hasReward) {
            await storage.createReward({
              agentId: agent.id,
              userId: agent.userId,
              amount: rewardAmount,
            });
            console.log(`[integrity] Created retroactive reward ${rewardAmount.toFixed(4)} SUI for ${agent.name} (${rewardSharePct}% of ${finalPnl.toFixed(4)} profit)`);
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
    const openPositions = positions.filter(p => p.status === "open");
    if (closedPositions.length === 0) continue;

    let onChainBalance: number;
    try {
      const onChain = await getOnChainBalance(agent.walletAddress);
      onChainBalance = onChain.sui;
    } catch {
      continue;
    }

    const lockedCollateral = openPositions.reduce((sum, p) => sum + p.sizeSui / agent.leverage, 0);

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

    const verifiedCloses = closedPositions.filter(p => p.closeTxDigest && !["liquidated_onchain", "closed_externally", "closed_external"].includes(p.closeTxDigest));
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

      if (storedPnl < -collateral - 0.01) {
        console.log(`[integrity] Position ${pos.id} (${pos.side} ${pos.sizeSui} SUI): PnL ${storedPnl.toFixed(4)} exceeds collateral ${collateral.toFixed(4)} — correcting to price-based ${correctPnl.toFixed(4)}`);
        await storage.updatePosition(pos.id, { unrealizedPnl: correctPnl });
        totalFixed++;
      } else if (storedPnl > 0 !== correctPnl > 0 && Math.abs(storedPnl - correctPnl) > collateral * 0.5) {
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

    if (Math.abs(impliedTotalPnl - storedTotalPnl) > 0.01 || Math.abs(onChainTotal - storedBalance) > 0.05) {
      console.log(`[integrity] Agent ${agent.name}: totalPnl corrected ${storedTotalPnl.toFixed(4)} -> ${impliedTotalPnl.toFixed(4)}, balance ${storedBalance.toFixed(4)} -> ${onChainTotal.toFixed(4)} (onChain=${onChainBalance.toFixed(4)}, locked=${lockedCollateral.toFixed(4)}, deposits=${netDeposited.toFixed(4)}, rewards=${totalRewardsPaid.toFixed(4)})`);

      await storage.updateAgent(agent.id, {
        totalPnl: impliedTotalPnl,
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
      p.status === "open" && 
      p.txDigest && 
      !p.txDigest.startsWith("sim_") &&
      !p.onChainPositionId
    );

    const needsVerification = positions.filter(p =>
      p.status === "open" &&
      p.txDigest &&
      !p.txDigest.startsWith("sim_") &&
      p.onChainPositionId
    );

    for (const pos of needsRecovery) {
      try {
        const resolvedId = await resolvePositionIdFromOpenTx(agent.walletAddress, pos.txDigest!);
        if (resolvedId) {
          await storage.updatePosition(pos.id, { onChainPositionId: resolvedId });
          console.log(`[integrity] Recovered onChainPositionId=${resolvedId} for position ${pos.id} from fill event`);
          recovered++;
        } else {
          console.log(`[integrity] Could not find positionId for position ${pos.id} from tx ${pos.txDigest}`);
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
      const openPositions = positions.filter(p => p.status === "open");

      let lockedCollateral = 0;
      for (const pos of openPositions) {
        lockedCollateral += pos.sizeSui / agent.leverage;
      }

      const correctBalance = onChain.sui + lockedCollateral;

      const diff = Math.abs(correctBalance - agent.balance);
      if (diff > 0.01) {
        await storage.updateAgent(agent.id, { balance: correctBalance });
        console.log(`[integrity] Agent ${agent.name}: balance corrected ${agent.balance.toFixed(4)} -> ${correctBalance.toFixed(4)} SUI (onChain=${onChain.sui.toFixed(4)}, locked=${lockedCollateral.toFixed(4)})`);
        fixed++;
      }

      if (openPositions.length === 0 && (agent.totalDeposited || 0) > 0) {
        const netDeposited = (agent.totalDeposited || 0) - (agent.protocolFeePaid || 0);
        const reconciledPnl = correctBalance - netDeposited;
        const currentPnl = agent.totalPnl || 0;
        if (Math.abs(reconciledPnl - currentPnl) > 0.5) {
          console.log(`[integrity] Agent ${agent.name}: totalPnl corrected ${currentPnl.toFixed(4)} -> ${reconciledPnl.toFixed(4)} SUI (balance=${correctBalance.toFixed(4)}, netDeposit=${netDeposited.toFixed(4)})`);
          await storage.updateAgent(agent.id, { totalPnl: reconciledPnl });

          const closedPos = positions.filter(p => p.status === "closed");
          const currentPnlSum = closedPos.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
          if (Math.abs(currentPnlSum - reconciledPnl) > 0.5 && closedPos.length > 0) {
            const adjustment = reconciledPnl - currentPnlSum;
            const perPosAdj = adjustment / closedPos.length;
            for (const p of closedPos) {
              const corrected = (p.unrealizedPnl || 0) + perPosAdj;
              await storage.updatePosition(p.id, { unrealizedPnl: corrected });
              console.log(`[integrity] Position ${p.id} PnL adjusted: ${(p.unrealizedPnl || 0).toFixed(4)} -> ${corrected.toFixed(4)} SUI`);
            }
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
      const openPositions = positions.filter(p => p.status === "open");
      let lockedCollateral = 0;
      for (const pos of openPositions) {
        lockedCollateral += pos.sizeSui / agent.leverage;
      }

      const effectiveBalance = onChain.sui + lockedCollateral;
      const diff = Math.abs(effectiveBalance - agent.balance);
      if (diff > 0.01) {
        await storage.updateAgent(agent.id, { balance: effectiveBalance });
        console.log(`[integrity] Agent ${agent.name}: balance synced ${agent.balance.toFixed(4)} -> ${effectiveBalance.toFixed(4)} SUI (onChain=${onChain.sui.toFixed(4)}, locked=${lockedCollateral.toFixed(4)})`);
        synced++;
      }
    } catch (err: any) {
      console.log(`[integrity] Could not sync balance for ${agent.name}: ${err.message}`);
    }
  }

  console.log(`[integrity] Synced ${synced} agent balances with on-chain data.`);
}

let syncInterval: ReturnType<typeof setInterval> | null = null;

export function startPeriodicBalanceSync(broadcastFn: (type: string, data: any) => void): void {
  if (syncInterval) return;

  syncInterval = setInterval(async () => {
    try {
      const allAgents = await storage.getAgents();
      for (const agent of allAgents) {
        if (!agent.walletAddress) continue;
        try {
          const onChain = await getOnChainBalance(agent.walletAddress);
          const positions = await storage.getPositions(agent.id);
          const openPositions = positions.filter(p => p.status === "open");
          let lockedCollateral = 0;
          for (const pos of openPositions) {
            lockedCollateral += pos.sizeSui / agent.leverage;
          }

          const correctedBalance = onChain.sui + lockedCollateral;
          const diff = Math.abs(correctedBalance - agent.balance);
          if (diff > 0.01) {
            const updated = await storage.updateAgent(agent.id, { balance: correctedBalance });
            if (updated) {
              const { agentWallet, ...safe } = updated;
              broadcastFn("agent:updated", safe);
            }
          }
        } catch {}
      }
    } catch {}
  }, 5 * 60 * 1000);
}
