import { db } from "./db";
import { positions, rewards, transferJobs, deposits } from "@shared/schema";
import { eq, desc, and, or } from "drizzle-orm";

export interface CommEvent {
  id?: string;
  agentId: string;
  ts?: number;
  type:
    | "trade_open"
    | "trade_close"
    | "position_open"
    | "position_pending"
    | "close_order"
    | "keeper_fill"
    | "keeper_liquidation"
    | "reward_escrow"
    | "savings_transfer"
    | "reward_claim"
    | "deposit"
    | "gas_op";
  direction: "outbound" | "inbound" | "internal" | "out" | "in";
  from: string;
  to: string;
  amount?: number;
  pnl?: number;
  side?: string;
  size?: number;
  leverage?: number;
  message: string;
  txDigest?: string;
  positionId?: string;
  status: "confirmed" | "pending" | "failed";
  entryPrice?: number;
  closeReason?: string;
}

const MAX_EVENTS = 100;
const HYDRATION_TTL_MS = 5_000; // re-hydrate from DB every 5s so new events appear promptly
const feed = new Map<string, CommEvent[]>();
const hydratedAt = new Map<string, number>(); // agentId → unix ms of last hydration
let _broadcast: ((type: string, data: any) => void) | null = null;

export function setCommsBroadcast(fn: (type: string, data: any) => void) {
  _broadcast = fn;
}

