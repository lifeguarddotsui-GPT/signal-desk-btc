import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoundDecision } from "../../shared/round-decision";
import type { TimedDecision, TimedState } from "../../shared/timed-decision";
import type { WaterxDataHealth } from "../../shared/waterx-data-health";
import { ManualOpportunity } from "./ManualOpportunity";
import { trainingEvidenceFacts } from "./EarlyLearningSummary";

test("insufficient jobs are not reported as trained and zero fit rounds are explicit",()=>{
  const insufficient={status:"INSUFFICIENT",started_at_ms:123,finished_at_ms:456,
    report:{reports:[{counts:{training:0}},{counts:{training:0}}]}};
  assert.deepEqual(trainingEvidenceFacts([insufficient]),{trainedAt:null,rounds:0});
  const trained={...insufficient,status:"EVALUATED",report:{reports:[{counts:{training:210}},{counts:{training:200}}]}};
  assert.deepEqual(trainingEvidenceFacts([insufficient,trained]),{trainedAt:456,rounds:210});
});
import type { AtomicDecisionView } from "./live-decision-contract";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./ManualOpportunity.css", import.meta.url), "utf8");
const source = readFileSync(new URL("./ManualOpportunity.tsx", import.meta.url), "utf8");
const now = 1_700_000_020_000;
const strategyVersion = "waterx-qualification-gates-v3";

function savedChoice(interval: 5 | 15, side: "UP" | "DOWN", startMs: number, expiryMs: number): TimedDecision {
  const probabilityUp = side === "UP" ? .72 : .38;
  const gateIndex = 2;
  const gateScheduledAtMs = startMs + gateIndex * 30_000;
  return {
    id: `timed-${interval}-${side}`,
    strategyVersion,
    network: "sui:mainnet",
    intervalMinutes: interval,
    roundId: `desk-${interval}`,
    startMs,
    expiryMs,
    status: "LOCKED",
    side,
    probabilityUp,
    probabilityDown: 1 - probabilityUp,
    observationId: "waterx-observation-locked",
    receivedAtMs: gateScheduledAtMs,
    decisionAtMs: gateScheduledAtMs + 1_000,
    elapsedMs: gateScheduledAtMs + 1_000 - startMs,
    targetAtMs: gateScheduledAtMs,
    hardDeadlineAtMs: gateScheduledAtMs + 2_000,
    lockReason: "QUALIFIED_SCHEDULED_GATE",
    earlyBlocker: "CONDITIONS_SATISFIED",
    ambiguous: false,
    coverage: { n: 7, firstAtMs: startMs + 1_000, lastAtMs: gateScheduledAtMs, maxGapMs: 9_000 },
    committedAtMs: gateScheduledAtMs + 1_500,
    workerReceivedAtMs: gateScheduledAtMs + 1_200,
    onTime: true,
    operationalFailure: null,
    automaticExecutionAllowed: false,
    gateIndex,
    gateScheduledAtMs,
    evidence: { probabilitySemantics: "experimental market-based policy; not a calibrated forecast", modelVersion: null },
  };
}

function timedState(interval: 5 | 15, startMs: number, expiryMs: number, overrides: Partial<TimedState> = {}): TimedState {
  const elapsedMs = Math.max(0, now - startMs);
  const nextGateAtMs = startMs + (Math.floor(elapsedMs / 30_000) + 1) * 30_000;
  return {
    strategyVersion,
    targetAtMs: startMs + (interval === 5 ? 60_000 : 180_000),
    hardDeadlineAtMs: expiryMs,
    elapsedMs,
    timeProgress: Math.min(1, elapsedMs / (interval * 60_000)),
    phase: elapsedMs >= (interval === 5 ? 60_000 : 180_000) ? "EVALUATING" : "OBSERVING",
    readinessPercent: 50,
    qualified: false,
    blocker: "SAME_SIDE_PERSISTENCE_INCOMPLETE",
    liveSide: "UP",
    liveProbabilityUp: .72,
    sourceAgeMs: 1_000,
    persistence: "WAITING",
    errorClass: null,
    saved: null,
    nextGateAtMs: nextGateAtMs < expiryMs ? nextGateAtMs : null,
    lastGate: null,
    requirementsMet: 2,
    requirementsTotal: 4,
    policySource: "experimental market-based policy",
    executionCutoffAtMs: null,
    remainingRequirement: "Needs more same-side evidence",
    components: {
      sameSideMs: 8_000, requiredSameSideMs: 24_000, validCount: 4, requiredCount: 3,
      probabilityRange: .02, maximumRange: .045, strength: .72, requiredStrength: .72,
      recentReversals: 0, trendKind: "FLAT_STABLE",
    },
    ...overrides,
  };
}

