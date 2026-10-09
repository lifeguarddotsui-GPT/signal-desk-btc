import React, { useEffect, useState } from "react";
import { Pause, ShieldCheck } from "lucide-react";
import { useLiveSnapshot } from "./useLiveSnapshot";
import { projectExactRoundDecision, projectServerClock, type LiveSnapshotEnvelope } from "./live-decision-contract";
import type { AgentPolicy } from "../../shared/agent-policy";

/** An unsigned public observer, not an armed agent or a simulated fill ledger. */
export default function AgentRunningView({ policy, onPause, busy = false }: {
  policy: AgentPolicy; onPause: () => void; busy?: boolean;
}) {
  const [interval, setInterval] = useState<5 | 15>(policy.intervals[0]);
  const [now, setNow] = useState(Date.now());
  const live = useLiveSnapshot<LiveSnapshotEnvelope>(`/api/waterx/advisory?interval=${interval}&amount=5`, interval);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const envelope = live.atomicData;
  const serverNow = envelope?.serverTime && live.atomicUpdated ?
    projectServerClock(Number(envelope.serverTime), live.atomicUpdated, now) : now;
  const view = projectExactRoundDecision(envelope, interval, envelope?.round ?? null, serverNow);
  const saved = view.savedDecision;
  return <section className="ao-run" aria-label="Agent shadow mode">
    <div className="ao-run-heading"><div><span className="agent-kicker">BLUEWATER AGENT</span><h2>Shadow mode</h2></div><span className="ao-run-badge">OBSERVING</span></div>
    <div className="ao-run-notice"><ShieldCheck size={18} /><div><strong>NO REAL MONEY TRADES</strong><p>No wallet signatures, trading permissions or orders. This preview stops when you leave it.</p></div></div>
    <div className="ao-run-stats"><div><span>Balance</span><strong>No funds used</strong></div><div><span>Today</span><strong>No trading P&amp;L</strong></div></div>
    <div className="ao-run-round"><span>Current round</span><div><strong>BTC · {interval} MIN</strong><div className="ao-run-interval" aria-label="Round duration">{([5, 15] as const).map(n => <button key={n} aria-pressed={interval === n} onClick={() => setInterval(n)}>{n}m</button>)}</div></div></div>
    <div className="ao-run-signal"><span>Bluewater observation</span><strong>{view.lean ? `LEANING ${view.lean}` : "WAITING FOR FRESH DATA"}</strong><small>Market-derived research, not a calibrated win probability.</small></div>
    <div className="ao-run-readiness"><div><span>Lock readiness</span><b>{view.score == null ? "Unavailable" : `${view.score}%`}</b></div><progress aria-label="Research lock readiness" max={100} value={view.score ?? 0} /><small>Research readiness is not live trading approval.</small></div>
    <div className="ao-run-action"><span>Agent</span><strong>{saved ? `RESEARCH FINAL CHOICE · ${saved.side}` : "WAITING FOR LOCK"}</strong><p>{saved ? "Choice observed. No entry is checked and no order is submitted in this preview." : live.error ? "Market updates are temporarily unavailable. No choice or order is inferred." : "Watching the current round. Missing or stale signals remain HOLD."}</p></div>
    <button className="ao-button ao-button-primary ao-run-pause" disabled={busy} onClick={onPause}><Pause size={18} /> PAUSE AGENT</button>
    <details className="ao-tech"><summary>Observation details</summary><p>{view.reason}</p><p>This uses the public round feed only. It does not run your trading strategy, simulate profits, or continue in the background.</p></details>
  </section>;
}
