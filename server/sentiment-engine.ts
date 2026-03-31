/**
 * Sentiment Engine — text-based sentiment classification.
 *
 * Phase 1: deterministic keyword scoring with relevance weighting.
 * Phase 2 (future): replace with fine-tuned LLM classifier.
 *
 * Designed to degrade gracefully — unknown text returns neutral sentiment.
 */

import type { SourceItem } from "./analysis-sources";

export interface SentimentAnalysisResult {
  score: number;         // -1 to 1
  confidence: number;    // 0 to 1
  eventRisk: number;     // 0 to 1
  relevance: number;     // 0 to 1
  tags: string[];
  summary: string;
}

const BEARISH_KEYWORDS: [string, number][] = [
  ["hack", -0.85],
  ["exploit", -0.80],
  ["breach", -0.75],
  ["liquidation", -0.60],
  ["crash", -0.70],
  ["collapse", -0.80],
  ["rug", -0.90],
  ["scam", -0.80],
  ["ban", -0.55],
  ["lawsuit", -0.50],
  ["sec", -0.40],
  ["regulatory", -0.30],
  ["bear market", -0.60],
  ["sell off", -0.55],
  ["selloff", -0.55],
  ["dump", -0.50],
  ["dropped", -0.35],
  ["falls", -0.30],
  ["decline", -0.30],
  ["losses", -0.35],
  ["fear", -0.40],
  ["panic", -0.55],
  ["concern", -0.25],
  ["warning", -0.30],
  ["risk", -0.15],
  ["volatile", -0.20],
  ["uncertainty", -0.20],
  ["slump", -0.45],
];

const BULLISH_KEYWORDS: [string, number][] = [
  ["partnership", 0.50],
  ["launch", 0.40],
  ["adoption", 0.55],
  ["etf approved", 0.80],
  ["bull", 0.55],
  ["rally", 0.60],
  ["surge", 0.60],
  ["breakout", 0.50],
  ["all-time high", 0.75],
  ["ath", 0.65],
  ["growth", 0.40],
  ["bullish", 0.55],
  ["upside", 0.40],
  ["gains", 0.35],
  ["institutional", 0.45],
  ["mainstream", 0.35],
  ["integration", 0.40],
  ["upgrade", 0.35],
  ["innovation", 0.30],
  ["accumulation", 0.40],
  ["recovery", 0.45],
  ["rebound", 0.40],
];

const EVENT_RISK_KEYWORDS: [string, number][] = [
  ["etf", 0.45],
  ["regulation", 0.40],
  ["fed", 0.50],
  ["fomc", 0.55],
  ["inflation", 0.40],
  ["cpi", 0.50],
  ["interest rate", 0.45],
  ["halving", 0.35],
  ["expiry", 0.35],
  ["liquidation", 0.50],
  ["leverage", 0.25],
  ["hack", 0.80],
  ["exploit", 0.75],
  ["emergency", 0.70],
  ["ban", 0.60],
  ["lawsuit", 0.50],
];

const SUI_KEYWORDS = ["sui", "mysten", "typus", "aftermath", "cetus"];
const BTC_KEYWORDS = ["btc", "bitcoin", "satoshi", "sats"];

export function analyzeSourceItem(item: SourceItem): SentimentAnalysisResult {
  const text = `${item.title} ${item.body}`.toLowerCase();
  const tags: string[] = [];

  let score = 0;
  let eventRisk = 0;
  let relevance = 0.3 + (item.engagement ? Math.min(0.2, item.engagement / 500) : 0);

  for (const [kw, val] of BEARISH_KEYWORDS) {
    if (text.includes(kw)) {
      score += val;
      if (val < -0.5) tags.push("risk");
    }
  }

  for (const [kw, val] of BULLISH_KEYWORDS) {
    if (text.includes(kw)) {
      score += val;
      if (val > 0.4) tags.push("growth");
    }
  }

  for (const [kw, val] of EVENT_RISK_KEYWORDS) {
    if (text.includes(kw)) {
      eventRisk += val;
      tags.push("event");
    }
  }

  const isSUI = SUI_KEYWORDS.some(kw => text.includes(kw));
  const isBTC = BTC_KEYWORDS.some(kw => text.includes(kw));

  if (isSUI) { relevance += 0.30; tags.push("sui"); }
  if (isBTC) { relevance += 0.20; tags.push("btc"); }

  relevance = Math.min(1, relevance);
  score = clamp(score, -1, 1);
  eventRisk = clamp(eventRisk, 0, 1);

  const uniqueTags = [...new Set(tags)];
  const confidence = 0.40 + Math.min(0.40, uniqueTags.length * 0.07);

  return {
    score,
    confidence,
    eventRisk,
    relevance,
    tags: uniqueTags,
    summary: buildShortSummary(item, score, eventRisk, uniqueTags),
  };
}

export function weightedAverage(values: number[], weights: number[]): number {
  if (values.length === 0) return 0;
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  if (totalWeight === 0) return 0;
  return values.reduce((s, v, i) => s + v * weights[i], 0) / totalWeight;
}

function buildShortSummary(item: SourceItem, score: number, eventRisk: number, tags: string[]): string {
  const sentiment = score > 0.3 ? "positive" : score < -0.3 ? "negative" : "neutral";
  const risk = eventRisk > 0.5 ? " (high event risk)" : "";
  const tagStr = tags.length > 0 ? ` [${tags.slice(0, 3).join(",")}]` : "";
  return `${item.title.slice(0, 80)} — ${sentiment}${risk}${tagStr}`;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
