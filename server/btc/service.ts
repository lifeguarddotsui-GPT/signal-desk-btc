import { comparisonBtc, discover, indicative, readSettlement, type Market } from "./source";
import { chartPoints, evaluationRows, history, markSettlementAttempt, pendingSettlements, recordSettlement, saveRound, saveSnapshot } from "./store";
import { evaluateBaseline, recommendation, strictWalkForward } from "./engine";

type Quote = { up: number; down: number; asOf: string; source: string };
type Comparison = { price: number; asOf: string; source: string };
let state: { round: Market | null; indicative: Quote | null; comparison: Comparison | null;
  updatedAt: string | null; marketStatus: string; priceStatus: string; comparisonStatus: string; reason: string } = {
    round: null, indicative: null, comparison: null, updatedAt: null,
    marketStatus: "WAITING", priceStatus: "WAITING", comparisonStatus: "WAITING", reason: "Waiting for the first public on-chain read.",
  };
let busy = false;
let timer: NodeJS.Timeout;
let settlementBusy = false;
export async function poll() {
  if (busy) return;
  busy = true;
  try {
    const discovery = await discover();
    const round = discovery.market;
    const observedAt = new Date().toISOString();
    const [quote, comparison] = await Promise.allSettled([
      round ? indicative(round) : Promise.resolve(null), comparisonBtc(),
    ]);
    const q = quote.status === "fulfilled" ? quote.value : null;
    const c = comparison.status === "fulfilled" ? comparison.value : null;
    state = {
      round, indicative: q, comparison: c, updatedAt: observedAt,
      marketStatus: round ? "LIVE_ONCHAIN_READ" : "NO_IDENTIFIABLE_ONE_MINUTE_ROUND",
      priceStatus: q ? "INDICATIVE" : "UNAVAILABLE",
      comparisonStatus: c ? "CURRENT" : "UNAVAILABLE",
      reason: !round ? "No identifiable current BTC one-minute round in the SDK active-market list."
        : !round.referencePrice ? "On-chain round reference price has not been recorded yet."
        : !q ? `Indicative price unavailable${quote.status === "rejected" ? ": " + String(quote.reason).slice(0, 140) : ""}.`
        : "Indicative on-chain probability is not an executable purchase quote.",
    };
    if (round) {
      try {
        await saveRound(round, observedAt);
        await saveSnapshot(round, { markets: discovery.all.map(m => ({
          id: m.id, expiryMs: String(m.expiryMs), referencePrice: m.referencePrice, mintPaused: m.mintPaused,
        })), chosen: round, indicative: q, comparison: c }, observedAt, q, c);
      } catch (error) {
        state.reason += ` Prospective storage failed: ${error instanceof Error ? error.message.slice(0, 100) : "unknown error"}.`;
        state.marketStatus = "STORAGE_ERROR";
      }
    }
  } catch (error) {
    state = { ...state, round: null, indicative: null, updatedAt: new Date().toISOString(),
      marketStatus: "UNAVAILABLE", priceStatus: "UNAVAILABLE",
      reason: `Official market read failed: ${error instanceof Error ? error.message.slice(0, 160) : "unknown error"}.` };
  } finally { busy = false; }
}
export async function reconcile() {
  if (settlementBusy) return;
  settlementBusy = true;
  try {
    for (const row of await pendingSettlements()) {
      try {
        await markSettlementAttempt(row.id);
        const price = await readSettlement(row.id);
        if (price !== null) await recordSettlement(row.id, price, row.reference_price === null ? null : Number(row.reference_price));
      } catch (error) { console.warn("[btc] settlement read pending", error instanceof Error ? error.message.slice(0, 100) : "unknown"); }
    }
  } finally { settlementBusy = false; }
}
export function startCapture() {
  void poll().then(reconcile).catch(error => console.error("[btc] capture", error));
  timer = setInterval(() => void poll().then(reconcile).catch(error => console.error("[btc] capture", error)), 6_000);
  timer.unref();
}
export async function live() {
  const now = Date.now();
  const stale = !state.updatedAt || now - Date.parse(state.updatedAt) > 14_000;
  const active = !stale && state.round && state.round.expiryMs > now && state.round.startMs <= now &&
    !state.round.mintPaused && state.round.referencePrice !== null;
  const round = active ? state.round : null;
  const quote = round && state.indicative && now - Date.parse(state.indicative.asOf) < 14_000 ? state.indicative : null;
  const comparison = state.comparison && now - Date.parse(state.comparison.asOf) < 20_000 ? state.comparison : null;
  return {
    serverTime: new Date().toISOString(), status: round ? "LIVE" : stale ? "STALE" : "HOLD",
    reason: stale ? "On-chain market read is stale; no live round can be certified."
      : !round ? state.reason || "Round has expired or is not yet eligible." : state.reason,
    round, indicative: quote, comparison, oraclePrice: null,
    points: await chartPoints(),
    recommendation: recommendation({
      hasRound: !!round, expiryMs: round?.expiryMs, now, referencePrice: round?.referencePrice,
      estimatedUp: null, executableUp: null, executableDown: null, payoutAfterFees: null,
      calibratedSamples: 0, edgeThreshold: .05,
    }),
    health: { market: stale ? "STALE" : state.marketStatus, price: quote ? "INDICATIVE" : "UNAVAILABLE",
      comparison: comparison ? "CURRENT" : "UNAVAILABLE", storage: state.marketStatus === "STORAGE_ERROR" ? "ERROR" : "ACTIVE" },
  };
}
export async function historyResponse() {
  const rows = await history();
  return { rows, coverage: {
    earliest: rows.length ? new Date(rows.at(-1)!.expiryMs).toISOString() : "Unavailable",
    latest: rows.length ? new Date(rows[0].expiryMs).toISOString() : "Unavailable",
    observed: rows.length, settled: rows.filter(r => r.quality === "VERIFIED_SETTLEMENT").length,
    quoteSnapshots: rows.reduce((sum, r) => sum + r.quoteCount, 0), missingHistory: true,
    reason: "Prospective observations only. The SDK does not enumerate historical settled rounds; pre-capture coverage, missing rounds, and historical executable quotes cannot be verified.",
  } };
}
export async function modelResponse() {
  const rows = await evaluationRows();
  const split = strictWalkForward(rows);
  return {
    status: split ? "BASELINES_ONLY" : "INSUFFICIENT_HISTORY",
    reason: split ? "Held-out baseline results only. No trained/calibrated logistic or volatility model or net return evaluation is available."
      : `Need at least 200 chronologically distinct, verified and pre-expiry quoted settlements for a first 100/50/50 walk-forward split; ${rows.length} available. No trained or calibrated prediction is displayed.`,
    sampleCount: split?.test.length ?? rows.length,
    baselines: split ? [
      { name: "50/50 (held-out)", ...evaluateBaseline(split.test, () => .5)! },
      { name: "On-chain indicative (held-out; not a fill)", ...evaluateBaseline(split.test, r => r.up)! },
    ] : [],
  };
}