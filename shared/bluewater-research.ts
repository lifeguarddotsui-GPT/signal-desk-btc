export type BluewaterFamily = "platt_waterx" | "rich_logistic" | "rich_logistic_no_market";
export type BluewaterMetrics = {
  n: number; brier: number | null; logLoss: number | null; accuracy: number | null;
  predictedUpRate: number | null; observedUpRate: number | null; highConfidenceErrors: number;
  calibration: { lower: number; upper: number; n: number; meanProbability: number; observedUpRate: number }[];
};
export type BluewaterForecast = {
  intervalMinutes: 5 | 15; roundId: string; startMs: number; expiryMs: number;
  lockSeconds: number; decisionAtMs: number; artifactId: string; modelFamily: BluewaterFamily;
  modelVersion: string; artifactDigest: string; featureSnapshotDigest: string;
  rawProbabilityUp: number; calibratedProbabilityUp: number | null;
  displayedProbabilityUp: number; chosenSide: "UP" | "DOWN"; forecastStatus: "SHADOW" | "CHAMPION";
  result: "CORRECT" | "INCORRECT" | null; outcome: "UP" | "DOWN" | null;
};
export type BluewaterFunnel = {
  window: string; since: string; through: string; expectedExactRounds: null;
  knownPublishedRounds: number; theoreticalTimeSlots: number; discoveryScope: string;
  discovered: number; validObservations: number; watching: number; canonicalChoices: number;
  onTimeChoices: number; lateChoices: number; missingChoices: number;
  verifiedSettlements: number; scoredChoices: number; trainingEligible: number;
  withdrawnDisputed: number; richFeatureChoices: number; modelForecastRounds: number; modelForecasts: number;
  rates: { canonicalCapture: number | null; onTimeCapture: number | null; settlementCompletion: number | null;
    scoringCompletion: number | null; richFeatureCoverage: number | null; modelForecastCoverage: number | null };
};
export type BluewaterComparison = {
  artifactId: string; modelFamily: BluewaterFamily; matchedN: number;
  candidate: BluewaterMetrics; baseline: BluewaterMetrics;
  pairedBrierDifference: { mean: number; lower95: number; upper95: number } | null;
};
export type BluewaterReport = {
  intervalMinutes: 5 | 15; asOf: string; schemaStatus: "available" | "unavailable"; reason: string | null;
  status: "COLLECTING" | "INSUFFICIENT" | "SHADOW" | "QUALIFIED"; developmentOnly: true;
  champion: { artifactId: string; modelFamily: BluewaterFamily; modelVersion: string } | null;
  challengers: { artifactId: string; modelFamily: BluewaterFamily; modelVersion: string; fittedAt: string }[];
  qualifiedCalibration: boolean; currentForecast: BluewaterForecast | null;
  priorForecast: BluewaterForecast | null; funnels: BluewaterFunnel[];
  training: { canonical: number; rich: number; currentAudit: unknown; lastDailyRun: string | null };
  comparisons: BluewaterComparison[];
  mistakes: { artifactId: string; roundId: string; probability: number; side: string; lockSeconds: number;
    secondsBeforeExpiry: number; baselineProbabilityUp: number; confidenceBucket: string;
    volatilityBucket: string; distanceBucket: string; reversal: boolean | null; features: Record<string, number | null> }[];
  research: { lastRun: string | null; mode: "bounded-report-only-planner";
    hypotheses: { hypothesis: string; reason: string; experiment: Record<string, unknown> }[];
    experiments: { id: string; kind: string; status: string; createdAt: string; result: unknown }[] };
  promotion: { automatic: false; eligible: boolean; reasons: string[]; reports: unknown[] };
  featureSchema: string; featureNames: string[]; limitations: string[];
  baselineMetrics?:BluewaterMetrics;
  mistakeAggregates?:Record<string,Record<string,number>>;
};