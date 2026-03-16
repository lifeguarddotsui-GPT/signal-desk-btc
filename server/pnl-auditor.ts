import { db } from "./db";
import { positions, agents } from "@shared/schema";
import { eq, and, isNotNull, sql, or } from "drizzle-orm";
import { getOnChainBalance, inspectCloseTxBalanceChanges } from "./sui-verify";
import { getThrottledSuiClient } from "./rpc-throttle";

const suiClient = getThrottledSuiClient();

const AUDIT_INTERVAL_MS = 3 * 60 * 1000;
const SYNTHETIC_DIGESTS = new Set([
  "sim_", "settled_onchain", "position_gone_onchain", "liquidated_onchain",
  "keeper_filled", "keeper_filled_tracked", "prior_fill", "cancelled_unfilled",
  "agent_retained", "pending_escrow",
]);
const AUDIT_PNL_THRESHOLD = 0.05;

const TYPUS_PACKAGE = "0xa0eba10b173538c8fecca1dff298e488402cc9ff";
const CLOSE_EVENTS = [
  `${TYPUS_PACKAGE}::position::ClosePositionEvent`,
  `${TYPUS_PACKAGE}::position::RemovePositionEvent`,
  `${TYPUS_PACKAGE}::position::DecreasePositionEvent`,
];

function isSyntheticDigest(digest: string | null | undefined): boolean {
  if (!digest) return true;
  return SYNTHETIC_DIGESTS.has(digest) || Array.from(SYNTHETIC_DIGESTS).some(s => digest.startsWith(s));
}

function isRealDigest(digest: string | null | undefined): boolean {
  if (!digest) return false;
  return !isSyntheticDigest(digest);
}

async function findKeeperTxForPosition(
  walletAddress: string,
  onChainPositionId: string | null | undefined,
  closedAt: Date | null | undefined,
  collateral: number
): Promise<{ digest: string; returned: number } | null> {
  if (!walletAddress || !closedAt) return null;

  const closeTimeMs = new Date(closedAt).getTime();
  const windowStart = closeTimeMs - 5 * 60 * 1000;
  const windowEnd = closeTimeMs + 5 * 60 * 1000;

  try {
    const txs = await suiClient.queryTransactionBlocks({
      filter: { ToAddress: walletAddress },
      options: {
        showEffects: true,
        showEvents: true,
        showBalanceChanges: true,
      },
      limit: 20,
      order: "descending",
    });

    if (!txs?.data?.length) return null;

    const normalizeAddr = (a: string) => a.toLowerCase();

    for (const tx of txs.data) {
      const tsMs = tx.timestampMs ? Number(tx.timestampMs) : 0;
      if (tsMs && (tsMs < windowStart || tsMs > windowEnd)) continue;

      const balanceChanges = tx.balanceChanges || [];
      let returnedSui = 0;
      for (const bc of balanceChanges) {
        const isSui = bc.coinType === "0x2::sui::SUI" || bc.coinType === "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
        const owner = (bc.owner as any)?.AddressOwner || "";
        if (isSui && normalizeAddr(owner) === normalizeAddr(walletAddress)) {
          const amt = Number(bc.amount) / 1e9;
          if (amt > 0) returnedSui += amt;
        }
      }

      if (returnedSui <= 0) continue;

      if (onChainPositionId) {
        const events = tx.events || [];
        const matched = events.some((ev: any) => {
          if (!CLOSE_EVENTS.some(ce => ev.type?.startsWith(ce.split("::").slice(0, 2).join("::")))) return false;
          const parsedData = ev.parsedJson || {};
          return parsedData.position_id === onChainPositionId ||
            parsedData.positionId === onChainPositionId ||
            parsedData.order_id === onChainPositionId;
        });
        if (matched) {
          console.log(`[PnLAudit] Found keeper TX for position ${onChainPositionId}: digest=${tx.digest} returned=${returnedSui.toFixed(4)} SUI`);
          return { digest: tx.digest, returned: returnedSui };
        }
      }

      const collateralTolerance = Math.max(collateral * 0.15, 0.1);
      if (Math.abs(returnedSui - collateral) < collateralTolerance) {
        console.log(`[PnLAudit] Found likely keeper TX by collateral match: digest=${tx.digest} returned=${returnedSui.toFixed(4)} SUI collateral=${collateral.toFixed(4)} SUI`);
        return { digest: tx.digest, returned: returnedSui };
      }
    }

    if (onChainPositionId) {
      for (const eventType of CLOSE_EVENTS) {
        try {
          const eventQuery = await suiClient.queryTransactionBlocks({
            filter: {
              MoveFunction: {
                package: TYPUS_PACKAGE,
                module: "position",
                function: "close_position",
              },
            },
            options: { showEffects: true, showEvents: true, showBalanceChanges: true },
            limit: 10,
            order: "descending",
          });

          for (const tx of (eventQuery?.data || [])) {
            const tsMs = tx.timestampMs ? Number(tx.timestampMs) : 0;
            if (tsMs && (tsMs < windowStart || tsMs > windowEnd)) continue;

            const events = tx.events || [];
            const matched = events.some((ev: any) => {
              const parsedData = ev.parsedJson || {};
              return parsedData.position_id === onChainPositionId ||
                parsedData.positionId === onChainPositionId;
            });

            if (matched) {
              const balanceChanges = tx.balanceChanges || [];
              let returnedSui = 0;
              for (const bc of balanceChanges) {
                const isSui = bc.coinType === "0x2::sui::SUI" || bc.coinType === "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
                const owner = (bc.owner as any)?.AddressOwner || "";
                if (isSui && normalizeAddr(owner) === normalizeAddr(walletAddress)) {
                  const amt = Number(bc.amount) / 1e9;
                  if (amt > 0) returnedSui += amt;
                }
              }
              if (returnedSui > 0) {
                console.log(`[PnLAudit] Found keeper TX via event scan for position ${onChainPositionId}: digest=${tx.digest} returned=${returnedSui.toFixed(4)} SUI`);
                return { digest: tx.digest, returned: returnedSui };
              }
            }
          }
          break;
        } catch { }
      }
    }

    return null;
  } catch (err: any) {
    if (err?.message?.includes("429") || err?.message?.includes("Too Many Requests")) {
      console.log(`[PnLAudit] Rate limited during keeper TX scan for ${walletAddress.slice(0, 10)}`);
    }
    return null;
  }
}

