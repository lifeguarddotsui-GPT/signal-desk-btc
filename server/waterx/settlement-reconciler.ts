import { canonicalWaterxRoundKey } from "../../shared/waterx-round-identity";
import { getWaterxRoundAtEpoch, verifiedHistoricalRound } from "./source";
import { listPendingWaterxSettlements, markWaterxSettlementAttempt, recordWaterxSettlement,finishWaterxSettlementAttempt } from "./learning";
import { captureResearchEvent, researchPool } from "./research-store";
import type { WaterxInterval } from "./types";

type Dependencies = {
  list: typeof listPendingWaterxSettlements;
  claim: typeof markWaterxSettlementAttempt;
  read: typeof getWaterxRoundAtEpoch;
  save: typeof recordWaterxSettlement;
  now: () => number;
  finish?:typeof finishWaterxSettlementAttempt;
  event: (round: { intervalMinutes: WaterxInterval; roundId: string; startMs: number; expiryMs: number },
    code: string, reason: string) => Promise<void>;
};
/** The database's due rows and atomic, expiring claims are the durable queue.
 * No frontend session, live odds or process-memory cursor is required. The
 * existing budget stays at two historical reads per interval per minute. */
export function createSettlementReconciler(dependencies: Dependencies, batchSize = 2) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2)
    throw new Error("Settlement batch exceeds the existing polling budget");
  const jobs = new Map<WaterxInterval, Promise<void>>();
  const counts = { runs: 0, attempted: 0, acceptedOrRecorded: 0, unresolved: 0,
    failed: 0, auditFailures: 0, claimSkipped: 0 };
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const log = async (round: Parameters<Dependencies["event"]>[0], code: string, reason: string) => {
    try { await dependencies.event(round, code, reason); }
    catch { counts.auditFailures++; }
  };
  function run(interval: WaterxInterval): Promise<void> {
    const existing = jobs.get(interval);
    if (existing) return existing;
    const job = (async () => {
      counts.runs++;
      const pending = await dependencies.list(interval, batchSize);
      for (const row of pending) {
        const round = { ...row, intervalMinutes: interval };
        try {
          canonicalWaterxRoundKey(round);
          if (row.expiryMs % 1000 !== 0 || row.startMs % 1000 !== 0)
            throw new Error("WATERX_INVALID_ROUND_IDENTITY");
          if (!await dependencies.claim(interval, row.roundId)) { counts.claimSkipped++; continue; }
          counts.attempted++;
          const epoch = row.expiryMs / 1000;
          const detail = await dependencies.read(interval, epoch);
          const resolved = verifiedHistoricalRound(detail, row.roundId, epoch);
          if (resolved.startsAt * 1000 !== row.startMs)
            throw new Error("WATERX_SETTLEMENT_START_MISMATCH");
          const status = resolved.resolutionStatus?.trim().toLowerCase() ?? null;
          // Save incomplete/rejected proofs too: the existing validator records
          // why they are withheld. Do not infer a price, outcome or timestamp.
          const result = await dependencies.save({
            intervalMinutes: interval, roundId: row.roundId,
            startMs:row.startMs,expiryMs:row.expiryMs,
            anchorPrice: resolved.anchorPrice, anchorConfirmed: resolved.anchorPriceConfirmed,
            settlePrice: resolved.settlePrice, outcome: resolved.settlement?.outcome ?? null,
            settledAt: resolved.settlement?.settledAt == null ? null : resolved.settlement.settledAt * 1000,
            observedAt: new Date(dependencies.now()).toISOString(), resolutionStatus: status ?? undefined,
          });
          if (status !== "resolved") counts.unresolved++;
          if (result) counts.acceptedOrRecorded++;
          await dependencies.finish?.(interval,row.roundId,result?null:"Settlement proof incomplete or withheld; see retained provider evidence.");
          await log(round, result ? "SETTLEMENT_LABEL_ACCEPTED" : "SETTLEMENT_PROOF_WITHHELD",
            `Provider status ${status ?? "missing"}; strict validator accepted=${result}. Rejection detail is retained on the round.`);
        } catch (error) {
          counts.failed++;
          const reason = error instanceof Error ? error.message.slice(0, 180) : "Settlement reconciliation failed";
          try{await dependencies.finish?.(interval,row.roundId,reason,
            Number((error as {retryAfterMs?:number}).retryAfterMs??0));}
          catch{counts.auditFailures++;}
          await log(round, /MISMATCH|IDENTITY/.test(reason) ? "SETTLEMENT_IDENTITY_MISMATCH" : "SETTLEMENT_RETRY_FAILED", reason);
          console.warn(`[waterx-${interval}m] independent settlement reconciliation failed:`, reason);
        }
      }
    })().catch(error => {
      counts.failed++;
      console.warn(`[waterx-${interval}m] settlement queue read failed:`,
        error instanceof Error ? error.message.slice(0, 180) : "unknown error");
    }).finally(() => { if (jobs.get(interval) === job) jobs.delete(interval); });
    jobs.set(interval, job);
    return job;
  }
  return {
    run,
    start() {
      if (timer) return;
      stopped = false;
      const tick = () => { if (!stopped) for (const interval of [5, 15] as const) void run(interval); };
      tick();
      timer = setInterval(tick, 60_000); timer.unref?.();
    },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; },
    async idle() { await Promise.all(Array.from(jobs.values())); },
    health: () => ({ ...counts, activeIntervals: jobs.size, periodMs: 60_000,
      maximumHistoricalReadsPerMinute: 4, durableQueue: "waterx_learning_rounds",
      uptimeGuarantee: "Only while the existing host is running; autoscale can sleep" }),
  };
}
export const settlementReconciler = createSettlementReconciler({
  list: listPendingWaterxSettlements, claim: markWaterxSettlementAttempt,
  read: getWaterxRoundAtEpoch, save: recordWaterxSettlement, now: Date.now,
  finish:finishWaterxSettlementAttempt,
  event: (round, code, reason) => captureResearchEvent(researchPool, {
    ...round, stage: "SETTLEMENT_RECONCILIATION", code, reason,
  }),
});
