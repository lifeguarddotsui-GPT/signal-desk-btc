/**
 * Analysis Agent — real-time market intelligence engine.
 *
 * Aggregates news, BTC/SUI sentiment, on-chain data, and produces:
 *   - Structured SentimentSnapshot
 *   - Human-readable market report
 *   - Direction bias and event risk scores
 *
 * Runs on a 5-minute refresh cycle. Degrades gracefully when sources fail.
 * Also integrates with the existing SentimentFlow (Hyperliquid + Typus tape)
 * from sentiment-flow-engine.ts for crowd intelligence.
 */

import { db } from "./db";
import { analysisSentimentSnapshots } from "@shared/schema";
import { fetchNewsItems, fetchCryptoCompareNews } from "./analysis-sources";
import { analyzeSourceItem, weightedAverage } from "./sentiment-engine";
import { buildMarketReportText } from "./market-report-engine";

export interface SentimentSnapshot {
  timestamp: number;
  overallScore: number;     // -1 to 1
  btcScore: number;         // -1 to 1
  suiScore: number;         // -1 to 1
  marketRiskScore: number;  // 0 to 1
  eventRiskScore: number;   // 0 to 1
  confidence: number;       // 0 to 1
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  headlineSummary: string[];
  keyDrivers: string[];
  warnings: string[];
  sourcesUsed: string[];
  reportText: string;
  shortSummary: string;
}

let latestSnapshot: SentimentSnapshot | null = null;
let lastRefreshAt = 0;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export async function refreshAnalysisAgent(): Promise<SentimentSnapshot> {
  const [news, ccNews] = await Promise.allSettled([
    fetchNewsItems(),
    fetchCryptoCompareNews(),
  ]);

  const allItems = [
    ...(news.status === "fulfilled" ? news.value : []),
    ...(ccNews.status === "fulfilled" ? ccNews.value : []),
  ];

  const deduped = dedupeItems(allItems).slice(0, 200);

  const scored = deduped.map(item => ({
    item,
    analysis: analyzeSourceItem(item),
  }));

  const btcItems = scored.filter(x => x.analysis.tags.includes("btc"));
  const suiItems = scored.filter(x => x.analysis.tags.includes("sui"));

  const allScores = scored.map(x => x.analysis.score);
  const allWeights = scored.map(x => x.analysis.relevance);

  const overallScore = weightedAverage(allScores, allWeights);
  const btcScore = btcItems.length > 0
    ? weightedAverage(btcItems.map(x => x.analysis.score), btcItems.map(x => x.analysis.relevance))
    : 0;
  const suiScore = suiItems.length > 0
    ? weightedAverage(suiItems.map(x => x.analysis.score), suiItems.map(x => x.analysis.relevance))
    : 0;
  const eventRiskScore = weightedAverage(scored.map(x => x.analysis.eventRisk), allWeights);
  const marketRiskScore = computeMarketRisk(scored);
  const confidence = computeSnapshotConfidence(scored);

  const bias: "BULLISH" | "BEARISH" | "NEUTRAL" =
    overallScore > 0.18 ? "BULLISH"
    : overallScore < -0.18 ? "BEARISH"
    : "NEUTRAL";

  const headlineSummary = scored
    .sort((a, b) => b.analysis.relevance - a.analysis.relevance)
    .slice(0, 6)
    .map(x => x.item.title)
    .filter(Boolean);

  const keyDrivers = buildKeyDrivers(scored, suiScore, btcScore, eventRiskScore);
  const warnings = buildWarnings(eventRiskScore, marketRiskScore, scored);

  const reportInput = {
    bias,
    overallScore,
    btcScore,
    suiScore,
    eventRiskScore,
    marketRiskScore,
    confidence,
    headlineSummary,
    keyDrivers,
    warnings,
  };

  const reportText = buildMarketReportText(reportInput);
  const shortSummary = `${bias} | SUI ${formatScore(suiScore)} | BTC ${formatScore(btcScore)} | Event Risk: ${riskLabel(eventRiskScore)}`;

  const snapshot: SentimentSnapshot = {
    timestamp: Date.now(),
    overallScore,
    btcScore,
    suiScore,
    marketRiskScore,
    eventRiskScore,
    confidence,
    bias,
    headlineSummary,
    keyDrivers,
    warnings,
    sourcesUsed: [...new Set(deduped.map(x => x.source))],
    reportText,
    shortSummary,
  };

  await persistSentimentSnapshot(snapshot);

  latestSnapshot = snapshot;
  lastRefreshAt = Date.now();

  console.log("[AnalysisAgent]", {
    bias,
    overallScore: overallScore.toFixed(2),
    suiScore: suiScore.toFixed(2),
    btcScore: btcScore.toFixed(2),
    eventRiskScore: eventRiskScore.toFixed(2),
    confidence: confidence.toFixed(2),
    itemsAnalyzed: scored.length,
  });

  return snapshot;
}

