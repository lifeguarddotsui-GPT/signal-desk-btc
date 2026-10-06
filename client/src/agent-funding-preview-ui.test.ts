import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentFundingPreviewView } from "./AgentFundingPreview";

const preview = {
  status: "CONFIG_REGISTRATION_AND_COIN_METADATA_VERIFIED",
  asOfMs: 1_742_016_000_000,
  network: "sui:mainnet",
  source: "mainnet-config",
  backingCoinType: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  backingDecimals: 6,
  creditCoinType: "0xwaterx::usd::USD",
  creditDecimals: 6,
  vault: "0xvault",
  withdrawalQueue: "0xqueue",
  registeredKeeperCount: 2,
  configuredFees: {
    mintFeeScaled: "1250000",
    burnFeeScaled: "2500000",
    minimumBurnAmountAtomic: "1000000",
    scale: "1000000000 (SDK FLOAT_SCALE)",
    provenance: "Fetched mainnet config; current vault fee-state/dry-run still required.",
  },
  intendedFunding: {
    backingAtomic: "10000000",
    backingAmount: "10 USDC",
    availableGas: "0.5 SUI is availability, not authorization",
    authorizedGasMIST: null,
    aggregateRoundCollateralLimitAtomic: "5000000",
    entryFeesIncluded: true,
  },
  fundingPath: ["Owner USDC coin", "Mint credit to account", "Owned account USD credit"],
  withdrawalPath: ["Owner credit withdrawal request", "Enqueue native withdrawal", "Registered keeper executes", "Verify USDC receipt"],
  winningsPath: ["Verified settlement", "Permission-reviewed claim", "Credit redemption to wallet USDC"],
  sdkValuation: "Native custody SDK documents 1:1 backing credit scaling; USDC and WaterX USD are distinct assets.",
  executablePreview: false as const,
  readyForOwnerApproval: false as const,
  blockers: ["Current vault fee-state verification", "Separate explicit gas limit"],
  semantics: "Configuration and coin metadata only; no funding or withdrawal submitted.",
};

const render = (props: { preview: typeof preview | null; loading?: boolean; error?: string } = { preview }) =>
  renderToStaticMarkup(React.createElement(AgentFundingPreviewView, {
    preview: props.preview, loading: props.loading ?? false, error: props.error ?? "", retry() {},
  }));

test("funding preview distinguishes USDC from USD and shows intention, collateral ceiling, and unapproved gas", () => {
  const html = render();
  assert.match(html, /10 USDC/);
  assert.match(html, /USDC ≠ USD credit/);
  assert.match(html, /≤ \$5 USD credit \/ round/);
  assert.match(html, /0\.5 SUI is availability, not authorization/);
  assert.match(html, /None · separate explicit gas approval required/);
  assert.match(html, /not a wallet balance or deposit/);
  assert.match(html, /not executable/);
  assert.match(html, /Owner approval ready<b>No/);
  assert.doesNotMatch(html, /Sign transaction|Fund account|Approve gas/);
});

test("raw configured fee values and registration provenance stay behind disclosure; withdrawal is queued and keeper-dependent", () => {
  const html = render();
  assert.match(html, /Fetched registration, raw configured fees &amp; full path/);
  assert.match(html, /1250000/);
  assert.match(html, /2500000/);
  assert.match(html, /Fetched mainnet config/);
  assert.match(html, /minimumBurnAmountAtomic|Minimum burn/);
  assert.match(html, /Enqueue native withdrawal/);
  assert.match(html, /Registered keeper executes/);
  assert.match(html, /Withdrawals depend on queued processing and a registered keeper/);
  assert.match(html, /Timing is not promised/);
  assert.doesNotMatch(html, /fee percent|fee rate|% fee/i);
});

test("funding preview failure is isolated and stale preview is retained during optional refresh errors", () => {
  const unavailable = render({ preview: null, error: "temporary read failure" });
  assert.match(unavailable, /temporary read failure/);
  assert.match(unavailable, /Retry/);
  const stale = render({ preview, error: "temporary read failure" });
  assert.match(stale, /showing the last returned funding preview/);
  assert.match(stale, /10 USDC/);
  assert.match(stale, /Owner credit withdrawal request/);
});
