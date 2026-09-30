import pg from "pg";
import type { WaterxInterval } from "./types";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

/** Read-only candidate audit summary. This is never a serving forecast. */
export async function latestCandidateStatus(interval: WaterxInterval) {
  if (!process.env.DATABASE_URL)
    return { status: "unavailable", reason: "Candidate audit database is not configured.", promoted: false };
  try {
    const { rows } = await pool.query<{
      created_at: Date; report: Record<string, unknown>;
    }>(`SELECT created_at,report FROM waterx_candidate_training_attempts
       WHERE interval_minutes=$1 ORDER BY created_at DESC,attempt_id DESC LIMIT 1`,
    [interval]);
    const row = rows[0];
    if (!row)
      return { status: "insufficient", reason: "No offline candidate training attempt recorded yet.", promoted: false };
    const report = row.report;
    return {
      status: report.status,
      attemptedAt: new Date(row.created_at).toISOString(),
      artifactVersion: report.artifactVersion,
      datasetFingerprint: report.datasetFingerprint,
      recordCount: report.recordCount,
      acceptedLabelCount: report.acceptedLabelCount,
      rejectionReason: report.rejectionReason,
      split: report.split,
      candidateTestMetrics: report.candidateTestMetrics,
      matchingMarketTestMetrics: report.matchingMarketTestMetrics,
      promoted: false,
    };
  } catch (error) {
    if (error && typeof error === "object" &&
        ["42P01", "42703"].includes(String((error as { code?: unknown }).code)))
      return { status: "unavailable", reason: "Candidate audit schema is not installed in this environment.", promoted: false };
    throw error;
  }
}