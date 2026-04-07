import type { ProbabilityBucket, CalibrationStatus, ProbabilityTier } from "@shared/probability-types";

export function toProbabilityDisplay(probability: number): number {
  return Math.max(1, Math.min(99, Math.round(probability * 100)));
}

export function resolveProbabilityBucket(displayScore: number): ProbabilityBucket {
  if (displayScore >= 90) return { label: "90-99", minDisplay: 90, maxDisplay: 99, midpointProbability: 0.945 };
  if (displayScore >= 80) return { label: "80-89", minDisplay: 80, maxDisplay: 89, midpointProbability: 0.845 };
  if (displayScore >= 70) return { label: "70-79", minDisplay: 70, maxDisplay: 79, midpointProbability: 0.745 };
  if (displayScore >= 60) return { label: "60-69", minDisplay: 60, maxDisplay: 69, midpointProbability: 0.645 };
  if (displayScore >= 50) return { label: "50-59", minDisplay: 50, maxDisplay: 59, midpointProbability: 0.545 };
  return { label: "01-49", minDisplay: 1, maxDisplay: 49, midpointProbability: 0.25 };
}

export function resolveCalibrationStatus(calibrationGap: number): CalibrationStatus {
  if (calibrationGap <= -0.08) return "OVERSTATED";
  if (calibrationGap >= 0.08) return "UNDERSTATED";
  return "CALIBRATED";
}

export function resolveProbabilityTier(score: number): ProbabilityTier {
  if (score >= 90) return "Elite";
  if (score >= 80) return "Strong";
  if (score >= 70) return "Acceptable";
  if (score >= 60) return "Weak";
  return "Poor";
}

export const ORDERED_BUCKETS: ProbabilityBucket[] = [
  { label: "90-99", minDisplay: 90, maxDisplay: 99, midpointProbability: 0.945 },
  { label: "80-89", minDisplay: 80, maxDisplay: 89, midpointProbability: 0.845 },
  { label: "70-79", minDisplay: 70, maxDisplay: 79, midpointProbability: 0.745 },
  { label: "60-69", minDisplay: 60, maxDisplay: 69, midpointProbability: 0.645 },
  { label: "50-59", minDisplay: 50, maxDisplay: 59, midpointProbability: 0.545 },
  { label: "01-49", minDisplay: 1, maxDisplay: 49, midpointProbability: 0.25 },
];
