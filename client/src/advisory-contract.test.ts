import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessAdvisoryCard, type AdvisoryPayload } from "./advisory-contract";
import { assessWaterxEvidenceWithHysteresis, type WaterxEvidence } from "../../server/waterx/advisory";

const nowMs = 200_000;
const identity = { marketId: "m1", roundId: "r1", intervalMinutes: 5, startMs: 100_000, expiryMs: 400_000 };
function proof(side: "up" | "down" = "up", synthetic = false) {
  return {
    side, fixture: synthetic,
    identity,
    reference: {
      marketId: identity.marketId, roundId: identity.roundId, intervalMinutes: identity.intervalMinutes,
      startMs: identity.startMs, expiryMs: identity.expiryMs,
      sourceName: "WaterX confirmed round reference", confirmed: true, price: 80_000, observedAtMs: nowMs - 2_000,
    },
    executionQuote: {
      kind: "accurate-simulation", quoteId: "hypothetical-test-only", marketId: identity.marketId,
      roundId: identity.roundId, intervalMinutes: identity.intervalMinutes,
      startMs: identity.startMs, expiryMs: identity.expiryMs,
      side, amountUsd: 5, executable: true, costVerified: true, netReceiptVerified: true, receiptVerified: true,
      simulationVerified: true,
      totalCostUsd: 5, grossWinningReceiptUsd: 12, winningFeesUsd: 0.2,
      losingGrossReceiptUsd: 0, losingFeesUsd: 0,
      netProfitIfWinUsd: 6.800000000000001, lossIfLoseUsd: 5,
      conservativeExpectedNetValueUsd: 3.26,
      feesIncluded: true, minimumsIncluded: true, priceImpactIncluded: true,
      netWinningReceiptUsd: 11.8, quotedAtMs: nowMs - 1_000, expiresAtMs: nowMs + 7_000, synthetic,
    },
    model: {
      marketId: identity.marketId, roundId: identity.roundId, intervalMinutes: identity.intervalMinutes, side,
      policyId: "waterx-value-policy-v1", policyEligibilityEnabled: true,
      status: "promoted", independent: true, heldoutForwardAccepted: true,
      version: "hypothetical-test-only", qualifiedSampleCount: 120, evidenceId: "hypothetical-test-only",
      calibratedProbability: .75, lowerBoundProbability: .7, uncertaintyMargin: .05,
      calibration: { method: "heldout-test-only", lowerBoundMethod: "heldout-test-only", verified: true },
      probabilityAtMs: nowMs - 500,
    },
    timing: {
      cutoffVerified: true, cutoffSource: "test-only", cutoffAtMs: 350_000,
      measuredAtMs: nowMs - 100, measuredBufferMs: 150_100, requiredBufferMs: 10_000,
    },
  };
}
function payload(state = "FAVORABLE_RISK_REWARD", proofUp = proof("up", true)): AdvisoryPayload {
  return {
    state, reason: "Hypothetical fixture; not live evidence.", amountEnteredUsd: 5,
    identity,
    sides: {
      up: { state, quote: { amountEnteredUsd: 5, conservativeExpectedNetUsd: 2.56 } },
      down: { state: "OBSERVE", quote: {} },
    },
    proof: { up: proofUp },
  };
}
const input = (overrides: Partial<Parameters<typeof assessAdvisoryCard>[0]> = {}) => ({
  side: "up" as const, advisory: payload(), expectedIdentity: identity,
  roundCurrent: true, quoteCurrent: true, sideLocked: false, nowMs, fixtureMode: true,
  ...overrides,
});

