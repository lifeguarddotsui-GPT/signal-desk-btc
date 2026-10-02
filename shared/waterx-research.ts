/** Research forecasts are never executable-quote or entry-eligibility proofs. */
export const WATERX_RESEARCH_POLICY = {
  version: "waterx-research-checkpoint-v1",
  checkpointSecondsBeforeClose: { 5: 60, 15: 180 },
  checkpointGraceMs: 15_000,
  maxOddsAgeMs: 10_000,
  tieBreak: "UP",
  comparisonLookbackMs: 180_000,
  maxComparisonGapMs: 15_000,
  trainingMode: "bounded-daily-shadow",
  trainingLookbackDays: 14,
  trainingMaxRows: 5000,
  promotionEnabled: false,
} as const;

export type ResearchInterval = 5 | 15;
export type ResearchSide = "UP" | "DOWN";
export type ReferenceQuality = "provisional" | "confirmed" | "unavailable";
export type ResearchComparison = {
  source: "Coinbase";
  price: number | null;
  sourceAtMs: number | null;
  receivedAtMs: number | null;
  return1m: number | null;
  return3m: number | null;
  realizedVolatility: number | null;
  tickCount: number;
  coverage: "complete" | "partial" | "unavailable";
  reason: string | null;
};
export type ResearchEvidence = {
  reference: { price: number | null; quality: ReferenceQuality; source: "WaterX"; appObservedAtMs: number };
  market: { probabilityUp: number | null; probabilityDown: number | null; appObservedAtMs: number; timestampKind: "app-observed" };
  comparison: ResearchComparison;
  qualityFlags: string[];
  tieBreakApplied: boolean;
};
export type ResearchChoice = {
  intervalMinutes: ResearchInterval;
  roundId: string;
  startMs: number;
  expiryMs: number;
  checkpointAtMs: number;
  decisionAtMs: number;
  state: "FROZEN" | "NO_VALID_CHOICE";
  side: ResearchSide | null;
  probabilityUp: number | null;
  probabilityDown: number | null;
  choiceSource: "market_baseline" | "bluewaterai_model" | null;
  modelVersion: string | null;
  calibrationVersion: string | null;
  policyVersion: string;
  noChoiceCode: string | null;
  noChoiceReason: string | null;
  evidence: ResearchEvidence;
  settlement: {
    state: "pending" | "correct" | "incorrect" | "disputed" | "withheld" | "not-applicable";
    outcome: ResearchSide | null;
    brier: number | null;
    logLoss: number | null;
    referenceDiscrepancyUsd: number | null;
    labelAvailableAt: string | null;
  };
};
export type ResearchModelEstimate = {
  status: "available" | "unavailable";
  roundId?: string;
  intervalMinutes?: ResearchInterval;
  probabilityUp: number | null;
  probabilityDown: number | null;
  modelVersion: string | null;
  calibrationVersion: string | null;
  observedAtMs: number | null;
  reason: string | null;
};
export type ResearchWindow = {
  name: "24h" | "7d" | "lifetime";
  observedRounds: number;
  officialChoices: number;
  noValidChoice: number;
  coveragePercent: number | null;
  scheduledCheckpoints?: number;
  unobservedCheckpoints?: number;
  scoredChoices: number;
  verifiedSettlements?: number;
  correct: number;
  accuracyPercent: number | null;
  brier: number | null;
  logLoss: number | null;
  marketBaselineBrier: number | null;
  marketBaselineLogLoss: number | null;
  pending: number;
  disputed: number;
  withheld: number;
  provisional: number;
  confirmed: number;
  unavailableReference: number;
  referenceDiscrepancies: number;
  featureCoverageFailures: number;
  calibration: { lower: number; upper: number; n: number; predictedUpMean: number; observedUpRate: number }[];
  cohorts: { referenceQuality: ReferenceQuality; n: number; accuracyPercent: number | null; brier: number | null; logLoss: number | null }[];
  referenceDiscrepancyCohorts?: {
    cohort: "changed" | "unchanged" | "unavailable"; referenceQuality: ReferenceQuality;
    n: number; accuracyPercent: number | null; brier: number | null; logLoss: number | null;
  }[];
  timeRemaining: { bucket: string; n: number; brier: number | null; logLoss: number | null }[];
};
export type ResearchDailyJob = {
  configured: boolean;
  mode: "opportunistic-existing-process" | "leased-worker";
  guaranteesDailyExecution: false;
  scheduledDay: string | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  datasetFingerprint: string | null;
  datasetCount: number;
  error: string | null;
  reason: string | null;
  phases: { status: string; at: string }[];
  missedDays: number;
};
export type ResearchReport = {
  intervalMinutes: ResearchInterval;
  asOf: string;
  schemaStatus: "available" | "unavailable";
  reason: string | null;
  policy: typeof WATERX_RESEARCH_POLICY;
  currentRound: { id: string; startMs: number; expiryMs: number } | null;
  currentChoice: ResearchChoice | null;
  latestChoice: ResearchChoice | null;
  currentState: "AWAITING_CHECKPOINT" | "FROZEN" | "NO_VALID_CHOICE" | "UNAVAILABLE";
  currentReason: string | null;
  liveModelEstimate: ResearchModelEstimate;
  windows: ResearchWindow[];
  noChoiceReasons: { code: string; reason: string; count: number }[];
  alert: { active: boolean; reason: string | null; delivery: "dashboard-and-server-log" };
  dailyJob: ResearchDailyJob;
  note: string;
  recentChoices?: ResearchChoice[];
  forwardEvaluation?: {
    intervalMinutes: ResearchInterval;
    asOf: string;
    schemaStatus: "available" | "unavailable";
    reason: string | null;
    recordedN: number;
    scoredN: number;
    unscoredN: number;
    disputedExcludedN: number;
    candidate: {
      n: number; brier: number | null; logLoss: number | null;
      calibration: readonly { lower: number; upper: number; n: number; predictedUpMean: number; observedUpRate: number }[];
    };
    marketBaseline: {
      n: number; brier: number | null; logLoss: number | null;
      calibration: readonly { lower: number; upper: number; n: number; predictedUpMean: number; observedUpRate: number }[];
    };
    status: "empty" | "recorded" | "scored" | "unavailable";
    shadowOnly: true;
  };
};