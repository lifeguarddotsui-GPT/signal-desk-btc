import { storage } from "./storage";
import { getOnChainBalance } from "./sui-verify";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

const suiClient = new SuiJsonRpcClient({ url: "https://fullnode.mainnet.sui.io:443", network: "mainnet" });

export async function runStartupIntegrityChecks(): Promise<void> {
  console.log("[integrity] Running startup data integrity checks...");

  try {
    await reopenPhantomClosedPositions();
    await fixCorruptedPositions();
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
    const phantomCloses = positions.filter(p =>
      p.status === "closed" &&
      !p.closeTxDigest &&
      p.txDigest &&
      !p.txDigest.startsWith("sim_") &&
      p.onChainPositionId
    );

    if (phantomCloses.length === 0) continue;

    for (const pos of phantomCloses) {
      console.log(`[integrity] PHANTOM CLOSE detected for ${agent.name}: position ${pos.id} (${pos.side} ${pos.sizeSui} SUI) closed in DB but no on-chain close TX. Reopening for on-chain close.`);
      await storage.updatePosition(pos.id, {
        status: "open",
        markPrice: pos.entryPrice,
        unrealizedPnl: 0,
        closedAt: null,
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

    const storedTotalPnl = agent.totalPnl || 0;

    if (Math.abs(impliedTotalPnl - storedTotalPnl) > 0.01) {
      const updatedClosedPositions = await storage.getPositions(agent.id);
      const allClosed = updatedClosedPositions.filter(p => p.status === "closed");
      const wins = allClosed.filter(p => (p.unrealizedPnl || 0) > 0).length;
      const winRate = allClosed.length > 0 ? wins / allClosed.length : 0;

      console.log(`[integrity] Agent ${agent.name}: totalPnl corrected ${storedTotalPnl.toFixed(4)} -> ${impliedTotalPnl.toFixed(4)} (onChain=${onChainBalance.toFixed(4)}, locked=${lockedCollateral.toFixed(4)}, deposits=${netDeposited.toFixed(4)}, rewards=${totalRewardsPaid.toFixed(4)})`);

      await storage.updateAgent(agent.id, {
        totalPnl: impliedTotalPnl,
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

  for (const agent of allAgents) {
    const positions = await storage.getPositions(agent.id);
    const needsRecovery = positions.filter(p => 
      p.status === "open" && 
      p.txDigest && 
      !p.txDigest.startsWith("sim_") &&
      !p.onChainPositionId
    );

    if (needsRecovery.length === 0) continue;

    for (const pos of needsRecovery) {
      try {
        const txData = await suiClient.getTransactionBlock({
          digest: pos.txDigest!,
          options: { showEvents: true }
        });

        if (!txData.events) continue;

        let positionId: string | undefined;
        for (const evt of txData.events) {
          const parsed = (evt as any).parsedJson;
          if (!parsed) continue;

          if ((evt as any).type?.includes("CreateTradingOrderEvent")) {
            if (parsed.linked_position_id) {
              positionId = String(parsed.linked_position_id);
            } else if (parsed.order_id !== undefined) {
              positionId = String(parsed.order_id);
            }
          }

          if ((evt as any).type?.includes("FillTradingOrderEvent") || (evt as any).type?.includes("PositionChangeEvent")) {
            if (parsed.position_id && !positionId) {
              positionId = String(parsed.position_id);
            }
          }
        }

        if (positionId) {
          await storage.updatePosition(pos.id, { onChainPositionId: positionId });
          console.log(`[integrity] Recovered onChainPositionId=${positionId} for position ${pos.id} from tx ${pos.txDigest}`);
          recovered++;
        } else {
          console.log(`[integrity] Could not find positionId in tx ${pos.txDigest} events for position ${pos.id}`);
        }
      } catch (err: any) {
        console.log(`[integrity] Failed to recover positionId for ${pos.id}: ${err.message}`);
      }
    }
  }

  if (recovered > 0) {
    console.log(`[integrity] Recovered ${recovered} on-chain position IDs from transaction data.`);
  }
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