describe("advisory proof qualification gates", () => {
  it("withholds synthetic model display in live mode, even without any execution quote", () => {
    const advisory = payload("OBSERVE");
    const evidence = advisory.proof!.up!;
    delete evidence.executionQuote;
    const rejected = assessAdvisoryCard(input({ advisory, fixtureMode: false, quoteCurrent: false }));
    assert.equal(rejected.modelAvailable, false);
    assert.equal(rejected.model, null);
    assert.equal(rejected.qualified, false);
    evidence.fixture = false;
    const realEvidence = assessAdvisoryCard(input({ advisory, fixtureMode: false, quoteCurrent: false }));
    assert.equal(realEvidence.modelAvailable, true);
    assert.equal(realEvidence.quoteAvailable, false);
    assert.equal(realEvidence.classification, "OBSERVE");
  });
  it("renders server state only when all hypothetical test proof passes, never promotes OBSERVE", () => {
    const result = assessAdvisoryCard(input());
    assert.equal(result.state, "FAVORABLE_RISK_REWARD");
    assert.equal(result.qualified, true, result.reason);
    assert.equal(assessAdvisoryCard(input({ side: "down" })).qualified, false);
    assert.equal(assessAdvisoryCard(input({ advisory: payload("OBSERVE") })).state, "OBSERVE");
  });

  it("keeps independently valid model and $5 quote details visible without a glow", () => {
    const p = proof("up", true);
    const lowEdge = {
      ...p,
      model: { ...p.model, calibratedProbability: .57, lowerBoundProbability: .52 },
      executionQuote: { ...p.executionQuote, conservativeExpectedNetValueUsd: 1.136 },
    };
    const result = assessAdvisoryCard(input({ advisory: payload("OBSERVE", lowEdge) }));
    assert.equal(result.qualified, false);
    assert.equal(result.modelAvailable, true);
    assert.equal(result.quoteAvailable, true);
    assert.equal(result.model?.lowerBoundProbability, .52);
    assert.equal(result.economics?.totalCostUsd, 5);
    assert.ok(Math.abs(result.economics!.conservativeExpectedNetUsd! - 1.136) < 1e-12);
  });

  it("accepts a hypothetical high-likelihood state only with the server classification and positive economics", () => {
    const p = proof("up", true);
    const highProof = {
      ...p,
      executionQuote: {
        ...p.executionQuote, grossWinningReceiptUsd: 8.2, netWinningReceiptUsd: 8.2 - 0.2,
        netProfitIfWinUsd: 8.2 - 0.2 - 5,
        conservativeExpectedNetValueUsd: 0.85 * (8.2 - 0.2) - 5,
      },
      model: { ...p.model, calibratedProbability: .9, lowerBoundProbability: .85 },
    };
    const advisory = payload("HIGH_LIKELIHOOD", highProof);
    const result = assessAdvisoryCard(input({ advisory }));
    assert.equal(result.qualified, true, result.reason);
    assert.equal(result.classification, "HIGH_LIKELIHOOD");
  });

  it("rejects forged favorable top-level state without the same per-side server state", () => {
    const forged = payload();
    forged.sides.up.state = "OBSERVE";
    assert.equal(assessAdvisoryCard(input({ advisory: forged })).qualified, false);
    const noProof = payload();
    noProof.proof = undefined;
    assert.equal(assessAdvisoryCard(input({ advisory: noProof })).qualified, false);
  });

  it("rejects mismatched identity and missing/incomplete $5 quote proof", () => {
    assert.equal(assessAdvisoryCard(input({ expectedIdentity: { ...identity, roundId: "other" } })).qualified, false);
    assert.equal(assessAdvisoryCard(input({ expectedIdentity: {
      roundId: identity.roundId, intervalMinutes: identity.intervalMinutes,
      startMs: identity.startMs, expiryMs: identity.expiryMs,
    } })).qualified, false);
    for (const patch of [
      { amountUsd: 4 }, { totalCostUsd: 4.99 }, { feesIncluded: false },
      { minimumsIncluded: false }, { priceImpactIncluded: false }, { receiptVerified: false },
      { expiresAtMs: nowMs }, { quoteId: "" }, { marketId: "other" }, { winningFeesUsd: -0.1 },
    ]) {
      const p = proof("up", true);
      const advisory = payload("FAVORABLE_RISK_REWARD", {
        ...p, executionQuote: { ...p.executionQuote, ...patch },
      });
      assert.equal(assessAdvisoryCard(input({ advisory })).qualified, false);
    }
  });

  it("rejects shadow/unpromoted, under-sampled, uncalibrated, or uncertain model evidence", () => {
    for (const patch of [
      { status: "shadow" }, { independent: false }, { heldoutForwardAccepted: false },
      { qualifiedSampleCount: 99 }, { uncertaintyMargin: 0.2 },
      { calibration: { verified: false, method: "test", lowerBoundMethod: "test" } },
      { probabilityAtMs: nowMs - 11_000 },
    ]) {
      const p = proof("up", true);
      const advisory = payload("FAVORABLE_RISK_REWARD", { ...p, model: { ...p.model, ...patch } });
      assert.equal(assessAdvisoryCard(input({ advisory })).qualified, false);
    }
  });

  it("requires a confirmed, same-round WaterX reference and the central favorable-probability floor", () => {
    const p = proof("up", true);
    const missingReference = payload("FAVORABLE_RISK_REWARD", { ...p, reference: { ...p.reference, confirmed: false } });
    assert.equal(assessAdvisoryCard(input({ advisory: missingReference })).qualified, false);
    const belowFloor = payload("FAVORABLE_RISK_REWARD", {
      ...p, model: { ...p.model, calibratedProbability: .54, lowerBoundProbability: .49 },
    });
    assert.equal(assessAdvisoryCard(input({ advisory: belowFloor })).qualified, false);
  });

  it("requires current cutoff remaining buffer even when the old measured buffer looked sufficient", () => {
    const p = proof("up", true);
    const nearCutoff = payload("FAVORABLE_RISK_REWARD", {
      ...p, timing: { ...p.timing, cutoffAtMs: nowMs + 9_999, measuredBufferMs: 10_099 },
    });
    assert.equal(assessAdvisoryCard(input({ advisory: nearCutoff })).qualified, false);
  });

  it("rejects synthetic proofs in live mode and immediately withholds stale/locked/old-round states", () => {
    assert.equal(assessAdvisoryCard(input({ fixtureMode: false })).qualified, false);
    assert.equal(assessAdvisoryCard(input({ quoteCurrent: false })).qualified, false);
    assert.equal(assessAdvisoryCard(input({ sideLocked: true })).qualified, false);
    assert.equal(assessAdvisoryCard(input({ roundCurrent: false })).qualified, false);
  });

  it("never trusts a forged model policy flag while central live eligibility is disabled", () => {
    const nonsynthetic = proof("up", false);
    const advisory = payload("FAVORABLE_RISK_REWARD", nonsynthetic);
    const result = assessAdvisoryCard(input({ advisory, fixtureMode: false }));
    assert.equal(result.qualified, false);
    assert.equal(result.modelAvailable, true);
    assert.equal(result.quoteAvailable, true);
  });

  it("validates a real server hysteresis assessment and its bounded attestation end to end", () => {
    const evidence = proofAsServerEvidence();
    const now = nowMs;
    const first = assessWaterxEvidenceWithHysteresis(evidence, evidence.identity, now, true);
    assert.equal(first.state, "FAVORABLE_RISK_REWARD");
    const borderline: WaterxEvidence = {
      ...evidence,
      quote: {
        ...evidence.quote, quoteId: "refreshed-quote", grossWinningReceiptUsd: 10.28,
        quotedAtMs: now - 500, expiresAtMs: now + 6_500,
      },
      model: {
        ...evidence.model, evidenceId: "refreshed-model",
        calibratedProbability: .6, lowerBoundProbability: .55, probabilityAtMs: now - 200,
      },
    };
    const retained = assessWaterxEvidenceWithHysteresis(borderline, borderline.identity, now, true);
    assert.equal(retained.state, "FAVORABLE_RISK_REWARD");
    assert.ok(retained.hysteresis);
    const advisory = serverPayload(borderline, retained);
    const result = assessAdvisoryCard(input({ advisory }));
    assert.equal(result.qualified, true);
    assert.equal(result.classification, "FAVORABLE_RISK_REWARD");
  });
});

