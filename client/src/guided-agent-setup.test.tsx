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
    supportedAsset: null,
    onRefreshAsset: () => undefined,
    status: "NOT LOADED",
    busy: "",
    dirty: false,
    onSave: () => undefined,
    onStartShadow: () => undefined,
    onPause: () => undefined,
    paperExists: false,
    paperCapital: "25.00",
    onPaperCapitalChange: () => undefined,
    experimentalConfirmed: false,
    onExperimentalConfirmedChange: () => undefined,
    compoundingConfirmed: false,
    onCompoundingConfirmedChange: () => undefined,
    everyRoundAck: false,
    onEveryRoundAckChange: () => undefined,
    edgeOffAck: false,
    onEdgeOffAckChange: () => undefined,
    zeroReserveAck: false,
    onZeroReserveAckChange: () => undefined,
    shadowAvailable: false,
    onRetryCapabilities: () => undefined,
    capabilitiesAvailable: true,
    reviewGeneration: 0,
    blocker: "Connect the owner wallet on Sui mainnet.",
    technicalBlockers: [],
    capabilitySummary: [],
    ...overrides,
  }));

test("guided setup presents wallet identity without implying funding or trading authority", () => {
  const html = render();
  assert.match(html, /Wallet identity/);
  assert.match(html, /A connection is not trading permission/);
  assert.match(html, /Nothing here grants signing or live order authority/);
  assert.match(html, /No supported wallet detected/);
  assert.doesNotMatch(html, /Start live session/);
});

test("live authorization remains explicitly disabled even with an authenticated owner identity", () => {
  const html = render({
    authorized: true,
    ownerAddress: "0xowner",
    accountAddress: "0xowner",
    network: "Sui mainnet",
    walletName: "Slush",
    supportedAsset: "0xasset::USD::USD · mainnet",
    initialStep: 3,
  });
  assert.match(html, /Authorize and start live/);
  assert.match(html, /Live authorization unavailable/);
  assert.match(html, /disabled/);
  assert.match(html, /Verified order adapter/);
});

test("wallet step reports the selected mainnet identity and only the returned asset", () => {
  const html = render({
    authorized: true,
    ownerAddress: "0xowner",
    accountAddress: "0xowner",
    network: "Sui mainnet",
    walletName: "Slush",
    supportedAsset: "0xasset::USD::USD · mainnet",
  });
  assert.match(html, /Slush/);
  assert.match(html, /Sui mainnet/);
  assert.match(html, /0xowner/);
  assert.match(html, /0xasset::USD::USD/);
  assert.match(html, /Identity verification only/);
});

test("experimental strategy exposes the exact explicit consent in guided review", () => {
  const html = render({
    policy: { ...defaultAgentPolicy, signalSource: "EXPERIMENTAL_QUALIFICATION_GATES" },
    authorized: true,
    dirty: true,
    initialStep: 2,
  });
  assert.match(html, /I understand this qualification-gates strategy is uncalibrated and I explicitly choose it/);
  assert.doesNotMatch(html, /model confidence|champion performance|profitability threshold/i);
  assert.match(html, /Save reviewed policy/);
});
