import { db } from "./db";
import { positions, agents } from "@shared/schema";
import { eq, and, isNotNull, sql } from "drizzle-orm";
import { getOnChainBalance, inspectCloseTxBalanceChanges } from "./sui-verify";

const AUDIT_INTERVAL_MS = 3 * 60 * 1000;
const SYNTHETIC_DIGESTS = new Set([
  "sim_", "settled_onchain", "position_gone_onchain", "liquidated_onchain",
  "keeper_filled", "keeper_filled_tracked", "prior_fill", "cancelled_unfilled",
  "agent_retained", "pending_escrow",
]);
const AUDIT_PNL_THRESHOLD = 0.05;

function isSyntheticDigest(digest: string | null | undefined): boolean {
  if (!digest) return true;
  return SYNTHETIC_DIGESTS.has(digest) || Array.from(SYNTHETIC_DIGESTS).some(s => digest.startsWith(s));
}

export async function runPnlAudit(): Promise<void> {
  try {
    const allAgents = await db.select().from(agents).where(
      sql`${agents.walletAddress} IS NOT NULL`
    );

    for (const agent of allAgents) {
      if (!agent.walletAddress) continue;
      await auditAgent(agent);
    }
  } catch (err: any) {
    console.log(`[PnLAudit] Global audit error: ${err.message?.slice(0, 100)}`);
  }
}

export async function auditAgent(agent: typeof agents.$inferSelect): Promise<void> {
  if (!agent.walletAddress) return;

  try {
    const onChain = await getOnChainBalance(agent.walletAddress);
    await db.update(agents).set({
      lastAuditAt: new Date(),
      auditBalanceSui: onChain.sui,
    }).where(eq(agents.id, agent.id));
  } catch {}

  const closedPositions = await db.select().from(positions).where(
    and(
      eq(positions.agentId, agent.id),
      eq(positions.status, "closed"),
      isNotNull(positions.closeTxDigest)
    )
  ).limit(30);

  for (const pos of closedPositions) {
    if (isSyntheticDigest(pos.closeTxDigest)) continue;
    if (pos.pnlSource === "onchain_verified" || pos.pnlSource === "keeper_verified") continue;
    if (!agent.walletAddress) continue;

    try {
      const inspection = await inspectCloseTxBalanceChanges(pos.closeTxDigest!, agent.walletAddress);
      if (inspection.returned <= 0) continue;

      const leverage = (agent as any).leverage || 10;
      const collateral = pos.collateral || (pos.sizeSui / leverage);
      const actualPnl = inspection.returned - collateral;
      const storedPnl = pos.unrealizedPnl || 0;

      if (Math.abs(actualPnl - storedPnl) > AUDIT_PNL_THRESHOLD) {
        console.log(`[PnLAudit] Correcting ${agent.name} pos ${pos.id.slice(0, 8)}: stored=${storedPnl.toFixed(4)} → actual=${actualPnl.toFixed(4)} SUI (returned=${inspection.returned.toFixed(4)}, collateral=${collateral.toFixed(4)})`);
        await db.update(positions).set({
          unrealizedPnl: actualPnl,
          returnedSui: inspection.returned,
          pnlSource: "onchain_verified",
        }).where(eq(positions.id, pos.id));
      } else {
        await db.update(positions).set({
          returnedSui: inspection.returned,
          pnlSource: "onchain_verified",
        }).where(eq(positions.id, pos.id));
      }

      await new Promise(r => setTimeout(r, 200));
    } catch {}
  }
}

export function startPnlAuditLoop(): void {
  console.log(`[PnLAudit] Started — auditing on-chain PnL every ${AUDIT_INTERVAL_MS / 60000} minutes`);

  const run = async () => {
    try {
      await runPnlAudit();
    } catch {}
    setTimeout(run, AUDIT_INTERVAL_MS);
  };

  setTimeout(run, 30_000);
}