export async function runPnlAudit(): Promise<void> {
  try {
    const allAgents = await db.select().from(agents).where(
      sql`${agents.walletAddress} IS NOT NULL`
    );

    for (const agent of allAgents) {
      if (!agent.walletAddress) continue;
      await auditAgent(agent);
      await new Promise(r => setTimeout(r, 500));
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
    if (pos.pnlSource === "onchain_verified" || pos.pnlSource === "keeper_verified") continue;
    if (!agent.walletAddress) continue;

    const leverage = (agent as any).leverage || 10;
    const collateral = pos.collateral || (pos.sizeSui / leverage);

    if (isRealDigest(pos.closeTxDigest)) {
      try {
        const inspection = await inspectCloseTxBalanceChanges(pos.closeTxDigest!, agent.walletAddress);
        if (inspection.returned <= 0) {
          await new Promise(r => setTimeout(r, 300));
          continue;
        }

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

        await new Promise(r => setTimeout(r, 300));
      } catch (err: any) {
        if (err?.message?.includes("429")) {
          console.log(`[PnLAudit] Rate limited verifying TX for pos ${pos.id.slice(0, 8)} — skipping`);
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    } else if (isSyntheticDigest(pos.closeTxDigest) && pos.closeTxDigest !== "cancelled_unfilled") {
      if (!pos.closedAt) continue;

      try {
        const found = await findKeeperTxForPosition(
          agent.walletAddress,
          pos.onChainPositionId,
          pos.closedAt,
          collateral
        );

        if (found && found.returned > 0) {
          const actualPnl = found.returned - collateral;
          const storedPnl = pos.unrealizedPnl || 0;

          console.log(`[PnLAudit] Synthetic→Keeper verified ${agent.name} pos ${pos.id.slice(0, 8)}: digest=${found.digest} returned=${found.returned.toFixed(4)} SUI pnl=${actualPnl.toFixed(4)} (was ${storedPnl.toFixed(4)})`);

          await db.update(positions).set({
            closeTxDigest: found.digest,
            unrealizedPnl: actualPnl,
            returnedSui: found.returned,
            pnlSource: "keeper_verified",
          }).where(eq(positions.id, pos.id));
        }

        await new Promise(r => setTimeout(r, 500));
      } catch (err: any) {
        if (err?.message?.includes("429")) {
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }
  }

  // Log if position-history PnL sum diverges significantly from agent.totalPnl
  try {
    const allClosed = await db.select().from(positions).where(
      and(eq(positions.agentId, agent.id), eq(positions.status, "closed"))
    );
    const historySum = allClosed.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
    const agentTotalPnl = (agent as any).totalPnl || 0;
    const gap = Math.abs(agentTotalPnl - historySum);
    if (gap > 1) {
      const severity = gap > 2 ? "ELEVATED" : "normal";
      console.log(`[PnLAudit] ${agent.name} agent.totalPnl=${agentTotalPnl.toFixed(4)} vs positionHistory=${historySum.toFixed(4)} gap=${gap.toFixed(4)} SUI [${severity}] — gap is expected (keeper fees, funding, incentives)`);
    }
  } catch {}
}

export function startPnlAuditLoop(): void {
  console.log(`[PnLAudit] Started — auditing on-chain PnL every ${AUDIT_INTERVAL_MS / 60000} minutes`);

  const run = async () => {
    try {
      await runPnlAudit();
    } catch {}
    setTimeout(run, AUDIT_INTERVAL_MS);
  };

  setTimeout(run, 45_000);
}
