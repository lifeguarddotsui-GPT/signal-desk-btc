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
    ...overrides,
  }));

test("guided setup combines identity, owned account, funding, session, permissions and locked start", () => {
  const html = render();
  for (const label of ["Connect Slush", "Owned account", "Review funding", "Set session", "Permissions", "Start"]) assert.match(html, new RegExp(label));
  assert.match(html, /Connect an owner wallet/);
  assert.match(html, /No setup action starts trading/);
  assert.doesNotMatch(html, /paper capital|shadow session|Start shadow/i);
});

test("account workflow shows only returned account choices and never invents a balance", () => {
  const html = render({ initialStep: 1, accounts: [{ accountId: "0xowned" }], accountId: "0xowned" });
  assert.match(html, /0xowned/);
  assert.match(html, /No balance is inferred/);
  assert.match(html, /Review account creation/);
});

test("funding step accepts human dollars and reports asset decimals rather than atomics", () => {
  const html = render({ initialStep: 2, authorized: true, accountId: "0xowned", settlementDecimals: 9, supportedAsset: "settlement coin · Sui mainnet" });
  assert.match(html, /Settlement-native USD funding/);
  assert.match(html, /Native USDC conversion/);
  assert.match(html, /9 decimals reported/);
  assert.match(html, /USDC · 6 decimals/);
  assert.doesNotMatch(html, /amountAtomic/);
});

test("winning-return preferences are human dollar policy values, reviewed with explicit constraints", () => {
  const html = render({ initialStep: 3 });
  assert.match(html, /Minimum preferred total return on a win/);
  assert.match(html, /Preferred total return on a win/);
  assert.match(html, /Return preferences do not currently change active research qualification/);
  assert.match(html, /Not a maximum: better returns are allowed/);
  const invalid = render({ initialStep: 3, policy: { ...defaultAgentPolicy, minimumWinningReturnCents: 800, preferredWinningReturnCents: 700 } });
  assert.match(invalid, /preferred return at or above the minimum/);
  assert.match(invalid, /\$8\.00/);
  assert.match(invalid, /\$7\.00/);
});

test("permission approval is separate and live start remains unavailable", () => {
  const html = render({
    initialStep: 4,
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
  assert.match(html, /Approve this setup transaction in Slush/);
  assert.match(html, /never prompted on connect/);
  assert.match(html, /no AUTHORIZE flow/);
  assert.doesNotMatch(html, /Authorize and start live/);
  const start = render({ initialStep: 5, readiness: { blocker: "Owner signer is not verified.", nextAction: "Provision isolated signer." } });
  assert.match(start, /Owner signer is not verified/);
  assert.match(start, /Provision isolated signer/);
  assert.match(start, /Live beta session unavailable/);
});

test("uncertain owner transaction supports confirmation retry without another signing action", () => {
  const html = render({ initialStep: 4, authorized: true, pendingAction: "FUND", uncertainDigest: "digest-retained" });
  assert.match(html, /digest-retained/);
  assert.match(html, /Retry confirmation only/);
});