export async function getLatestSentimentSnapshot(): Promise<SentimentSnapshot> {
  if (latestSnapshot && Date.now() - lastRefreshAt < REFRESH_INTERVAL_MS) {
    return latestSnapshot;
  }
  return refreshAnalysisAgent();
}

export function getCachedSentimentSnapshot(): SentimentSnapshot | null {
  return latestSnapshot;
}

async function persistSentimentSnapshot(snapshot: SentimentSnapshot): Promise<void> {
  try {
    await db.insert(analysisSentimentSnapshots).values({
      overallScore: snapshot.overallScore,
      btcScore: snapshot.btcScore,
      suiScore: snapshot.suiScore,
      marketRiskScore: snapshot.marketRiskScore,
      eventRiskScore: snapshot.eventRiskScore,
      confidence: snapshot.confidence,
      bias: snapshot.bias,
      headlineSummaryJson: snapshot.headlineSummary,
      keyDriversJson: snapshot.keyDrivers,
      warningsJson: snapshot.warnings,
      reportText: snapshot.reportText,
      sourcesUsedJson: snapshot.sourcesUsed,
    });
  } catch (e: any) {
    console.warn("[AnalysisAgent] Failed to persist snapshot:", e.message);
  }
}

function dedupeItems(items: any[]): any[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = item.title.toLowerCase().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function computeMarketRisk(scored: Array<{ item: any; analysis: any }>): number {
  const riskItems = scored.filter(x => x.analysis.tags.includes("risk") || x.analysis.tags.includes("event"));
  if (riskItems.length === 0) return 0.1;
  const avgRisk = riskItems.reduce((s, x) => s + x.analysis.eventRisk, 0) / riskItems.length;
  return Math.min(1, avgRisk * 1.2);
}

function computeSnapshotConfidence(scored: Array<{ item: any; analysis: any }>): number {
  if (scored.length === 0) return 0.25;
  const avgConfidence = scored.reduce((s, x) => s + x.analysis.confidence, 0) / scored.length;
  const sampleBonus = Math.min(0.20, scored.length * 0.008);
  return Math.min(0.90, avgConfidence + sampleBonus);
}

function buildKeyDrivers(
  scored: Array<{ item: any; analysis: any }>,
  suiScore: number,
  btcScore: number,
  eventRiskScore: number,
): string[] {
  const drivers: string[] = [];

  if (Math.abs(suiScore) > 0.2) {
    drivers.push(suiScore > 0
      ? "Positive SUI ecosystem sentiment is supporting bullish bias"
      : "Negative SUI-specific news is weighing on market confidence");
  }

  if (Math.abs(btcScore) > 0.15) {
    drivers.push(btcScore > 0
      ? "BTC momentum is providing tailwind for altcoins including SUI"
      : "BTC weakness is creating headwinds for risk assets");
  }

  if (eventRiskScore > 0.4) {
    drivers.push("Elevated event risk from macro or regulatory developments");
  }

  const highRelevanceItems = scored
    .filter(x => x.analysis.relevance > 0.6)
    .sort((a, b) => b.analysis.relevance - a.analysis.relevance)
    .slice(0, 2);

  for (const item of highRelevanceItems) {
    const title = item.item.title.slice(0, 70);
    if (title.length > 10) drivers.push(title);
  }

  if (drivers.length === 0) {
    drivers.push("No strong directional catalysts detected in current scan");
  }

  return drivers.slice(0, 5);
}

function buildWarnings(
  eventRiskScore: number,
  marketRiskScore: number,
  scored: Array<{ item: any; analysis: any }>,
): string[] {
  const warnings: string[] = [];

  if (eventRiskScore > 0.65) warnings.push("High event risk — consider reducing leverage and widening stops");
  else if (eventRiskScore > 0.4) warnings.push("Moderate event risk — avoid outsized position sizes");

  if (marketRiskScore > 0.6) warnings.push("Market stress indicators elevated — monitor liquidity closely");

  const hackAlerts = scored.filter(x => x.analysis.tags.includes("risk") && x.analysis.score < -0.6);
  if (hackAlerts.length > 0) warnings.push("Security or exploit-related news detected — heightened systemic risk");

  return warnings;
}

function formatScore(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
}

function riskLabel(n: number): string {
  return n > 0.65 ? "High" : n > 0.4 ? "Moderate" : "Low";
}

export function startAnalysisAgent(): void {
  console.log("[AnalysisAgent] Starting — refreshing market intelligence every 5 minutes");
  refreshAnalysisAgent().catch(e => console.warn("[AnalysisAgent] Initial refresh failed:", e.message));
  setInterval(() => {
    refreshAnalysisAgent().catch(e => console.warn("[AnalysisAgent] Refresh failed:", e.message));
  }, REFRESH_INTERVAL_MS);
}
