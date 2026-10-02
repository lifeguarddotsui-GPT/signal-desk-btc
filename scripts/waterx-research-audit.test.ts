import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseResearchRows, sideAuditSql, featureAuditSql, validAuditChoices } from "../server/waterx/research-audit";

const now = 1_900_000_000_000;
function row(values: Record<string, unknown> = {}) {
  return { round_id: "observed-round", start_ms: now-600_000, expiry_ms: now-300_000,
    primary_lock_seconds: 60, state: "FROZEN", side: "UP", label_status: "verified",
    scored_round: "observed-round", settlement_disputed: false,
    latest_valid_input_ms: now-310_000, ...values };
}
test("a partial capture stall alerts even when earlier choices succeeded", () => {
  const diagnostics = diagnoseResearchRows([
    row(), row({ round_id: "lost-round", state: null, scored_round: null }),
  ], 5, now, now-80_000);
  assert.deepEqual(diagnostics.map(r=>r.code), ["ELIGIBLE_ROUND_MISSING_FINAL", "COLLECTOR_STALLED"]);
  assert.equal(diagnostics[0].roundId, "lost-round");
});
test("settlement and scoring diagnostics never invent outcomes", () => {
  const diagnostics = diagnoseResearchRows([
    row({ expiry_ms: now-610_000, label_status: "unresolved", scored_round: null }),
    row({ round_id: "score-missed", scored_round: null, label_available_ms: now-61_000 }),
    row({ round_id: "disputed", settlement_disputed: true }),
  ], 5, now, now-2_000);
  assert.deepEqual(diagnostics.map(r=>r.code), ["SETTLEMENT_OVERDUE", "VERIFIED_CHOICE_NOT_SCORED", "SETTLEMENT_WITHDRAWN"]);
});
test("missing timely input remains an explicit gap, not an eligible fabricated prediction", () => {
  const diagnostics = diagnoseResearchRows([row({ state: "NO_VALID_CHOICE", latest_valid_input_ms: null })], 15, now, null);
  assert.equal(diagnostics[0].code,"OBSERVED_ROUND_MISSING_FINAL");
  assert.equal(diagnostics[0].count,1);
  assert.deepEqual(diagnoseResearchRows([row()],5,now,now-1000),[]);
});
test("directional and mistake audits join exact undisputed canonical scores without feature/entry exclusions", () => {
  assert.match(validAuditChoices,/l.start_ms=c.start_ms AND l.expiry_ms=c.expiry_ms/);
  assert.match(validAuditChoices,/NOT l.settlement_disputed/);
  assert.doesNotMatch(validAuditChoices,/anchor_confirmed|coverage='complete'|entry_qualified/);
  assert.match(sideAuditSql,/probability_down/);
  assert.match(featureAuditSql,/missing_coinbase_features/);
  assert.match(featureAuditSql,/WHERE NOT correct/);
});