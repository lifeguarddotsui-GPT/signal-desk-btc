/**
 * Market Report Engine — renders human-readable market intelligence reports.
 *
 * Produces short summaries for the dashboard and full narrative reports
 * that read like analyst commentary rather than raw data dumps.
 */

export interface ReportInput {
  bias: string;
  overallScore: number;
  btcScore: number;
  suiScore: number;
  eventRiskScore: number;
  marketRiskScore: number;
  confidence: number;
  headlineSummary: string[];
  keyDrivers: string[];
  warnings: string[];
}

export function buildMarketReportText(input: ReportInput): string {
  const now = new Date();
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

  const biasLabel = biasToLabel(input.bias, input.overallScore);
  const eventRiskLabel = scoreToRiskLabel(input.eventRiskScore);
  const confidenceLabel = confidenceToLabel(input.confidence);

  const driversSection = input.keyDrivers.length > 0
    ? `Key Drivers:\n${input.keyDrivers.map(d => `- ${d}`).join("\n")}`
    : "Key Drivers:\n- Insufficient data for driver analysis";

  const headlineSection = input.headlineSummary.length > 0
    ? `Recent Headlines:\n${input.headlineSummary.slice(0, 4).map(h => `- ${h}`).join("\n")}`
    : "";

  const warningSection = input.warnings.length > 0
    ? `Warnings:\n${input.warnings.map(w => `- ${w}`).join("\n")}`
    : "Warnings:\n- No significant risk flags detected";

  const executionRead = buildExecutionRead(input);

  return `Market Sentiment Report — ${timeStr}

Bias: ${biasLabel}
Confidence: ${confidenceLabel} (${(input.confidence * 100).toFixed(0)}%)
Overall Sentiment: ${formatScore(input.overallScore)}
BTC Sentiment: ${formatScore(input.btcScore)}
SUI Sentiment: ${formatScore(input.suiScore)}
Event Risk: ${eventRiskLabel}
Market Risk: ${scoreToRiskLabel(input.marketRiskScore)}

${driversSection}

${headlineSection}

${warningSection}

Execution Read:
${executionRead}`.trim();
}

export function buildShortSummary(input: ReportInput): string {
  const biasLabel = biasToLabel(input.bias, input.overallScore);
  const topDriver = input.keyDrivers[0] ?? "No key drivers identified";
  const topWarning = input.warnings[0];
  return `${biasLabel} | SUI: ${formatScore(input.suiScore)} | BTC: ${formatScore(input.btcScore)} | ${topDriver}${topWarning ? ` ⚠ ${topWarning}` : ""}`;
}

function biasToLabel(bias: string, score: number): string {
  const abs = Math.abs(score);
  const strength = abs > 0.5 ? "Strong " : abs > 0.25 ? "Moderate " : "Mild ";
  if (bias === "BULLISH") return `${strength}Bullish`;
  if (bias === "BEARISH") return `${strength}Bearish`;
  return "Neutral";
}

function scoreToRiskLabel(score: number): string {
  if (score > 0.7) return "High";
  if (score > 0.4) return "Moderate";
  if (score > 0.2) return "Low-Moderate";
  return "Low";
}

function confidenceToLabel(confidence: number): string {
  if (confidence > 0.75) return "High";
  if (confidence > 0.55) return "Moderate";
  if (confidence > 0.35) return "Low";
  return "Very Low";
}

function formatScore(score: number): string {
  const sign = score >= 0 ? "+" : "";
  return `${sign}${score.toFixed(2)}`;
}

function buildExecutionRead(input: ReportInput): string {
  const lines: string[] = [];

  if (input.bias === "BULLISH" && input.overallScore > 0.2) {
    lines.push("- Longs currently have stronger contextual support than shorts");
    if (input.suiScore > 0.3) lines.push("- SUI-specific sentiment favors bullish entries");
  } else if (input.bias === "BEARISH" && input.overallScore < -0.2) {
    lines.push("- Shorts currently have stronger contextual support than longs");
    if (input.suiScore < -0.3) lines.push("- SUI-specific sentiment favors bearish entries");
  } else {
    lines.push("- Market is balanced — both sides carry similar risk");
    lines.push("- Prefer high-conviction technical setups over directional bets");
  }

  if (input.eventRiskScore > 0.5) {
    lines.push("- Elevated event risk — reduce leverage and tighten stop losses");
  } else if (input.marketRiskScore > 0.5) {
    lines.push("- Market risk is elevated — wait for clearer regime before adding exposure");
  } else {
    lines.push("- Market conditions are suitable for standard position sizing");
  }

  if (input.confidence < 0.45) {
    lines.push("- Low confidence in current read — weight technical signals more heavily");
  }

  return lines.join("\n");
}
