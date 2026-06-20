import { fetchAllPredictionMarkets } from "./coinbasePredictions";
import { recalculateAllSignals } from "./rankingEngine";
import { upsertMarket, upsertOutcome, insertSnapshot, getSettings, createAlert, getTodaySignals, cleanExpiredCryptoMarkets } from "../storage";

let isRefreshing = false;

export async function refreshAllMarkets(): Promise<void> {
  if (isRefreshing) return;
  isRefreshing = true;
  try {
    // Expire old crypto markets before fetching fresh ones
    await cleanExpiredCryptoMarkets();
    console.log("[Scheduler] Refreshing all prediction markets...");
    const cbMarkets = await fetchAllPredictionMarkets();

    for (const m of cbMarkets) {
      const timeRemaining = m.expirationTime
        ? Math.max(0, Math.floor((m.expirationTime.getTime() - Date.now()) / 1000))
        : null;

      const market = await upsertMarket({
        coinbaseMarketId: m.coinbaseMarketId,
        title: m.title,
        category: m.category,
        asset: m.asset ?? null,
        sport: m.sport ?? null,
        status: "active",
        expirationTime: m.expirationTime,
        volume: m.volume,
      });

      await upsertOutcome(market.id, "YES", m.yesPrice);
      await upsertOutcome(market.id, "NO", m.noPrice);

      await insertSnapshot({
        marketId: market.id,
        yesPrice: m.yesPrice,
        noPrice: m.noPrice,
        spotPrice: m.spotPrice,
        targetPrice: m.targetPrice,
        volume: m.volume,
        timeRemainingSeconds: timeRemaining ?? undefined,
      });
    }

    console.log(`[Scheduler] Stored ${cbMarkets.length} markets`);
  } catch (err) {
    console.error("[Scheduler] Market refresh error:", (err as Error).message);
  } finally {
    isRefreshing = false;
  }
}

export async function refreshSignals(): Promise<void> {
  try {
    const count = await recalculateAllSignals();
    console.log(`[Scheduler] Recalculated ${count} signals`);

    // Alert on high-confidence new signals
    const settings = await getSettings();
    const todaySignals = await getTodaySignals();
    for (const signal of todaySignals) {
      if (signal.confidenceScore >= settings.minConfidenceAlert) {
        await createAlert({
          signalId: signal.id,
          alertType: "high_confidence",
          message: `#${signal.rankToday} Pick — ${signal.marketTitle} | ${signal.recommendedSide} | Confidence ${signal.confidenceScore}/10 | Edge +${signal.edgeScore}%`,
        });
      }
    }
  } catch (err) {
    console.error("[Scheduler] Signal recalculation error:", (err as Error).message);
  }
}

export async function generateDailyReport(): Promise<void> {
  try {
    console.log("[Scheduler] Generating daily top-10 report...");
    await refreshAllMarkets();
    await refreshSignals();
    const todaySignals = await getTodaySignals();
    if (todaySignals.length > 0) {
      await createAlert({
        alertType: "daily_report",
        message: `Daily top-10 report generated. Top pick: ${todaySignals[0]?.marketTitle ?? "N/A"} — Confidence ${todaySignals[0]?.confidenceScore ?? 0}/10`,
      });
    }
  } catch (err) {
    console.error("[Scheduler] Daily report error:", (err as Error).message);
  }
}

export function startScheduler(): void {
  // Immediate initial load
  setTimeout(async () => {
    await refreshAllMarkets();
    await refreshSignals();
  }, 2000);

  // Refresh crypto markets every 60 seconds
  setInterval(async () => {
    try { await refreshAllMarkets(); } catch {}
  }, 60_000);

  // Recalculate signals every 90 seconds
  setInterval(async () => {
    try { await refreshSignals(); } catch {}
  }, 90_000);

  // Daily report at 7:00 AM
  const scheduleDaily = () => {
    const now = new Date();
    const next7am = new Date(now);
    next7am.setHours(7, 0, 0, 0);
    if (next7am <= now) next7am.setDate(next7am.getDate() + 1);
    const msUntil7am = next7am.getTime() - now.getTime();
    setTimeout(() => {
      generateDailyReport();
      setInterval(() => generateDailyReport(), 24 * 60 * 60 * 1000);
    }, msUntil7am);
  };
  scheduleDaily();

  console.log("[Scheduler] Started — crypto refresh 60s, signals 90s, daily report 7AM");
}
