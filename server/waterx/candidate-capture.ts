import pg from "pg";
import { COMPARISON_SOURCE } from "../btc/chart";
import { captureWaterxCandidateSnapshot } from "./candidate-runtime";
import type { WaterxInterval } from "./types";
import { captureResearchObservation } from "./research-store";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL, max: 1,
  connectionTimeoutMillis: 5_000, query_timeout: 10_000, statement_timeout: 10_000,
});
const MAX_LOOKBACK_TICKS = 20_000;

/**
 * Best-effort prospective feature capture. An unavailable, unconfirmed, or
 * incomplete source window is never filled in retrospectively.
 */
export async function captureCandidateFromPersistedEvidence(input: {
  intervalMinutes: WaterxInterval;
  roundId: string;
  startMs: number;
  expiryMs: number;
  anchorPrice: number | null;
  anchorConfirmed: boolean;
  probabilityUp: number | null;
  probabilityDown?: number | null;
  observedAt: string;
  receivedAtMs?:number;
  providerSourceAtMs?:number|null;
}, options:{skipResearch?:boolean}={}): Promise<string> {
  // The decision time is the WaterX poll's actual app observation, not the
  // later time at which these database reads finish.
  const predictionAtMs = Date.parse(input.observedAt);
  if (!process.env.DATABASE_URL) return "Candidate capture skipped: no database configured.";
  // The research checkpoint freezes a new, internally consistent point-in-time
  // observation. It does not repurpose or mutate the legacy first-odds row.
  const research = options.skipResearch?"Canonical research has its own priority collector queue.":await captureResearchObservation({
    ...input, probabilityDown: input.probabilityDown ?? null,
  });
  if (input.anchorPrice === null || !input.anchorConfirmed || input.probabilityUp === null ||
      predictionAtMs >= input.expiryMs || predictionAtMs < input.startMs)
    return `${research} Legacy candidate capture skipped: confirmed pre-expiry anchor and odds unavailable.`;
  const earliest = await pool.query<{
    probability_up: string; observed_at: Date;
  }>(`SELECT probability_up,observed_at FROM waterx_learning_rounds
      WHERE interval_minutes=$1 AND round_id=$2 AND probability_up IS NOT NULL`,
  [input.intervalMinutes, input.roundId]);
  const frozen = earliest.rows[0];
  if (!frozen) return "Candidate capture skipped: earliest frozen WaterX odds unavailable.";
  if (new Date(frozen.observed_at).getTime() !== predictionAtMs ||
      Number(frozen.probability_up) !== input.probabilityUp)
    return "Candidate capture skipped: the current odds are not the immutable first observed WaterX odds.";
  const start = predictionAtMs - 180_000;
  const ticks = await pool.query<{
    id: string; source_at: Date; received_at: Date; price: string;
  }>(`SELECT id,source_at,received_at,price FROM waterx_comparison_ticks
      WHERE source=$1 AND source_at >= $2 AND source_at <= $3
        AND received_at <= $3
      ORDER BY source_at DESC,id DESC LIMIT $4`,
  [COMPARISON_SOURCE, new Date(start - 15_000), new Date(predictionAtMs), MAX_LOOKBACK_TICKS]);
  const result = await captureWaterxCandidateSnapshot({
    intervalMinutes: input.intervalMinutes,
    roundId: input.roundId,
    source: "WaterX",
    startMs: input.startMs,
    expiryMs: input.expiryMs,
    predictionAtMs,
    confirmedAnchorPrice: input.anchorPrice,
    anchorConfirmed: true,
    marketProbabilityUp: input.probabilityUp,
    marketProbabilityObservedAtMs: Date.parse(input.observedAt),
    firstFrozenMarketProbabilityUp: Number(frozen.probability_up),
    firstFrozenMarketProbabilityAtMs: new Date(frozen.observed_at).getTime(),
    marketProbabilitySnapshot: {
      storage: "waterx_learning_rounds",
      intervalMinutes: input.intervalMinutes,
      roundId: input.roundId,
      probabilityUp: Number(frozen.probability_up),
      appObservedAtMs: new Date(frozen.observed_at).getTime(),
      frozen: true,
    },
    comparisonArchive: {
      source: "Coinbase",
      archiveSource: "coinbase_ticks",
      status: ticks.rows.length === MAX_LOOKBACK_TICKS ? "partial" : "available",
      truncated: ticks.rows.length === MAX_LOOKBACK_TICKS,
      requestedStartMs: start - 15_000,
      requestedEndMs: predictionAtMs,
      ticks: ticks.rows.map(row => ({
        archiveId: String(row.id),
        source: "Coinbase" as const,
        sourceAtMs: new Date(row.source_at).getTime(),
        receivedAtMs: new Date(row.received_at).getTime(),
        price: Number(row.price),
      })),
    },
  });
  return result.status === "captured" ? "Captured immutable prospective candidate features."
    : result.status === "duplicate" ? result.reason : `Candidate capture skipped: ${result.reason}`;
}