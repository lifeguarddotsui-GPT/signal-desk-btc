import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clock3, RefreshCw, ShieldCheck } from "lucide-react";
import type { BluewaterReport } from "../../shared/bluewater-research";
import type { LockReadinessReport } from "../../shared/lock-readiness";
import type { ResearchReport } from "../../shared/waterx-research";
import { currentBaselineChoice, currentChampionForecast, currentLockReadiness, currentResearchRound } from "./agent-round-contract";
import { ManualOpportunity } from "./ManualOpportunity";
import { projectExactRoundDecision, projectServerClock, type LiveSnapshotEnvelope } from "./live-decision-contract";
import { useLiveSnapshot } from "./useLiveSnapshot";
import { EventChallengerPanel } from "./EventChallengerPanel";

type Interval = 5 | 15;
type Props = { agentStatus?: string | null };
type Reports = { research: ResearchReport | null; bluewater: BluewaterReport | null; readiness: LockReadinessReport | null };
const initialReports: Reports = { research: null, bluewater: null, readiness: null };

async function fetchReport<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const result = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result as T;
}
const clock = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};
const clockStamp = (value: string | number | null | undefined) => {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "Not reported";
};

export default function AgentCurrentRound({ agentStatus }: Props) {
  const [interval, setInterval] = useState<Interval>(5);
  const [reports, setReports] = useState<Reports>(initialReports);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());
  const timedLive = useLiveSnapshot<LiveSnapshotEnvelope>(`/api/waterx/advisory?interval=${interval}&amount=5`, interval);

  useEffect(() => {
    let active = true;
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      const query = `?interval=${interval}`;
      const paths = [
        `/api/waterx/research${query}`,
        `/api/waterx/bluewater${query}`,
        `/api/waterx/lock-readiness${query}`,
      ] as const;
      const results = await Promise.allSettled([
        fetchReport<ResearchReport>(paths[0]),
        fetchReport<BluewaterReport>(paths[1]),
        fetchReport<LockReadinessReport>(paths[2]),
      ]);
      if (active) {
        setReports({
          research: results[0].status === "fulfilled" ? results[0].value : null,
          bluewater: results[1].status === "fulfilled" ? results[1].value : null,
          readiness: results[2].status === "fulfilled" ? results[2].value : null,
        });
        setErrors(results.flatMap((result, index) => result.status === "rejected" ? [`${["Research", "Bluewater", "Readiness"][index]}: ${result.reason instanceof Error ? result.reason.message : "Unavailable"}`] : []));
        setLoading(false);
      }
      running = false;
    };
    setReports(initialReports);
    setErrors([]);
    setLoading(true);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [interval]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const round = useMemo(() => currentResearchRound(reports.research, interval, now), [reports.research, interval, now]);
  const timedEnvelope = timedLive.atomicData?.intervalMinutes === interval ? timedLive.atomicData : null;
  const timedServerTime = timedEnvelope?.serverTime ? Date.parse(timedEnvelope.serverTime) : NaN;
  const timedNow = Number.isFinite(timedServerTime) && timedLive.atomicUpdated
    ? projectServerClock(timedServerTime, timedLive.atomicUpdated, now) : now;
  const timedRound = timedEnvelope?.round ?? null;
  const timedView = projectExactRoundDecision(timedEnvelope, interval, timedRound, timedNow);
  const choice = round ? currentBaselineChoice(reports.research, interval, round, now) : null;
  const forecast = round ? currentChampionForecast(reports.bluewater, interval, round, now) : null;
  const readiness = round ? currentLockReadiness(reports.readiness, interval, round, now) : null;
  const waitReason = !round
    ? "WAITING — no fresh active research round matches this interval."
    : !choice
      ? "HOLD — no exact, immutable WaterX Market Baseline FINAL CHOICE is available for this round."
      : !forecast
        ? "HOLD — a qualified, exact-round Bluewater champion probability is unavailable."
        : !readiness
          ? "HOLD — current same-round readiness evidence is missing or stale."
          : "HOLD — observation evidence is present, but execution remains disabled.";
  const currentReason = round ? reports.research?.currentReason : reports.research?.currentReason || "Waiting for a fresh current-round report.";

  return <section className="agent-current-round" aria-labelledby="agent-round-title">
    <div className="agent-current-head">
      <div><span className="agent-kicker">LIVE CONTEXT · RESEARCH IS NOT AUTHORITY</span><h2 id="agent-round-title">Current round</h2><p>Exact active-round evidence only. Latest historical choices never substitute for the current round.</p></div>
    </div>
    <ManualOpportunity view={timedView} now={timedNow} interval={interval} round={timedRound} onIntervalChange={setInterval}
      onRetry={timedLive.reload} refresh={{ pending: timedLive.loading, error: timedLive.error }} />
    <details className="agent-round-identity-audit">
      <summary>Active round identity &amp; snapshot diagnostics</summary>
      <div className="agent-round-identity">
        <div><span>ATOMIC DECISION ROUND ID</span><strong>{timedRound?.id ?? "Unavailable"}</strong></div>
        <div className="agent-expiry"><span><Clock3 size={12} /> DECISION ROUND EXPIRES IN</span><strong>{timedRound ? clock(timedRound.expiryMs - timedNow) : "—:—"}</strong></div>
        <div><span>INTERVAL</span><strong>{interval} minutes</strong></div>
        <div><span>RESEARCH REPORT ROUND · SEPARATE</span><strong>{round?.id ?? "Unavailable"} · {clockStamp(reports.research?.asOf)}</strong></div>
      </div>
    </details>
    <details className="agent-benchmarks">
      <summary>Canonical, champion &amp; readiness benchmarks · separate research references</summary>
      <div className="agent-round-evidence">
      <EventChallengerPanel projection={timedEnvelope?.decision?.eventChallenger ?? null} round={timedRound} now={timedNow} />
      <article className={`agent-round-evidence-card${choice ? " current" : ""}`}>
        <span className="agent-kicker">IMMUTABLE CANONICAL CHOICE</span>
        <h3>WaterX Market Baseline</h3>
        {choice ? <><strong className="agent-final-side">{choice.side} · FINAL CHOICE</strong><p>Frozen for this exact interval, round ID, start, and expiry.</p><small>Decision {clockStamp(choice.decisionAtMs)} · official settlement source remains separate.</small></>
          : <><strong className="agent-unavailable">No current FINAL CHOICE</strong><p>{round ? reports.research?.currentChoice?.noChoiceReason || currentReason || "No exact frozen market-baseline choice was returned." : currentReason || "No fresh active round."}</p><small>Only `currentChoice` is considered; historical `latestChoice` is never shown as current.</small></>}
      </article>
      <article className={`agent-round-evidence-card${forecast ? " current" : ""}`}>
        <span className="agent-kicker">QUALIFIED MODEL EVIDENCE</span>
        <h3>Bluewater champion</h3>
        {forecast ? <><strong className="agent-champion-prob">{(forecast.displayedProbabilityUp * 100).toFixed(1)}% <small>UP</small></strong><p>Qualified champion forecast · exact current-round identity.</p><small>{forecast.modelVersion} · decision {clockStamp(forecast.decisionAtMs)}</small></>
          : <><strong className="agent-unavailable">Probability unavailable</strong><p>No current forecast is shown unless the qualified champion artifact, interval, round, start, expiry, and fresh report all match.</p><small>{reports.bluewater?.reason || "No matching qualified champion evidence reported."}</small></>}
      </article>
      <article className={`agent-round-evidence-card${readiness ? " current" : ""}`}>
        <span className="agent-kicker">MECHANICAL MARKET READINESS</span>
        <h3>Lock readiness</h3>
        <strong className="agent-readiness-state">{readiness?.state ?? "Unavailable"}</strong>
        <span className="agent-readiness-warning"><AlertTriangle size={12} /> NOT A WIN PROBABILITY</span>
        <p>{readiness?.reason || reports.readiness?.current?.readiness?.reason || "No fresh exact-round readiness report is available."}</p>
        <small>{readiness ? `Evidence evaluated ${clockStamp(readiness.evaluatedAtMs)}` : reports.readiness?.reason || "No readiness evidence reported."}</small>
      </article>
      </div>
    </details>
    <div className="agent-round-execution">
      <div><span className="agent-kicker">AGENT {agentStatus ? `· ${agentStatus.replaceAll("_", " ")}` : ""}</span><strong>{round ? "HOLD" : "WAITING"}</strong><p>{waitReason}</p></div>
      <div className="agent-unavailable-economics"><span>EXECUTABLE BREAK-EVEN</span><b>Unavailable</b><span>VERIFIED NET EDGE</span><b>Unavailable</b></div>
      <div className="agent-no-quote"><ShieldCheck size={15} /> No verified executable quote or effective delegated-permission proof is available. Live execution remains disabled.</div>
    </div>
    {errors.length > 0 && <div className="agent-round-error" role="status"><RefreshCw size={13} />{errors.join(" · ")}{loading && <span>Refreshing…</span>}</div>}
    {loading && !reports.research && <div className="agent-round-loading" aria-label="Loading current research"><i /><i /><i /></div>}
  </section>;
}