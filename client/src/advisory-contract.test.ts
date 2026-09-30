import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessAdvisoryCard, type AdvisoryPayload } from "./advisory-contract";

const nowMs = 200_000;
const identity = { roundId: "r1", intervalMinutes: 5, startMs: 100_000, expiryMs: 400_000 };
const validProof = (side: "up" | "down" = "up", synthetic = false) => ({
  executionQuote: {
    roundId: identity.roundId, intervalMinutes: identity.intervalMinutes,
    startMs: identity.startMs, expiryMs: identity.expiryMs,
    side, amountUsd: 5, executable: true, costVerified: true, netReceiptVerified: true,
    totalCostUsd: 5.05, netWinningReceiptUsd: 9.6,
    quotedAtMs: nowMs - 1_000, expiresAtMs: nowMs + 7_000, synthetic,
  },
  model: {
    qualified: true, evidenceCount: 32, evidenceId: "forward-evaluation:cohort-32",
    calibratedProbability: .66, lowerBoundProbability: .62,
  },
  timing: {
    cutoffVerified: true, cutoffSource: "official-cutoff-policy",
    cutoffAtMs: 350_000, measuredAtMs: nowMs - 100,
    measuredBufferMs: 150_100, requiredBufferMs: 10_000,
  },
});
const base: AdvisoryPayload = {
  state: "FAVORABLE_UP", reason: "Evidence-backed lower bound clears verified cost.",
  amountEnteredUsd: 5,
  identity,
  sides: {
    up: { quote: { calibratedProbability: .66, estimatedExpectedNetValue: .18, breakEvenProbability: .51, ageMs: 900 } },
    down: { quote: { calibratedProbability: .34, estimatedExpectedNetValue: -.18, breakEvenProbability: .51, ageMs: 900 } },
  },
  proof: { up: validProof("up"), down: validProof("down") },
};
const input = (overrides: Partial<Parameters<typeof assessAdvisoryCard>[0]> = {}) => ({
  side: "up" as const, advisory: base, expectedIdentity: identity,
  roundCurrent: true, quoteCurrent: true, sideLocked: false, nowMs,
  ...overrides,
});

describe("advisory proof qualification gates", () => {
  it("qualifies only a side with complete executable $5, model, cost, and cutoff proof", () => {
    assert.equal(assessAdvisoryCard(input()).qualified, true);
    assert.equal(assessAdvisoryCard(input({ side: "down" })).qualified, false);
  });

  it("rejects malformed round identity at either advisory or executable quote level", () => {
    assert.equal(assessAdvisoryCard(input({ expectedIdentity: { ...identity, roundId: "other" } })).qualified, false);
    const wrongAdvisory = { ...base, identity: { ...identity, expiryMs: identity.expiryMs + 1 } };
    assert.equal(assessAdvisoryCard(input({ advisory: wrongAdvisory })).qualified, false);
    const wrongQuote = { ...base, proof: { ...base.proof, up: { ...validProof(), executionQuote: { ...validProof().executionQuote, startMs: identity.startMs + 1 } } } };
    assert.equal(assessAdvisoryCard(input({ advisory: wrongQuote })).qualified, false);
  });

  it("rejects absent or nonexecutable size-specific quotes and missing verified net cost/receipt", () => {
    for (const patch of [
      { executable: false }, { amountUsd: 4 }, { costVerified: false },
      { netReceiptVerified: false }, { totalCostUsd: undefined }, { netWinningReceiptUsd: undefined },
    ]) {
      const proof = validProof();
      const advisory = { ...base, proof: { up: { ...proof, executionQuote: { ...proof.executionQuote, ...patch } } } };
      assert.equal(assessAdvisoryCard(input({ advisory })).qualified, false);
    }
    assert.equal(assessAdvisoryCard(input({ advisory: { ...base, proof: undefined } })).qualified, false);
    assert.equal(assessAdvisoryCard(input({ advisory: { ...base, amountEnteredUsd: 10 } })).qualified, false);
  });

  it("rejects unqualified models, missing evidence lower bounds, and uneconomic bounds", () => {
    const proof = validProof();
    const fail = (model: Record<string, unknown>) => {
      const advisory = { ...base, proof: { up: { ...proof, model: { ...proof.model, ...model } } } };
      assert.equal(assessAdvisoryCard(input({ advisory })).qualified, false);
    };
    fail({ qualified: false });
    fail({ lowerBoundProbability: undefined });
    fail({ evidenceCount: 0 });
    fail({ evidenceId: "" });
    fail({ lowerBoundProbability: .4 });
  });

  it("requires an actual, currently open cutoff and a consistent measured timing buffer", () => {
    const proof = validProof();
    const failTiming = (timing: Record<string, unknown>) => {
      const advisory = { ...base, proof: { up: { ...proof, timing: { ...proof.timing, ...timing } } } };
      assert.equal(assessAdvisoryCard(input({ advisory })).qualified, false);
    };
    failTiming({ cutoffAtMs: undefined });
    failTiming({ cutoffVerified: false });
    failTiming({ cutoffSource: "" });
    failTiming({ cutoffAtMs: nowMs });
    failTiming({ cutoffAtMs: identity.expiryMs + 1 });
    failTiming({ measuredBufferMs: 5_000 });
    failTiming({ requiredBufferMs: undefined });
  });

  it("rejects expired, future, and fixture-only quote proofs in live mode", () => {
    const proof = validProof();
    for (const executionQuote of [
      { ...proof.executionQuote, expiresAtMs: nowMs },
      { ...proof.executionQuote, quotedAtMs: nowMs + 1 },
      { ...proof.executionQuote, synthetic: true },
    ]) {
      const advisory = { ...base, proof: { up: { ...proof, executionQuote } } };
      assert.equal(assessAdvisoryCard(input({ advisory })).qualified, false);
    }
  });

  it("permits a complete synthetic proof only when explicitly rendered as a development fixture", () => {
    const proof = validProof("up", true);
    const advisory = { ...base, proof: { up: proof } };
    assert.equal(assessAdvisoryCard(input({ advisory })).qualified, false);
    assert.equal(assessAdvisoryCard(input({ advisory, fixtureMode: true })).qualified, true);
  });

  it("never qualifies WAIT, locked, stale, or inactive-round states", () => {
    assert.equal(assessAdvisoryCard(input({ advisory: { ...base, state: "WAIT" } })).qualified, false);
    assert.equal(assessAdvisoryCard(input({ sideLocked: true })).qualified, false);
    assert.equal(assessAdvisoryCard(input({ quoteCurrent: false })).qualified, false);
    assert.equal(assessAdvisoryCard(input({ roundCurrent: false })).qualified, false);
  });
});