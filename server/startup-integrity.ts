import { storage } from "./storage";
import { getOnChainBalance } from "./sui-verify";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

const suiClient = new SuiJsonRpcClient({ url: "https://fullnode.mainnet.sui.io:443", network: "mainnet" });

export async function runStartupIntegrityChecks(): Promise<void> {
  console.log("[integrity] Running startup data integrity checks...");

  try {
    await fixCorruptedPositions();
    await recalculateClosedPositionPnls();
    await recoverOnChainPositionIds();
    await recalculateAgentBalances();
    console.log("[integrity] Startup integrity checks completed.");
  } catch (err: any) {
    console.error("[integrity] Startup integrity check error:", err.message);
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
    const positions = await storage.getPositions(agent.id);
    const closedPositions = positions.filter(p => p.status === "closed");
    let agentPnlChanged = false;

    for (const pos of closedPositions) {
      if (!pos.markPrice || pos.markPrice === 0) continue;

      const collateral = pos.sizeSui / agent.leverage;
      const storedPnl = pos.unrealizedPnl || 0;

      const correctPnl = pos.side === "long"
        ? (pos.markPrice - pos.entryPrice) * pos.sizeSui / pos.markPrice
        : (pos.entryPrice - pos.markPrice) * pos.sizeSui / pos.markPrice;
      const cappedPnl = Math.max(-collateral, correctPnl);

      const diff = Math.abs(storedPnl - cappedPnl);
      if (diff > 0.01) {
        console.log(`[integrity] Recalculating PnL for position ${pos.id} (${pos.side}): stored=${storedPnl.toFixed(4)}, correct=${cappedPnl.toFixed(4)} (entry=${pos.entryPrice}, close=${pos.markPrice}, size=${pos.sizeSui})`);
        await storage.updatePosition(pos.id, { unrealizedPnl: cappedPnl });
        totalFixed++;
        agentPnlChanged = true;
      }
    }

    if (agentPnlChanged) {
      const freshPositions = await storage.getPositions(agent.id);
      const freshClosed = freshPositions.filter(p => p.status === "closed");
      let recalcPnl = 0;
      let wins = 0;
      for (const pos of freshClosed) {
        const pnl = pos.unrealizedPnl || 0;
        recalcPnl += pnl;
        if (pnl > 0) wins++;
      }
      const winRate = freshClosed.length > 0 ? wins / freshClosed.length : 0;

      console.log(`[integrity] Agent ${agent.name}: totalPnl corrected ${(agent.totalPnl || 0).toFixed(4)} -> ${recalcPnl.toFixed(4)}, winRate=${(winRate * 100).toFixed(0)}%`);
      await storage.updateAgent(agent.id, {
        totalPnl: recalcPnl,
        winRate,
      });
    }
  }

  if (totalFixed > 0) {
    console.log(`[integrity] Recalculated PnL for ${totalFixed} closed positions.`);
  } else {
    console.log("[integrity] All closed position PnLs are correct.");
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
      const deposits = await storage.getDepositsByAgent(agent.id);
      const verifiedDeposits = deposits.filter((d: any) => d.verified || d.txDigest);
      const totalDeposited = verifiedDeposits.reduce((sum: number, d: any) => sum + d.amount, 0);

      const positions = await storage.getPositions(agent.id);
      const closedPositions = positions.filter(p => p.status === "closed" && p.txDigest && !p.txDigest.startsWith("sim_"));
      const openPositions = positions.filter(p => p.status === "open");

      let lockedCollateral = 0;
      for (const pos of openPositions) {
        lockedCollateral += pos.sizeSui / agent.leverage;
      }

      let totalClosedPnl = 0;
      let totalClosedCollateral = 0;
      for (const pos of closedPositions) {
        const collateral = pos.sizeSui / agent.leverage;
        const pnl = Math.max(-(collateral), pos.unrealizedPnl || 0);
        totalClosedPnl += pnl;
        totalClosedCollateral += collateral;
      }

      const allRewards = await storage.getRewards();
      const agentRewards = allRewards.filter((r: any) => r.agentId === agent.id);
      const totalRewardsSet = agentRewards
        .filter((r: any) => r.status !== "voided")
        .reduce((sum: number, r: any) => sum + r.amount, 0);

      const onChain = await getOnChainBalance(agent.walletAddress);

      const expectedBalance = totalDeposited + totalClosedPnl - lockedCollateral - totalRewardsSet;
      const walletPlusLocked = onChain.sui + lockedCollateral;

      const calculatedBalance = Math.min(expectedBalance, walletPlusLocked);
      const finalBalance = Math.max(0, calculatedBalance);

      const diff = Math.abs(finalBalance - agent.balance);
      if (diff > 0.01) {
        await storage.updateAgent(agent.id, { balance: finalBalance });
        console.log(`[integrity] Agent ${agent.name}: balance recalculated ${agent.balance.toFixed(4)} -> ${finalBalance.toFixed(4)} SUI (deposited=${totalDeposited.toFixed(2)}, pnl=${totalClosedPnl.toFixed(4)}, locked=${lockedCollateral.toFixed(4)}, rewards=${totalRewardsSet.toFixed(4)}, onChain=${onChain.sui.toFixed(4)})`);
        fixed++;
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
      const openPositions = await storage.getOpenPositions(agent.id);
      let lockedCollateral = 0;
      for (const pos of openPositions) {
        lockedCollateral += pos.sizeSui / agent.leverage;
      }

      const effectiveBalance = onChain.sui + lockedCollateral;
      const diff = Math.abs(effectiveBalance - agent.balance);
      if (diff > 0.01 && lockedCollateral === 0) {
        await storage.updateAgent(agent.id, { balance: effectiveBalance });
        console.log(`[integrity] Agent ${agent.name}: balance synced ${agent.balance.toFixed(4)} -> ${effectiveBalance.toFixed(4)} SUI (onChain=${onChain.sui.toFixed(4)}, locked=${lockedCollateral.toFixed(4)})`);
        synced++;
      } else if (diff > 0.01) {
        console.log(`[integrity] Agent ${agent.name}: balance drift detected (db=${agent.balance.toFixed(4)}, onChain=${onChain.sui.toFixed(4)}, locked=${lockedCollateral.toFixed(4)}, effective=${effectiveBalance.toFixed(4)}) — skipping sync while positions are open`);
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
          const openPositions = await storage.getOpenPositions(agent.id);
          let lockedCollateral = 0;
          for (const pos of openPositions) {
            lockedCollateral += pos.sizeSui / agent.leverage;
          }

          if (lockedCollateral > 0) continue;

          const diff = Math.abs(onChain.sui - agent.balance);
          if (diff > 0.01) {
            const updated = await storage.updateAgent(agent.id, { balance: onChain.sui });
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
