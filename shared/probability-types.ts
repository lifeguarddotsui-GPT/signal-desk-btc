export interface ProbabilityBucket {
  label: string;
  minDisplay: number;
  maxDisplay: number;
  midpointProbability: number;
}

export type CalibrationStatus = "OVERSTATED" | "CALIBRATED" | "UNDERSTATED";

export type ProbabilityTier = "Elite" | "Strong" | "Acceptable" | "Weak" | "Poor";

export interface FrozenProbabilitySnapshot {
  entryProbability: number;
  entryProbabilityDisplay: number;
  entryConfidence: number;
  entryExpectedEdgeBps: number;
  entryRegime: string;
  entryCluster: string;
  probabilityBucket: string;
  probabilityVersion: string;
}

export interface ProbabilityCalibrationRow {
  bucketLabel: string;
  bucketMinDisplay: number;
  bucketMaxDisplay: number;
  sampleSize: number;
  winCount: number;
  lossCount: number;
  actualWinRate: number;
  expectedWinRate: number;
  calibrationGap: number;
  avgPnlBps: number;
  avgPnlUsd: number;
  status: CalibrationStatus;
}

export interface ProbabilityCalibrationSummary {
  calibratedBucketRatio: number;
  highScoreActualWinRate: number;
  overstatedBucketCount: number;
}