function decision(interval: 5 | 15, overrides: Partial<RoundDecision> = {}, probability = .72, elapsedMs = 20_000) {
  const round = { id: `desk-${interval}`, startMs: now - elapsedMs, expiryMs: now + interval * 60_000 - elapsedMs };
  const timedDecision = timedState(interval, round.startMs, round.expiryMs);
  const value: RoundDecision = {
    format: "waterx-live-decision-v2", streamId: `stream-${interval}`, network: "sui:mainnet",
    intervalMinutes: interval, roundId: round.id, startMs: round.startMs, expiryMs: round.expiryMs,
    policyVersion: strategyVersion, strategyVersion, stateVersion: 4, updatedAtMs: now, publishedAtMs: now,
    readiness: {
      state: "LEANING", score: 61, side: "UP", probability, evaluatedAtMs: now,
      secondsRemaining: interval * 60 - 20, sameSideMs: 12_000, earliestPossibleAtMs: now,
      reason: "Same-round observations are developing.", health: "CURRENT",
      components: {
        strength: .7, requiredStrength: .6, persistenceMs: 12_000, requiredPersistenceMs: 10_000,
        range: .02, reversals: 0, observationCount: 6, ageMs: 0, gapReset: false,
        velocity: .001, acceleration: 0, sourceHealthy: true, withinWindow: true, fresh: true, stable: true,
      },
    },
    market: { probabilityUp: probability, probabilityDown: 1 - probability, observedAtMs: now, receivedAtMs: now, providerOddsAtMs: null },
    persistence: { status: "WAITING_CHECKPOINT", updatedAtMs: now, errorClass: null },
    canonical: null, timedDecision, latestSafeOrderAtMs: null, executionWindowRemainingMs: null,
    executionBlocker: "Research only.", tradeAllowed: false,
    timestampSemantics: "Application timestamps; provider odds timestamp unknown.",
    ...overrides,
  };
  return { round, decision: value };
}

function health(status: WaterxDataHealth["probabilities"]["status"], lastValid: WaterxDataHealth["probabilities"]["lastValid"] = null): WaterxDataHealth {
  const primaryReason = status === "CURRENT" ? "CURRENT" : status;
  return {
    transport: { status: "HEALTHY", lastReceivedAtMs: now, errorClass: null },
    round: { status: "KNOWN" }, reference: { status: "CONFIRMED" },
    probabilities: { status, lastValid }, storage: { status: "UNKNOWN", errorClass: null },
    execution: { eligible: false, reason: "Research only." }, primaryReason,
  };
}

function viewFor(value: RoundDecision | null, fresh: boolean, dataHealth?: WaterxDataHealth, interval: 5 | 15 | null = value?.intervalMinutes ?? null): AtomicDecisionView {
  const exactRound = value ? { id: value.roundId, startMs: value.startMs, expiryMs: value.expiryMs } : null;
  const timed = value?.timedDecision ?? null;
  const savedDecision = timed?.saved ?? null;
  const provisionalLean = fresh ? timed?.liveSide ?? null : null;
  return {
    decision: value, fresh, sourceAgeMs: fresh ? 1_000 : 15_000, lean: provisionalLean,
    stage: provisionalLean ? `LEANING ${provisionalLean}` : "WATCHING", score: fresh ? 50 : null,
    reason: fresh ? "Current same-round observation." : "Current round evidence is not fresh enough.",
    dataHealth, projectionVersion: "waterx-exact-round-client-v1", sourceProjectionVersion: "test-v3",
    intervalMinutes: interval, roundIdentity: exactRound, strategyVersion: timed?.strategyVersion ?? null,
    snapshotVersion: value?.stateVersion ?? null, componentTimestamps: {},
    provisionalLean, lastGate: timed?.lastGate ?? null, nextGateAtMs: timed?.nextGateAtMs ?? null,
    savedDecision, persistenceState: value?.persistence.status ?? null,
  };
}

