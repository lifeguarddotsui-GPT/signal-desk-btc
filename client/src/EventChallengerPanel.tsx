import React from "react";
import type { EventLockProjection } from "../../shared/event-lock";

export type EventRoundIdentity = { id: string; startMs: number; expiryMs: number };

const percent = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "Unavailable" : `${(value * 100).toFixed(1)}%`;
const time = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "Time unavailable"
  : `${new Date(value).toLocaleTimeString([], { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })} UTC`;
const duration = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "Not reported" : `${Math.max(0, Math.round(value / 1000))}s`;
const label = (value: string) => value.replaceAll("_", " ").toLowerCase();

export function EventChallengerPanel({ projection, round, now }: {
  projection: EventLockProjection | null | undefined;
  round: EventRoundIdentity | null;
  now: number;
}) {
  const exact = !!projection && !!round && projection.roundId === round.id &&
    projection.startMs === round.startMs && projection.expiryMs === round.expiryMs &&
    projection.strategyVersion === "waterx-event-lock-v1" && projection.shadowOnly === true &&
    projection.benchmarkVersion === "waterx-qualification-gates-v3" &&
    projection.activePolicyChanged === false && projection.automaticExecutionAllowed === false;
  const event = exact ? projection : null;
  const saved = event?.saved?.status === "LOCKED" && (event.saved.side === "UP" || event.saved.side === "DOWN")
    ? event.saved : null;
  const savedSide = saved?.side;
  const state = event?.state === "ROUND_COMPLETE" || (!!event && round != null && now >= round.expiryMs) ? "ROUND COMPLETE"
    : !event ? "PROJECTION UNAVAILABLE"
    : saved ? `LOCKED ${savedSide}`
      : event.state === "LOCKED_UP" || event.state === "LOCKED_DOWN" ? "LOCKED · SAVED RECORD UNAVAILABLE"
      : event?.state === "SAVING" || event?.persistence === "SAVING" ? "SAVING"
        : event?.state === "LEANING_UP" ? "LEANING UP"
          : event?.state === "LEANING_DOWN" ? "LEANING DOWN" : "WATCHING";
  const qualification = event?.qualification;
  const components = qualification?.components;
  const sourceFresh = qualification?.sourceAgeMs != null && qualification.sourceAgeMs <= 10_000;
  const checks = [
    { name: "Fresh WaterX input", met: sourceFresh, detail: qualification?.sourceAgeMs == null ? "No valid input" : `${duration(qualification.sourceAgeMs)} old` },
    { name: "Directional strength", met: !!components && components.strength >= components.requiredStrength,
      detail: components ? `${components.strength.toFixed(2)} / ${components.requiredStrength.toFixed(2)}` : "Not reported" },
    { name: "Same-side persistence", met: !!components && components.sameSideMs >= components.requiredSameSideMs,
      detail: components ? `${duration(components.sameSideMs)} / ${duration(components.requiredSameSideMs)}` : "Not reported" },
    { name: "Stable evidence", met: !!components && components.validCount >= components.requiredCount &&
        (components.recentReversals ?? 0) === 0 &&
        (components.probabilityRange == null || components.probabilityRange <= components.maximumRange || components.trendKind === "STRENGTHENING"),
      detail: components ? `${components.validCount} observations · ${label(components.trendKind ?? "not reported")}` : "Not reported" },
  ];
  const currentUp = qualification?.liveProbabilityUp;
  const blocker = event ? saved && sourceFresh ? (state === "ROUND COMPLETE"
    ? "Round complete; the saved choice awaits verified settlement."
    : "Saved decision committed; live inputs are monitored separately.")
    : event.blocker === "CONDITIONS_SATISFIED" ? "Evidence qualifies; saving decision."
    : event.blocker === "NO_VALID_PROBABILITY_INPUT" ? "Waiting for fresh market probabilities."
      : event.blocker === "SAME_SIDE_PERSISTENCE_INCOMPLETE" ? "Direction established; waiting for stable evidence."
        : label(event.blocker) : !projection ? "Event challenger projection is missing from this snapshot."
      : !round ? "Exact active-round identity is unavailable."
        : "Projection does not match this exact round or shadow-policy contract.";

  return <section className="event-challenger" aria-label="Event-driven challenger shadow projection"
    data-projection-id={event?.saved?.id ?? event?.roundId ?? "unavailable"}>
    <header className="event-challenger-head">
      <div><span className="event-challenger-eyebrow">SHADOW · READ ONLY</span>
        <h3>Event-driven challenger</h3>
        <p>Evaluating on new data · {event?.strategyVersion ?? "waterx-event-lock-v1"}</p></div>
      <span className="event-shadow-badge">NOT ACTIVE</span>
    </header>
    <p className="event-authority-note">The 30-second benchmark remains the active research policy. This projection cannot change policy or authorize an order.</p>

    {saved ? <div className="event-saved-lock" role="status">
      <span>FROZEN SHADOW LOCK · {savedSide}</span>
      <strong>UP {percent(saved.probabilityUp)} <i>·</i> DOWN {percent(saved.probabilityDown)}</strong>
      <small>{saved.committedAtMs == null
        ? `Durable choice recovered; acknowledgement time unrecorded · evaluated ${time(saved.decisionAtMs)}`
        : `Saved ${time(saved.committedAtMs)}`} · WaterX market probability, not a calibrated forecast.</small>
      <small className="event-outage-note">Saved side and probabilities remain unchanged if live quotes are unavailable.</small>
    </div> : null}
    {event && !saved && (event.state === "LOCKED_UP" || event.state === "LOCKED_DOWN") &&
      <p className="event-saved-missing" role="status">Projection reports a lock, but the immutable saved record is unavailable in this snapshot.</p>}

    <div className="event-live-lean">
      <span>{saved ? "Current challenger input · independent of saved lock" : "Current challenger input"}</span>
      {currentUp != null && Number.isFinite(currentUp)
        ? <strong>UP {percent(currentUp)} <i>·</i> DOWN {percent(1 - currentUp)}</strong>
        : <strong className="event-missing">No current event probability input</strong>}
      <small>{currentUp != null && Number.isFinite(currentUp)
        ? `WaterX market input · ${qualification?.sourceAgeMs == null ? "age not reported" : `${duration(qualification.sourceAgeMs)} old`} · uncalibrated`
        : "Missing or unhealthy input; live market odds above remain a separate feed."}</small>
    </div>

    <div className="event-state-row"><strong className={`event-state ${state.startsWith("LOCKED") ? "locked" : ""}`}>{state}</strong>
      <span>{event?.persistence ? `Persistence · ${label(event.persistence)}` : "Projection state unavailable"}</span></div>
    <div className="event-qualification" aria-label="Qualification requirements met, not probability">
      <div className="event-progress-caption"><span>Requirements met</span>
        <strong>{qualification?.requirementsMet == null ? "Not reported" : `${qualification.requirementsMet} / ${qualification.requirementsTotal ?? 4}`}</strong></div>
      {checks.map(check => <div className="event-check" key={check.name}>
        <i className={check.met ? "met" : ""} aria-hidden="true" /><span>{check.name}</span><small>{check.detail}</small>
      </div>)}
      <small className="event-progress-note">Progress is qualification requirements met—not win probability or a deadline.</small>
    </div>
    <div className="event-blocker"><span>ONE BLOCKER</span><strong>{blocker}</strong></div>
    {event && <div className="event-provenance">
      <span>First qualified</span><b>{time(event.firstQualifiedAtMs)}</b>
      <span>Accepted observations</span><b>{event.acceptedObservations}</b>
      <span>Duplicate deliveries</span><b>{event.duplicateDeliveries}</b>
      <span>Out-of-order / dropped</span><b>{event.outOfOrderInputs} / {event.droppedInputs}</b>
    </div>}
    <p className="event-disclaimer">No promoted model or qualified probability is implied. Research display only; no trading authority.</p>
  </section>;
}
