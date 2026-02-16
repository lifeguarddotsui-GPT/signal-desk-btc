import { storage } from "./storage";
import { getOnChainBalance } from "./sui-verify";

export async function runStartupIntegrityChecks(): Promise<void> {
  console.log("[integrity] Running startup data integrity checks...");

  try {
    await fixCorruptedPositions();
    await syncAllAgentBalances();
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
    const bogusPositions = closedPositions.filter(p => p.markPrice !== null && p.markPrice > 1.5);

    if (bogusPositions.length === 0) continue;

    for (const pos of bogusPositions) {
      await storage.updatePosition(pos.id, {
        markPrice: pos.entryPrice,
        unrealizedPnl: 0,
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

async function syncAllAgentBalances(): Promise<void> {
  const allAgents = await storage.getAgents();
  let synced = 0;

  for (const agent of allAgents) {
    if (!agent.walletAddress) continue;

    try {
      const onChain = await getOnChainBalance(agent.walletAddress);
      const diff = Math.abs(onChain.sui - agent.balance);
      if (diff > 0.001) {
        await storage.updateAgent(agent.id, { balance: onChain.sui });
        console.log(`[integrity] Agent ${agent.name}: balance synced ${agent.balance.toFixed(4)} -> ${onChain.sui.toFixed(4)} SUI`);
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
          const diff = Math.abs(onChain.sui - agent.balance);
          if (diff > 0.001) {
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