function render(interval: 5 | 15, view: AtomicDecisionView, options: {
  pending?: boolean; error?: string; round?: { id: string; startMs: number; expiryMs: number } | null;
  fixtureName?: string;
} = {}) {
  return renderToStaticMarkup(React.createElement(ManualOpportunity, {
    view, now, interval, round: options.round, refresh: { pending: !!options.pending, error: options.error ?? "" },
    onRetry: () => {}, fixtureName: options.fixtureName,
    marketReference: { price: 83_500, quality: "confirmed", source: "WaterX" },
    comparison: { price: 83_517.25, source: "Coinbase comparison", receivedAtMs: now - 500 },
  }));
}

test("fresh snapshots show current WaterX odds and the continuous provisional lean in both intervals", () => {
  for (const interval of [5, 15] as const) {
    const { round, decision: current } = decision(interval);
    const html = render(interval, viewFor(current, true, health("CURRENT")));
    assert.match(html, new RegExp(`· ${interval}m`));
    assert.match(html, /LEANING UP/);
    assert.match(html, /WaterX market/);
    assert.match(html, /\+0\.02% from reference/);
    assert.match(html, /72\.0%/);
    assert.match(html, /28\.0%/);
    assert.match(html, /MARKET DATA<\/span><b>CURRENT/);
    assert.match(html, /Qualification progress: 2 of 4 conditions met/);
  }
});

