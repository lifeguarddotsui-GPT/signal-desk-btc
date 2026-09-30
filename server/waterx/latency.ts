import pg from "pg";
import type { WaterxInterval } from "./types";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const WINDOW_MS = 60 * 60_000;
const MAX_SAMPLES = 10_000;
const publicationSamples: { at: number; latencyMs: number }[] = [];

export type LatencyDistribution = {
  status: "measured" | "unavailable";
  sampleCount: number;
  observedFrom: string | null;
  observedUntil: string | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  note?: string;
};

export function summarizeLatency(
  samples: readonly { at: number; latencyMs: number }[],
  note?: string,
): LatencyDistribution {
  const valid = samples
    .filter(sample => Number.isFinite(sample.at) && Number.isFinite(sample.latencyMs) && sample.latencyMs >= 0)
    .sort((a, b) => a.at - b.at);
  const sorted = valid.map(sample => sample.latencyMs).sort((a, b) => a - b);
  const percentile = (p: number) => {
    if (!sorted.length) return null;
    const index = (sorted.length - 1) * p;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    return Math.round((sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)) * 100) / 100;
  };
  return {
    status: sorted.length ? "measured" : "unavailable",
    sampleCount: sorted.length,
    observedFrom: valid.length ? new Date(valid[0].at).toISOString() : null,
    observedUntil: valid.length ? new Date(valid.at(-1)!.at).toISOString() : null,
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
    ...(note ? { note } : {}),
  };
}

/** Process-local ingestion-to-publish time; resets when this web process restarts. */
export function recordComparisonPublication(receivedAtMs: number, publishedAtMs = Date.now()): void {
  if (!Number.isSafeInteger(receivedAtMs) || !Number.isSafeInteger(publishedAtMs) ||
      publishedAtMs < receivedAtMs) return;
  publicationSamples.push({ at: publishedAtMs, latencyMs: publishedAtMs - receivedAtMs });
  const cutoff = publishedAtMs - WINDOW_MS;
  while (publicationSamples.length > MAX_SAMPLES || publicationSamples[0]?.at < cutoff)
    publicationSamples.shift();
}

export async function waterxLatencyReport(interval: WaterxInterval) {
  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();
  let comparisonSourceToServer: LatencyDistribution;
  let roundStartToObservation: LatencyDistribution;
  let providerSettlementToAcceptedLabel: LatencyDistribution;
  const unavailable = (reason: string) => summarizeLatency([], reason);
  if (!process.env.DATABASE_URL) {
    comparisonSourceToServer = unavailable("Development/production database is not configured.");
    roundStartToObservation = unavailable("Development/production database is not configured.");
    providerSettlementToAcceptedLabel = unavailable("Development/production database is not configured.");
  } else {
    try {
      const { rows } = await pool.query<{
        received_at: Date; source_to_server_latency_ms: number | null;
      }>(
        `SELECT received_at,source_to_server_latency_ms
           FROM waterx_comparison_ticks
          WHERE received_at >= $1 AND source_to_server_latency_ms IS NOT NULL
          ORDER BY received_at DESC LIMIT $2`,
        [cutoff, MAX_SAMPLES],
      );
      comparisonSourceToServer = summarizeLatency(rows.map(row => ({
        at: new Date(row.received_at).getTime(),
        latencyMs: Number(row.source_to_server_latency_ms),
      })), "Coinbase comparison source timestamp to app ingestion; source and server clocks may differ. Shared by both intervals.");
    } catch {
      comparisonSourceToServer = unavailable("Coinbase comparison tick archive cannot be queried.");
    }
    try {
      const { rows } = await pool.query<{
        observed_at: Date; start_ms: string | number; settled_at: string | number | null;
        settlement_observed_at: Date | null; label_status: string;
      }>(
        `SELECT observed_at,start_ms,settled_at,settlement_observed_at,label_status
           FROM waterx_learning_rounds
          WHERE interval_minutes=$1 AND observed_at >= $2
          ORDER BY observed_at DESC LIMIT $3`,
        [interval, cutoff, MAX_SAMPLES],
      );
      roundStartToObservation = summarizeLatency(rows.map(row => ({
        at: new Date(row.observed_at).getTime(),
        latencyMs: new Date(row.observed_at).getTime() - Number(row.start_ms),
      })), "WaterX round start to first stored app observation; provider and server clocks may differ.");
      providerSettlementToAcceptedLabel = summarizeLatency(rows
        .filter(row => row.label_status === "verified" &&
          row.settled_at !== null && row.settlement_observed_at !== null)
        .map(row => ({
          at: new Date(row.settlement_observed_at!).getTime(),
          latencyMs: new Date(row.settlement_observed_at!).getTime() - Number(row.settled_at),
        })), "Provider-reported settlement time to accepted app label; provider and server clocks may differ.");
    } catch {
      roundStartToObservation = unavailable("WaterX learning evidence cannot be queried.");
      providerSettlementToAcceptedLabel = unavailable("WaterX learning evidence cannot be queried.");
    }
  }
  return {
    intervalMinutes: interval,
    observationWindowMinutes: WINDOW_MS / 60_000,
    generatedAt: new Date().toISOString(),
    comparisonSourceToServer,
    comparisonServerToPublish: summarizeLatency(publicationSamples,
      "Process-local Coinbase ingestion to SSE publication; samples reset when this process restarts."),
    roundStartToObservation,
    providerSettlementToAcceptedLabel,
    publicationToBrowser: unavailable("Browser receipt telemetry is not yet available; cross-device clock offset is not verified."),
    browserToRender: unavailable("Browser render telemetry is not yet available."),
  };
}