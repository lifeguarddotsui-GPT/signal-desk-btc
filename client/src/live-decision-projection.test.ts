import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createRoundDecisionTracker } from "../../server/waterx/round-decision";
import {
  getAtomicDecisionView, projectExactRoundDecision, validateLiveEnvelope,
  type LiveSnapshotEnvelope,
} from "./live-decision-contract";

function controlled(interval: 5 | 15) {
  const identity = { roundId: `projection-${interval}`, intervalMinutes: interval, startMs: 1_000_000, expiryMs: 1_000_000 + interval * 60_000 };
  const round = { id: identity.roundId, startMs: identity.startMs, expiryMs: identity.expiryMs };
  const now = round.expiryMs - (interval === 5 ? 90_000 : 240_000);
  const tracker = createRoundDecisionTracker();
  for (let at = now - 60_000; at <= now; at += 2_000) tracker.observe(identity, {
    atMs: at, receivedAtMs: at, probabilityUp: .8, probabilityDown: .2,
    providerSourceAtMs: null, sourceHealthy: true,
  });
  const read = (at = now, prior?: LiveSnapshotEnvelope): LiveSnapshotEnvelope => {
    if (at > now) tracker.observe(identity, {
      atMs: at, receivedAtMs: at, probabilityUp: .8, probabilityDown: .2,
      providerSourceAtMs: null, sourceHealthy: true,
    });
    const envelope: LiveSnapshotEnvelope = {
      serverTime: new Date(at).toISOString(), intervalMinutes: interval, round,
      projectionVersion: "waterx-projection-v3", snapshotVersion: prior ? (prior.snapshotVersion ?? 0) + 1 : 1,
      componentTimestamps: { providerReceivedAtMs: at, persistedAtMs: null },
      decision: tracker.read(identity, at),
    };
    return envelope;
  };
  return { round, now, read };
}

test("both intervals preserve exact round, strategy, source projection and component timestamps", () => {
  for (const interval of [5, 15] as const) {
    const fixture = controlled(interval);
    const envelope = fixture.read();
    const view = projectExactRoundDecision(envelope, interval, envelope.round, fixture.now);
    assert.equal(view.fresh, true);
    assert.equal(view.intervalMinutes, interval);
    assert.equal(view.roundIdentity?.id, fixture.round.id);
    assert.equal(view.sourceProjectionVersion, "waterx-projection-v3");
    assert.equal(view.strategyVersion, envelope.decision?.timedDecision?.strategyVersion ?? envelope.decision?.policyVersion);
    assert.equal(view.snapshotVersion, 1);
    assert.equal(view.componentTimestamps.providerReceivedAtMs, fixture.now);
    assert.equal(view.componentTimestamps.persistedAtMs, null);
  }
});

test("an interval switch cannot reuse the prior exact-round projection", () => {
  const fixture = controlled(5);
  const envelope = fixture.read();
  const view = getAtomicDecisionView(envelope, 15, fixture.round, fixture.now);
  assert.equal(view.decision, null);
  assert.equal(view.lean, null);
  assert.match(view.reason, /identity mismatch|interval/i);
});

test("same-round out-of-order response versions are rejected and do not replace the accepted state", () => {
  const fixture = controlled(5);
  const accepted = fixture.read();
  const newer = fixture.read(fixture.now + 2_000, accepted);
  const lateOldResponse = { ...accepted, serverTime: new Date(fixture.now + 3_000).toISOString() };
  assert.equal(validateLiveEnvelope(newer, 5, accepted), null);
  assert.equal(validateLiveEnvelope(lateOldResponse, 5, newer), "SNAPSHOT_VERSION_REGRESSION");
});

test("fresh evidence can recover after an outage without changing round identity", () => {
  const fixture = controlled(15);
  const envelope = fixture.read();
  const stale = getAtomicDecisionView(envelope, 15, envelope.round, fixture.now + 11_000);
  const recovered = getAtomicDecisionView(fixture.read(fixture.now + 12_000), 15, envelope.round, fixture.now + 12_000);
  assert.equal(stale.fresh, false);
  assert.equal(stale.lean, null);
  assert.equal(recovered.fresh, true);
  assert.equal(recovered.lean, "UP");
  assert.equal(recovered.roundIdentity?.id, envelope.round?.id);
});