test("stale odds suppress provisional lean, retain permanent percentage positions and only label last same-round values stale in Details", () => {
  const { round, decision: current } = decision(5);
  const outage = health("PROBABILITIES_STALE", { up: .72, down: .28, receivedAtMs: now - 15_000, ageMs: 15_000 });
  const html = render(5, viewFor({ ...current, market: null }, false, outage));
  assert.match(html, /WATCHING/);
  assert.doesNotMatch(html, /LEANING UP/);
  assert.match(html, /WaterX market/);
  assert.match(html, /probability-up"><span>UP<\/span><strong>—<\/strong>/);
  assert.match(html, /probability-down"><span>DOWN<\/span><strong>—<\/strong>/);
  assert.match(html, /PROBABILITIES STALE/);
  assert.match(html, /<summary>Details<\/summary>[\s\S]*Stale · UP 72\.0% · DOWN 28\.0%/);
  assert.doesNotMatch(html.slice(0, html.indexOf("<details")), /72\.0%|28\.0%/);
  assert.ok(round.expiryMs > now);
});

test("saved timed lock survives a market-probability outage without being replaced by changing or stale odds", () => {
  const { round, decision: current } = decision(15, { market: null }, .72, 100_000);
  const saved = savedChoice(15, "DOWN", round.startMs, round.expiryMs);
  const timedDecision = { ...current.timedDecision!, persistence: "COMMITTED" as const, saved };
  const outage = health("PROBABILITIES_MISSING", { up: .72, down: .28, receivedAtMs: now - 15_000, ageMs: 15_000 });
  const view = viewFor({ ...current, timedDecision }, false, outage);
  const html = render(15, view);
  assert.match(html, /LOCKED DOWN/);
  assert.match(html, /WaterX market/);
  assert.match(html, /probability-up"><span>UP<\/span><strong>—<\/strong>/);
  assert.match(html, /probability-down"><span>DOWN<\/span><strong>—<\/strong>/);
  assert.match(html, /Frozen lock · DOWN/);
  assert.match(html, /UP 38\.0%/);
  assert.match(html, /DOWN 62\.0%/);
  assert.match(html, /Saved decision is frozen/);
  assert.doesNotMatch(html, /LOCKED UP/);
});

test("non-choice timed records never become a lock or invent a side", () => {
  const { round, decision: current } = decision(5, {}, .72, 100_000);
  const noChoice: TimedDecision = {
    ...savedChoice(5, "UP", round.startMs, round.expiryMs),
    status: "ABSTAINED_NO_QUALIFIED_SIGNAL",
    side: null,
    probabilityUp: null,
    probabilityDown: null,
    observationId: null,
    receivedAtMs: null,
    committedAtMs: now,
    onTime: null,
    lockReason: "NO_QUALIFIED_SIGNAL",
  };
  const timedDecision = { ...current.timedDecision!, persistence: "COMMITTED" as const, saved: noChoice };
  const html = render(5, viewFor({ ...current, timedDecision }, false));
  assert.match(html, /WATCHING/);
  assert.doesNotMatch(html, /LOCKED (?:UP|DOWN)|Frozen lock/);
  assert.match(html, /No side · immutable/);
  assert.match(html, /WaterX market/);
});

test("exact round and interval identity guard both the lean and saved lock projection", () => {
  const { round, decision: current } = decision(5);
  const view = viewFor(current, true, health("CURRENT"));
  const wrongRound = render(5, view, { round: { ...round, id: "another-round" } });
  const wrongInterval = render(15, view);
  for (const html of [wrongRound, wrongInterval]) {
    assert.doesNotMatch(html, /LEANING UP|LOCKED UP/);
    assert.match(html, /Waiting for an exact active-round snapshot/);
  }
});

test("refresh loading and errors remain honest, while research language makes no execution claim", () => {
  const empty = viewFor(null, false, undefined, null);
  const loading = render(5, empty, { pending: true });
  assert.match(loading, /desk-skeleton/);
  const failed = render(5, empty, { error: "NETWORK_ERROR" });
  assert.match(failed, /Live snapshot could not refresh/);
  assert.match(failed, /Retry/);
  assert.match(failed, /read-only market research/);
  assert.match(failed, /Automatic execution is disabled/);
  assert.doesNotMatch(failed, /place order|buy now|trade now/i);
});

test("chart remains immediately after the shared live decision, and fixtures stay visibly development-only", () => {
  assert.ok(app.indexOf("<ManualOpportunity") < app.indexOf("<section className=\"chart-panel\">"));
  assert.match(app, /does not describe complete coverage of the current round/);
  assert.match(css, /@media \(max-width: 600px\)/);
  assert.match(css, /@media \(max-width: 350px\)/);
  assert.match(source, /view\.savedDecision/);
  assert.match(source, /view\.provisionalLean/);
  assert.match(source, /WaterX market/);
  assert.doesNotMatch(source, /exactDecision\?\.canonical|decision\?\.canonical/);
  assert.match(app, /import\.meta\.env\.DEV && fixtureNames\.includes/);
});

test("missing probabilities have one waiting message and no failed qualification checklist",()=>{
  for(const interval of [5,15] as const){
    const {decision:current}=decision(interval,{market:null});
    const html=render(interval,viewFor(current,false,health("PROBABILITIES_MISSING")));
    assert.equal((html.match(/Waiting for WaterX odds\./g)??[]).length,1);
    assert.match(html,/Not evaluated: missing odds/);
    assert.doesNotMatch(html,/0 of 4 conditions|Qualification progress|title="Fresh input"/);
    assert.match(html,/probability-up/);assert.match(html,/probability-down/);
    assert.doesNotMatch(html,/LEANING (?:UP|DOWN)/);
  }
});

test("one shared primary card owns the responsive chart/sidebar and mobile prices can expand",()=>{
  const {round,decision:current}=decision(5);
  const html=renderToStaticMarkup(React.createElement(ManualOpportunity,{
    view:viewFor(current,true,health("CURRENT")),now,interval:5,round,
    children:React.createElement("section",{className:"chart-panel"},"Chart")}));
  assert.equal((html.match(/aria-label="WaterX market odds"/g)??[]).length,1);
  assert.equal((html.match(/class="desk-primary-card"/g)??[]).length,1);
  assert.equal((html.match(/class="desk-chart-slot"/g)??[]).length,1);
  assert.match(html,/<details class="desk-price-details"/);
  assert.match(css,/grid-template-columns: minmax\(0,2fr\) minmax\(280px,1fr\)/);
  assert.match(css,/@media \(max-width: 900px\)/);
});

test("$5 economics are indicative, identity-matched and never fill unknown receipts with zero",()=>{
  const {round,decision:current}=decision(5);
  const props={view:viewFor(current,true,health("CURRENT")),now,interval:5 as const,round};
  const economics={state:"OBSERVE",reason:"Uncalibrated market",amountEnteredUsd:5,
    identity:{roundId:round.id,intervalMinutes:5,startMs:round.startMs,expiryMs:round.expiryMs},
    sides:{up:{quote:{grossReceiptIfWinIndicative:9.09}},down:{quote:{grossReceiptIfWinIndicative:null}}}};
  const html=renderToStaticMarkup(React.createElement(ManualOpportunity,{...props,economics}));
  assert.match(html,/\$5 economics · indicative only/);
  assert.match(html,/Not an executable quote or expected profit/);
  assert.match(html,/UP · indicative gross winning receipt \$9\.09/);
  assert.doesNotMatch(html,/DOWN · indicative gross|\$0\.00|expected profit \$|calibrated confidence/);
  const mismatch=renderToStaticMarkup(React.createElement(ManualOpportunity,{...props,
    economics:{...economics,identity:{...economics.identity,roundId:"other"}}}));
  assert.doesNotMatch(mismatch,/\$5 economics/);
});