function proofAsServerEvidence(): WaterxEvidence {
  const p = proof("up", true);
  return {
    identity, side: "up", fixture: true,
    reference: { ...p.reference },
    quote: {
      kind: "accurate-simulation", amountUsd: 5, allInCostUsd: 5,
      grossWinningReceiptUsd: 12, winningFeesUsd: .2,
      losingGrossReceiptUsd: 0, losingFeesUsd: 0,
      feesIncluded: true, minimumsIncluded: true, priceImpactIncluded: true, receiptVerified: true,
      simulationVerified: true, quoteId: "hypothetical-test-only",
      quotedAtMs: nowMs - 1_000, expiresAtMs: nowMs + 7_000, synthetic: true,
    },
    model: {
      marketId: identity.marketId, roundId: identity.roundId, intervalMinutes: identity.intervalMinutes, side: "up",
      policyId: "waterx-value-policy-v1", policyEligibilityEnabled: true,
      status: "promoted", independent: true, heldoutForwardAccepted: true,
      version: "hypothetical-test-only", evidenceId: "hypothetical-test-only", qualifiedSampleCount: 120,
      calibratedProbability: .75, lowerBoundProbability: .7, uncertaintyMargin: .05,
      calibration: { method: "test-only", lowerBoundMethod: "test-only", verified: true },
      probabilityAtMs: nowMs - 500,
    },
    timing: {
      cutoffVerified: true, cutoffSource: "test-only", cutoffAtMs: 350_000,
      measuredAtMs: nowMs - 100, requiredBufferMs: 10_000,
    },
  };
}

