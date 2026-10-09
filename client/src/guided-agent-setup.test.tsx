import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultAgentPolicy } from "../../shared/agent-policy";
import GuidedAgentSetup from "./GuidedAgentSetup";

const render = (overrides: Partial<ComponentProps<typeof GuidedAgentSetup>> = {}) =>
  renderToStaticMarkup(createElement(GuidedAgentSetup, {
    policy: defaultAgentPolicy,
    onPolicyChange: () => undefined,
    authorized: false,
    ownerAddress: "",
    network: "Not verified",
    accountAddress: "",
    walletName: "",
    wallets: [],
    onConnect: () => undefined,
    accounts: [],
    accountId: null,
    onRefreshAsset: () => undefined,
    onSelectAccount: () => undefined,
    supportedAsset: null,
    settlementDecimals: undefined,
    busy: "",
    dirty: false,
    onSave: () => undefined,
    fundingAmount: "",
    onFundingAmountChange: () => undefined,
    usdcFundingAmount: "",
    onUsdcFundingAmountChange: () => undefined,
    coinObjectIds: "",
    onCoinObjectIdsChange: () => undefined,
    onOwnerAction: () => undefined,
    simulationPassed: false,
    pendingAction: "",
    pendingDescription: "",
    pendingTransaction: "",
    ownerChoice: false,
    onOwnerChoiceChange: () => undefined,
    onPrepare: () => undefined,
    onApprove: () => undefined,
    uncertainDigest: "",
    ownerSubmissionPending: false,
    onRetryConfirmation: () => undefined,
    ownerSetupSigning: false,
    readiness: { blocker: "Execution dependencies remain blocked.", nextAction: "Verify the isolated order adapter." },
    capabilitiesAvailable: true,
    onRetryCapabilities: () => undefined,
    technicalBlockers: [],
    capabilitySummary: [],
    onTryShadow: () => undefined,
    ...overrides,
  }));

test("guided setup has exactly four stages and offers an unsigned shadow alternative", () => {
  const html = render();
  for (const label of ["Connect", "Fund", "Strategy", "Start"]) assert.match(html, new RegExp(label));
  assert.match(html, /Connect Slush/i);
  assert.match(html, /shadow mode/i);
  assert.doesNotMatch(html, /Set session|Review account creation|Review funding|paper capital/i);
});

test("successful discovery shows an owned account without encouraging duplicate creation", () => {
  const html = render({ authorized: true, discoveryStatus: "success", accounts: [{ accountId: "0xowned" }], accountId: "0xowned" });
  assert.match(html, /0xowned/);
  assert.doesNotMatch(html, /Create WaterX account/i);
  const failed = render({ authorized: true, discoveryStatus: "error", discoveryError: "Connection unavailable" });
  assert.doesNotMatch(failed, /Create WaterX account/i);
  assert.match(failed, /Try again/i);
  const empty = render({ authorized: true, discoveryStatus: "success" });
  assert.match(empty, /Create WaterX account/i);
});

test("funding offers dollar presets and displays only reported balances", () => {
  const html = render({ initialStep: 1, authorized: true, accountId: "0xowned", accounts: [{ accountId: "0xowned" }], settlementDecimals: 6, availableBalanceUsd: "25.00" });
  for (const amount of ["10", "25", "50", "100"]) assert.match(html, new RegExp(`\\$${amount}`));
  assert.match(html, /Add funds/i);
  assert.match(html, /\$25\.00/);
  assert.doesNotMatch(html, /amountAtomic/);
  const unavailable = render({ initialStep: 1, authorized: true, accountId: "0xowned", accounts: [{ accountId: "0xowned" }] });
  assert.match(unavailable, /Balance unavailable/);
});

test("strategy cards retain advanced limits and require explicit compounding consent", () => {
  const html = render({ initialStep: 2, policy: { ...defaultAgentPolicy, compound: true }, dirty: true });
  for (const label of ["Conservative", "Continuous", "Balanced", "Custom"]) assert.match(html, new RegExp(label));
  assert.match(html, /Advanced/i);
  assert.match(html, /Confirm compounding/);
  assert.match(html, /Saving stores your strategy only/);
  assert.match(html, /disabled=""[^>]*>Save strategy/);
});

test("live authorization and start remain unavailable; diagnostics are not user setup tasks", () => {
  const html = render({
    initialStep: 3,
    authorized: true,
    ownerAddress: "0xowner",
    accountAddress: "0xowner",
    network: "Sui mainnet",
    walletName: "Slush",
    ownerSetupSigning: true,
    simulationPassed: true,
    pendingAction: "FUND",
    pendingDescription: "Review funding operation",
    pendingTransaction: "prepared-transaction",
  });
  assert.match(html, /Automatic trading permission is not available yet/);
  assert.match(html, /Live agent temporarily unavailable/);
  assert.match(html, /Technical diagnostics/);
  assert.doesNotMatch(html, /Authorize and start live/);
  assert.match(html, /disabled=""[^>]*>Authorize Agent/);
});

test("uncertain owner transaction supports confirmation retry without another signing action", () => {
  const html = render({ initialStep: 1, authorized: true, accountId: "0xowned", accounts: [{ accountId: "0xowned" }], pendingAction: "FUND", uncertainDigest: "digest-retained" });
  assert.match(html, /digest-retained/);
  assert.match(html, /Retry confirmation/);
});