export function pushCommEvent(event: CommEvent) {
  const { agentId } = event;
  if (!feed.has(agentId)) feed.set(agentId, []);
  const list = feed.get(agentId)!;

  const normalized: CommEvent = {
    ...event,
    id: event.id ?? `${event.type}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    ts: event.ts ?? Date.now(),
  };

  if (normalized.txDigest && normalized.txDigest.length > 10) {
    if (list.some(e => e.txDigest === normalized.txDigest && e.type === normalized.type)) return;
  }
  if (normalized.id && list.some(e => e.id === normalized.id)) return;

  list.unshift(normalized);
  if (list.length > MAX_EVENTS) list.pop();

  _broadcast?.("comms:event", { agentId, event: normalized });
}

export function getEvents(agentId: string, limit = 60): CommEvent[] {
  return (feed.get(agentId) ?? []).slice(0, limit);
}

function shortDigest(d?: string | null): string {
  if (!d || d.length < 10) return "";
  return d.slice(0, 8) + "…" + d.slice(-4);
}

export async function hydrateAgent(agentId: string) {
  const lastHydration = hydratedAt.get(agentId) ?? 0;
  if (Date.now() - lastHydration < HYDRATION_TTL_MS) return;
  hydratedAt.set(agentId, Date.now());

  try {
    const [allPos, allRewards, allTransfers, allDeposits] = await Promise.all([
      db.select().from(positions).where(eq(positions.agentId, agentId))
        .orderBy(desc(positions.openedAt)).limit(60),
      db.select().from(rewards).where(eq(rewards.agentId, agentId))
        .orderBy(desc(rewards.createdAt)).limit(40),
      db.select().from(transferJobs).where(eq(transferJobs.agentId, agentId))
        .orderBy(desc(transferJobs.createdAt)).limit(30),
      db.select().from(deposits).where(eq(deposits.agentId, agentId))
        .orderBy(desc(deposits.createdAt)).limit(10),
    ]);

    const events: CommEvent[] = [];

    for (const p of allPos) {
      if (p.txDigest && p.txDigest !== "cancelled_unfilled") {
        const ts = p.openedAt ? new Date(p.openedAt).getTime() : Date.now();
        const coll = p.collateral ?? (p.sizeSui / 25);
        events.push({
          id: `pos_open_${p.id}`,
          agentId,
          ts,
          type: "position_open",
          direction: "outbound",
          from: "Funding Wallet",
          to: "Typus Protocol",
          amount: coll,
          side: p.side,
          size: p.sizeSui,
          leverage: undefined,
          message: `Opened ${p.side?.toUpperCase()} ${p.sizeSui?.toFixed(0)} SUI @ $${p.entryPrice?.toFixed(4)} — sent ${coll.toFixed(4)} SUI collateral`,
          txDigest: p.txDigest,
          positionId: p.id,
          status: "confirmed",
          entryPrice: p.entryPrice,
        });
      }

      if (p.status === "closed" && p.closedAt && p.closeTxDigest && p.closeTxDigest !== "cancelled_unfilled") {
        const ts = new Date(p.closedAt).getTime();
        const isLiquidation = p.closeReason === "liquidated" || p.closeReason?.includes("liquidat");
        const isKeeper = p.pnlSource === "keeper_verified" || p.pnlSource === "onchain_verified";
        const pnl = p.returnedSui != null ? p.returnedSui - (p.collateral ?? 0) : p.unrealizedPnl ?? 0;
        const pnlStr = pnl >= 0 ? `+${pnl.toFixed(4)}` : pnl.toFixed(4);

        if (isLiquidation) {
          events.push({
            id: `pos_liq_${p.id}`,
            agentId,
            ts,
            type: "keeper_liquidation",
            direction: "inbound",
            from: "Typus Keeper",
            to: "Funding Wallet",
            amount: p.returnedSui ?? 0,
            pnl,
            side: p.side,
            size: p.sizeSui,
            message: `⚠ Keeper liquidated ${p.side?.toUpperCase()} ${p.sizeSui?.toFixed(0)} SUI — lost ${(p.collateral ?? 0).toFixed(4)} SUI`,
            txDigest: p.closeTxDigest,
            positionId: p.id,
            status: "confirmed",
            closeReason: p.closeReason ?? undefined,
          });
        } else {
          const label = isKeeper ? "Keeper filled close" : "Closed position";
          events.push({
            id: `pos_close_${p.id}`,
            agentId,
            ts,
            type: "keeper_fill",
            direction: "inbound",
            from: "Typus Keeper",
            to: "Funding Wallet",
            amount: p.returnedSui ?? (p.collateral ?? 0),
            pnl,
            side: p.side,
            size: p.sizeSui,
            message: `${label} ${p.side?.toUpperCase()} ${p.sizeSui?.toFixed(0)} SUI — returned ${(p.returnedSui ?? p.collateral ?? 0).toFixed(4)} SUI (PnL ${pnlStr} SUI)`,
            txDigest: p.closeTxDigest,
            positionId: p.id,
            status: "confirmed",
            closeReason: p.closeReason ?? undefined,
          });
        }
      }

      if (p.status === "closed" && p.closeTxDigest === "cancelled_unfilled" && p.closedAt) {
        const ts = new Date(p.closedAt).getTime();
        events.push({
          id: `pos_cancel_${p.id}`,
          agentId,
          ts,
          type: "keeper_fill",
          direction: "inbound",
          from: "Typus Protocol",
          to: "Funding Wallet",
          amount: p.collateral ?? 0,
          pnl: 0,
          side: p.side,
          size: p.sizeSui,
          message: `Order unfilled / cancelled — ${p.side?.toUpperCase()} ${p.sizeSui?.toFixed(0)} SUI returned ${(p.collateral ?? 0).toFixed(4)} SUI`,
          txDigest: undefined,
          positionId: p.id,
          status: "confirmed",
          closeReason: "cancelled_unfilled",
        });
      }
    }

    for (const r of allRewards) {
      const ts = r.createdAt ? new Date(r.createdAt).getTime() : Date.now();
      if (r.escrowTxDigest && r.escrowTxDigest !== "pending_escrow") {
        events.push({
          id: `reward_esc_${r.id}`,
          agentId,
          ts,
          type: "reward_escrow",
          direction: "inbound",
          from: "Reward Escrow",
          to: "Escrow Pool",
          amount: r.amount,
          message: `Escrowed ${r.amount.toFixed(4)} SUI reward`,
          txDigest: r.escrowTxDigest,
          status: "confirmed",
        });
      }
      if (r.status === "claimed" && r.claimedAt) {
        const claimTs = new Date(r.claimedAt).getTime();
        events.push({
          id: `reward_claim_${r.id}`,
          agentId,
          ts: claimTs,
          type: "reward_claim",
          direction: "outbound",
          from: "Escrow Pool",
          to: "User Wallet",
          amount: r.amount,
          message: `Claimed ${r.amount.toFixed(4)} SUI from reward escrow`,
          txDigest: r.txDigest ?? undefined,
          status: "confirmed",
        });
      }
    }

    for (const t of allTransfers) {
      const ts = t.initiatedAt ? new Date(t.initiatedAt).getTime() : Date.now();
      const isCompleted = t.status === "CONFIRMED" || t.status === "RECONCILED";
      const isSavings = t.transferType === "SAVINGS_SPLIT";
      events.push({
        id: `transfer_${t.id}`,
        agentId,
        ts,
        type: "savings_transfer",
        direction: "internal",
        from: "Funding Wallet",
        to: isSavings ? "Savings Wallet" : "Reward Escrow",
        amount: t.amountSui ?? 0,
        message: isSavings
          ? `Profit split → sent ${(t.amountSui ?? 0).toFixed(4)} SUI to Savings Wallet`
          : `Transferred ${(t.amountSui ?? 0).toFixed(4)} SUI to ${t.toAddress?.slice(0, 8) ?? "escrow"}`,
        txDigest: t.txHash ?? undefined,
        status: isCompleted ? "confirmed" : t.status === "FAILED" ? "failed" : "pending",
      });
    }

    for (const d of allDeposits) {
      const ts = d.createdAt ? new Date(d.createdAt).getTime() : Date.now();
      events.push({
        id: `deposit_${d.id}`,
        agentId,
        ts,
        type: "deposit",
        direction: "inbound",
        from: "User Wallet",
        to: "Funding Wallet",
        amount: d.amount,
        message: `Received deposit of ${d.amount.toFixed(4)} SUI (fee: ${d.protocolFee.toFixed(4)} SUI)`,
        txDigest: d.txDigest ?? undefined,
        status: "confirmed",
      });
    }

    events.sort((a, b) => b.ts - a.ts);

    if (!feed.has(agentId)) feed.set(agentId, []);
    const list = feed.get(agentId)!;
    for (const ev of events) {
      if (!list.some(e => e.id === ev.id)) {
        list.push(ev);
      }
    }
    list.sort((a, b) => b.ts - a.ts);
    if (list.length > MAX_EVENTS) list.splice(MAX_EVENTS);
  } catch (err) {
    console.error(`[Comms] Hydration failed for agent ${agentId}:`, err);
    hydratedAt.delete(agentId); // allow immediate retry on next request
  }
}