function serverPayload(evidence: WaterxEvidence, result: ReturnType<typeof assessWaterxEvidenceWithHysteresis>): AdvisoryPayload {
  const quote = evidence.quote, model = evidence.model, economics = result.economics!;
  return {
    state: result.state, reason: result.reason, amountEnteredUsd: 5, identity,
    sides: {
      up: { state: result.state, reason: result.reason, quote: {} }, down: { state: "OBSERVE", quote: {} },
    },
    proof: {
      up: {
        side: evidence.side, fixture: true, identity: evidence.identity, reference: evidence.reference,
        hysteresis: result.hysteresis,
        executionQuote: {
          kind: quote.kind, quoteId: quote.quoteId, marketId: identity.marketId,
          roundId: identity.roundId, intervalMinutes: identity.intervalMinutes,
          startMs: identity.startMs, expiryMs: identity.expiryMs, side: evidence.side,
          amountUsd: 5, simulationVerified: true, costVerified: true, netReceiptVerified: true,
          receiptVerified: true, feesIncluded: true, minimumsIncluded: true, priceImpactIncluded: true,
          totalCostUsd: 5, grossWinningReceiptUsd: quote.grossWinningReceiptUsd,
          winningFeesUsd: quote.winningFeesUsd, losingGrossReceiptUsd: quote.losingGrossReceiptUsd,
          losingFeesUsd: quote.losingFeesUsd, netWinningReceiptUsd: quote.grossWinningReceiptUsd - quote.winningFeesUsd,
          netProfitIfWinUsd: economics.netProfitIfWinUsd, lossIfLoseUsd: economics.lossIfUnsuccessfulUsd,
          conservativeExpectedNetValueUsd: economics.conservativeExpectedNetUsd!,
          quotedAtMs: quote.quotedAtMs, expiresAtMs: quote.expiresAtMs, synthetic: true,
        },
        model,
        timing: {
          cutoffVerified: true, cutoffSource: evidence.timing.cutoffSource,
          cutoffAtMs: evidence.timing.cutoffAtMs, measuredAtMs: evidence.timing.measuredAtMs,
          measuredBufferMs: evidence.timing.cutoffAtMs - evidence.timing.measuredAtMs,
          requiredBufferMs: evidence.timing.requiredBufferMs,
        },
      },
    },
  };
}