import type { ResearchInterval, ResearchSide } from "./waterx-research";

/** Research-only WaterX mechanical rules; never a model or win probability. */
export type LockPolicy = {
  version: string; intervalMinutes: ResearchInterval;
  windows: number[]; fallbackSeconds: number; maxAgeMs: number; maxGapMs: number;
  earlyStrength: number; lateStrength: number; earlyPersistenceMs: number;
  latePersistenceMs: number; stabilityWindowMs: number; maxRange: number;
  reversalWindowMs: number; maxReversals: number; minObservations: number;
  maxVelocity: number; maxAcceleration: number; captureGraceMs: number;
};
export function lockPolicy(intervalMinutes: ResearchInterval): LockPolicy {
  return {version:"adaptive-waterx-lock-v1",intervalMinutes,
    windows:intervalMinutes===5?[120,90,60]:[360,300,240,180],
    fallbackSeconds:intervalMinutes===5?60:180,maxAgeMs:10_000,maxGapMs:12_000,
    earlyStrength:0.72,lateStrength:0.65,
    earlyPersistenceMs:intervalMinutes===5?24_000:45_000,
    latePersistenceMs:intervalMinutes===5?12_000:20_000,
    stabilityWindowMs:15_000,maxRange:0.045,reversalWindowMs:30_000,
    maxReversals:1,minObservations:3,maxVelocity:0.012,maxAcceleration:0.008,
    captureGraceMs:5_000};
}
export type LockObservation = {
  atMs: number; receivedAtMs: number; providerSourceAtMs: number | null;
  probabilityUp: number; probabilityDown: number; sourceHealthy: boolean;
};
export type LockReadiness = {
  state: "WATCHING" | "LEANING" | "BUILDING LOCK" | "READY";
  score: number; side: ResearchSide | null; probability: number | null;
  evaluatedAtMs: number; secondsRemaining: number; sameSideMs: number;
  earliestPossibleAtMs: number | null; reason: string;
  health: "WAITING FOR EVIDENCE" | "DATA/COLLECTOR DELAY";
  components: {
    strength: number; requiredStrength: number; persistenceMs: number;
    requiredPersistenceMs: number; range: number | null; reversals: number;
    observationCount: number; ageMs: number | null; gapReset: boolean;
    velocity: number | null; acceleration: number | null; sourceHealthy: boolean;
    withinWindow: boolean; fresh: boolean; stable: boolean;
  };
};
export type LockLatency = {
  measurementVersion?: "final-write-v1";
  kind: "OBSERVATION" | "EARLY_CANDIDATE" | "CANONICAL_LOCK";
  providerSourceAtMs: number | null; receivedAtMs: number; evaluationAtMs: number;
  transactionStartMs: number; committedAtMs: number;
  providerToReceiptMs: number | null; receiptToEvaluationMs: number;
  evaluationToTransactionMs: number; commitMs: number; totalMs: number;
  evaluationComputeMs?: number;
};
export type LockMetrics = { n: number; accuracy: number | null; brier: number | null; logLoss: number | null };
export type LockRoundSpeed = {
  roundId: string; startToLeanSeconds: number | null; leanToFinalSeconds: number | null;
  secondsRemainingAtFinal: number | null; probabilityAtLean: number | null;
  probabilityAtFinal: number | null; reversals: number; minProbabilityDuringLean: number | null;
  maxProbabilityDuringLean: number | null; marketMovementSinceLean: number | null;
  probabilityAtEligibility: number | null; captureLatencyMs: number | null;
  evaluationLatencyMs: number | null; databaseCommitLatencyMs: number | null;
};
export type LockReadinessReport = {
  intervalMinutes: ResearchInterval; asOfMs: number; schemaStatus: "available" | "unavailable";
  reason: string | null; researchOnly: true; source: "WaterX Market Baseline";
  current: { roundId: string; startMs: number; expiryMs: number; policy: LockPolicy;
    readiness: LockReadiness; candidate: {side: ResearchSide; probability: number; decisionAtMs: number} | null;
    speed: LockRoundSpeed | null } | null;
  counts: {rounds: number; observations: number; candidates: number; matched: number};
  comparison: { state: "INSUFFICIENT" | "DESCRIPTIVE_ONLY"; early: LockMetrics;
    canonical: LockMetrics; averageSecondsGained: number | null;
    averageSecondsGainedVsFallback?: number | null;
    averageSecondsBeforeEarlyLock?: number | null;
    averageSecondsBeforeCanonicalLock?: number | null;
    accuracyDifference: number | null; brierDifference: number | null; logLossDifference: number | null };
  checkpoints: {lockSeconds: number; early: LockMetrics; canonical: LockMetrics; averageSecondsGained: number | null}[];
  latency: Record<string,{n:number;p50Ms:number|null;p95Ms:number|null}>;
  missedWindows: {roundId:string;lockSeconds:number;code:string;reason:string;atMs:number}[];
  recentSpeeds: LockRoundSpeed[];
};