import React, { useState } from "react";
import { Check, ChevronLeft, ChevronRight, CircleHelp, LockKeyhole, ShieldCheck, Wallet } from "lucide-react";
import type { AgentPolicy } from "../../shared/agent-policy";
import { AGENT_SESSION_DURATIONS, mistToSui, suiToMist } from "./agent-format";

type AccountOption = { accountId: string };
type Props = {
  policy: AgentPolicy;
  onPolicyChange: (update: (policy: AgentPolicy) => AgentPolicy) => void;
  authorized: boolean;
  ownerAddress: string;
  network: string;
  accountAddress: string;
  walletName: string;
  wallets: { name: string }[];
  onConnect: (index: number) => void;
  accounts: AccountOption[];
  accountId?: string | null;
  onRefreshAsset: () => void;
  onSelectAccount: (accountId: string) => void;
  supportedAsset: string | null;
  settlementDecimals?: number;
  busy: string;
  dirty: boolean;
  onSave: () => void;
  fundingAmount: string;
  onFundingAmountChange: (value: string) => void;
  usdcFundingAmount: string;
  onUsdcFundingAmountChange: (value: string) => void;
  coinObjectIds: string;
  onCoinObjectIdsChange: (value: string) => void;
  onOwnerAction: (action: string, extra?: Record<string, unknown>) => void;
  simulationPassed: boolean;
  pendingAction: string;
  pendingDescription: string;
  pendingTransaction: string;
  ownerChoice: boolean;
  onOwnerChoiceChange: (value: boolean) => void;
  onPrepare: () => void;
  onApprove: () => void;
  uncertainDigest: string;
  ownerSubmissionPending: boolean;
  onRetryConfirmation: () => void;
  ownerSetupSigning: boolean;
  readiness: { blocker?: string | null; nextAction?: string | null; items?: { id: string; label: string; status: string; evidence?: string; nextAction?: string }[] } | null;
  capabilitiesAvailable: boolean;
  onRetryCapabilities: () => void;
  technicalBlockers: string[];
  capabilitySummary: string[];
  notice?: string;
  initialStep?: number;
  discoveryStatus?: "idle" | "loading" | "success" | "error";
  discoveryError?: string;
  availableBalanceUsd?: string | null;
  fundingAvailable?: boolean;
  fundingAssetLabel?: string;
  delegateStatus?: "unavailable" | "authorized" | "expired" | "not-authorized";
  onTryShadow?: () => void;
  onQuickOwnerAction?: (action: string, extra?: Record<string, unknown>) => void;
  experimentalConfirmed?: boolean;
  onExperimentalConfirmedChange?: (v: boolean) => void;
  compoundingConfirmed?: boolean;
  onCompoundingConfirmedChange?: (v: boolean) => void;
};

const usd = (cents: number | null | undefined) => cents == null ? "Not set" : `$${(cents / 100).toFixed(2)}`;
const shortId = (value: string, lead = 8, tail = 5) => value.length > lead + tail + 3 ? `${value.slice(0, lead)}…${value.slice(-tail)}` : value;
const dollarsToCents = (value: string) => /^\d+(?:\.\d{0,2})?$/.test(value) && Number(value) > 0 ? Math.round(Number(value) * 100) : null;
const supportedAmount = (value: string, decimals: number | undefined) => decimals != null &&
  new RegExp(`^\\d+(?:\\.\\d{0,${decimals}})?$`).test(value) && Number(value) > 0;
const steps = ["Connect", "Fund", "Strategy", "Start"];

export default function GuidedAgentSetup(props: Props) {
  const [step, setStep] = useState(() => Math.max(0, Math.min(3, props.initialStep ?? 0)));
  const [chosenStrategy, setStrategyChoice] = useState("");
  const strategyChoice = chosenStrategy || (props.policy.frequency === "EVERY_ELIGIBLE_ROUND" &&
    props.policy.compound && props.policy.sizingMode === "AVAILABLE_PERCENT" ? "Continuous" :
    props.policy.sizingMode === "AVAILABLE_PERCENT" && !props.policy.compound && props.policy.sizingPercent === 5 ? "Conservative" :
    props.policy.sizingMode === "AVAILABLE_PERCENT" && !props.policy.compound && props.policy.sizingPercent === 10 ? "Balanced" : "Custom");
  const [customOpen, setCustomOpen] = useState(false);
  const [localExperimental, setLocalExperimental] = useState(false);
  const [localCompounding, setLocalCompounding] = useState(false);
  const [dailyLossInput, setDailyLossInput] = useState(props.policy.dailyLoss?.mode === "AMOUNT" ? (props.policy.dailyLoss.value / 100).toFixed(2) : "");
  const [targetInput, setTargetInput] = useState(props.policy.targetCents == null ? "" : (props.policy.targetCents / 100).toFixed(2));
  const [advancedTouched, setAdvancedTouched] = useState(false);
  const discoveryStatus = props.discoveryStatus ?? "idle";
  const experimentalConfirmed = props.experimentalConfirmed ?? localExperimental;
  const compoundingConfirmed = props.compoundingConfirmed ?? localCompounding;
  const accountReady = !!props.accountId && props.accounts.some(item => item.accountId === props.accountId);
  const discovered = props.authorized && discoveryStatus === "success";
  const canCreateAccount = discovered && props.accounts.length === 0;
  const balanceNumber = props.availableBalanceUsd == null ? null : Number(props.availableBalanceUsd);
  const hasBalance = balanceNumber != null && Number.isFinite(balanceNumber) && balanceNumber > 0;
  const funded = hasBalance;
  const fundingAmountValid = supportedAmount(props.fundingAmount, props.settlementDecimals);
  const usdcAmountValid = supportedAmount(props.usdcFundingAmount, 6);
  const balanceLabel = balanceNumber == null || !Number.isFinite(balanceNumber) ? "Balance unavailable" : `$${balanceNumber.toFixed(2)}`;
  const experimental = props.policy.signalSource === "EXPERIMENTAL_QUALIFICATION_GATES";
  const canSave = props.dirty && (!experimental || experimentalConfirmed) && (!props.policy.compound || compoundingConfirmed) && !props.busy;
  const startReady = props.authorized && accountReady && funded && !!strategyChoice;
  const stageDone = [
    props.authorized && discovered && accountReady,
    accountReady && funded,
    props.authorized && !props.dirty,
    false,
  ];

  const setExperimentalConsent = (value: boolean) => {
    if (props.onExperimentalConfirmedChange) props.onExperimentalConfirmedChange(value);
    else setLocalExperimental(value);
  };
  const setCompoundConsent = (value: boolean) => {
    if (props.onCompoundingConfirmedChange) props.onCompoundingConfirmedChange(value);
    else setLocalCompounding(value);
  };
  const updatePolicy = (update: (policy: AgentPolicy) => AgentPolicy) => props.onPolicyChange(update);

  const chooseStrategy = (name: "Conservative" | "Balanced" | "Continuous" | "Custom") => {
    setStrategyChoice(name);
    setCustomOpen(name === "Custom");
    if (name === "Continuous") setCompoundConsent(false);
    updatePolicy(policy => {
      if (name === "Conservative") return {
        ...policy, signalSource: "BLUEWATER_CHAMPION", frequency: "SELECTIVE", selectiveMinProbability: 0.65,
        edgeEnabled: true, minimumEdgePp: 6, sizingMode: "AVAILABLE_PERCENT", sizingPercent: 5, compound: false,
        dailyLoss: policy.dailyLoss ?? { mode: "AMOUNT", value: 400 },
      };
      if (name === "Balanced") return {
        ...policy, signalSource: "BLUEWATER_CHAMPION", frequency: "SELECTIVE", selectiveMinProbability: 0.6,
        edgeEnabled: true, minimumEdgePp: 5, sizingMode: "AVAILABLE_PERCENT", sizingPercent: 10, compound: false,
        dailyLoss: policy.dailyLoss ?? { mode: "AMOUNT", value: 500 },
      };
      if (name === "Continuous") return {
        ...policy, signalSource: "BLUEWATER_CHAMPION", frequency: "EVERY_ELIGIBLE_ROUND",
        sizingMode: "AVAILABLE_PERCENT", sizingPercent: 10, compound: true,
        dailyTurnoverCents: null, edgeEnabled: true, minimumEdgePp: 4,
      };
      return policy;
    });
  };

  const beginConnect = () => {
    const index = props.wallets.findIndex(wallet => /slush/i.test(wallet.name));
    if (index >= 0) props.onConnect(index);
  };
  const submitFunding = (kind: "FUND" | "FUND_USDC", amount: string) => {
    const amountHuman = amount;
    const ids = props.coinObjectIds.split(",").map(value => value.trim()).filter(Boolean);
    const extra = { amountHuman, ...(kind === "FUND" && ids.length ? { coinObjectIds: ids } : {}) };
    if (props.onQuickOwnerAction) props.onQuickOwnerAction(kind, extra);
    else props.onOwnerAction(kind, extra);
  };
  const createAccount = () => {
    if (props.onQuickOwnerAction) props.onQuickOwnerAction("CREATE_ACCOUNT");
    else props.onOwnerAction("CREATE_ACCOUNT");
  };
  const mayAdvance = (next: number) => {
    if (next <= step) return true;
    if (next === 1) return stageDone[0];
    if (next === 2) return stageDone[0] && stageDone[1];
    if (next === 3) return stageDone[0] && stageDone[1] && stageDone[2];
    return false;
  };
  const goTo = (next: number) => { if (mayAdvance(next)) setStep(next); };
  const setDailyLoss = (value: string) => {
    setDailyLossInput(value);
    if (!value) updatePolicy(policy => ({ ...policy, dailyLoss: null }));
    else {
      const cents = dollarsToCents(value);
      if (cents != null) updatePolicy(policy => ({ ...policy, dailyLoss: { mode: "AMOUNT", value: cents } }));
    }
  };
  const setTarget = (value: string) => {
    setTargetInput(value);
    if (!value) updatePolicy(policy => ({ ...policy, targetCents: null }));
    else {
      const cents = dollarsToCents(value);
      if (cents != null) updatePolicy(policy => ({ ...policy, targetCents: cents }));
    }
  };

  return <section className="agent-onboarding" aria-labelledby="onboarding-title">
    <header className="ao-header">
      <div className="ao-brand"><span className="ao-mark" aria-hidden="true"><i /><i /><i /></span><span>BLUEWATER <b>AGENT</b></span></div>
      <span className="ao-beta">MAINNET SETUP</span>
    </header>
    <div className="ao-intro">
      <div className="ao-kicker">A WALLET-OWNED BTC ROUND AGENT</div>
      <h2 id="onboarding-title">Your wallet.<br /><em>Your call.</em></h2>
      <p>Four clear choices. Your funds stay in your WaterX account, and nothing starts without your approval.</p>
    </div>
    <nav className="ao-progress" aria-label="Setup progress">
      {steps.map((label, index) => <button key={label} type="button" className={`ao-progress-step ${step === index ? "is-current" : ""} ${stageDone[index] ? "is-done" : ""}`} onClick={() => goTo(index)} aria-current={step === index ? "step" : undefined} aria-disabled={!mayAdvance(index)}>
        <span className="ao-progress-number">{stageDone[index] ? <Check size={14} strokeWidth={2.5} /> : `0${index + 1}`}</span><span>{label}</span>
      </button>)}
    </nav>

    <main className="ao-card">
      {step === 0 && <section className="ao-stage" aria-labelledby="connect-title">
        <div className="ao-stage-heading"><span className="ao-stage-index">01 / CONNECT</span><h3 id="connect-title">Start with your wallet.</h3><p>Slush verifies your owner identity. It does not ask you to approve a transaction.</p></div>
        {!props.authorized ? <div className="ao-connect-box">
          <div className="ao-wallet-icon"><Wallet size={23} /></div>
          <div className="ao-connect-copy"><strong>Connect Slush</strong><span>Recommended · Sui wallet</span></div>
          <button type="button" className="ao-button ao-button-primary" disabled={!props.wallets.some(wallet => /slush/i.test(wallet.name)) || !!props.busy} onClick={beginConnect}>
            {props.busy === "connect" ? "Connecting…" : "Connect Slush"}
          </button>
          {!props.wallets.some(wallet => /slush/i.test(wallet.name)) && <p className="ao-muted">Slush is not detected in this browser.</p>}
          {props.wallets.length > 0 && <details className="ao-wallet-fallback"><summary>Choose another supported wallet</summary>
            <select aria-label="Choose supported wallet" value="" disabled={!!props.busy} onChange={event => {
              const index = Number(event.target.value);
              if (event.target.value !== "" && Number.isInteger(index)) props.onConnect(index);
            }}><option value="">Select wallet</option>{props.wallets.map((item, index) => <option key={`${item.name}-${index}`} value={index}>{item.name}</option>)}</select>
          </details>}
        </div> : <div className="ao-connected">
          <div className="ao-success-icon"><Check size={18} /></div>
          <div><strong>{props.walletName || "Wallet"} connected</strong><span>{shortId(props.ownerAddress || props.accountAddress || "Owner address unavailable")}</span><small>{props.network || "Network not reported"}</small></div>
          <span className="ao-live-status">CONNECTED</span>
        </div>}
        {props.authorized && <div className="ao-discovery">
          <div className="ao-discovery-label"><span>WATERX ACCOUNT</span>{discoveryStatus === "loading" && <span className="ao-pulse">Checking</span>}</div>
          {discoveryStatus === "loading" && <div className="ao-discovery-message"><span className="ao-skeleton" />Finding accounts owned by your wallet…</div>}
          {discoveryStatus === "error" && <div className="ao-alert" role="alert"><span>We couldn’t check your WaterX accounts.</span><small>No account was created. Try again when the connection is available.</small>
            <button type="button" className="ao-button ao-button-secondary" disabled={!!props.busy} onClick={props.onRefreshAsset}>{props.busy === "accounts" ? "Checking…" : "Try again"}</button>
            {props.discoveryError && <details className="ao-tech"><summary>Technical details</summary><p>{props.discoveryError}</p></details>}
          </div>}
          {discoveryStatus === "idle" && <div className="ao-discovery-message">Account check will begin after your wallet connects.</div>}
          {discovered && props.accounts.length > 0 && <div className="ao-account-found">
            <Check size={17} /><div><strong>{props.accounts.length === 1 ? "WaterX account found" : "Choose a WaterX account"}</strong>
              {props.accounts.length === 1 ? <span>{shortId(props.accountId || props.accounts[0].accountId)}</span> : <select aria-label="Select WaterX account" value={props.accountId ?? ""} disabled={!!props.busy} onChange={event => event.target.value && props.onSelectAccount(event.target.value)}>
                <option value="">Choose account</option>{props.accounts.map(option => <option key={option.accountId} value={option.accountId}>{shortId(option.accountId, 14, 8)}</option>)}
              </select>}
            </div>
            {props.accounts.length === 1 && <span className="ao-account-state">{accountReady ? "SELECTED" : "Selecting…"}</span>}
          </div>}
          {canCreateAccount && <div className="ao-zero-account"><div><strong>No WaterX account found</strong><span>We checked successfully. Create one to continue.</span></div>
            <button type="button" className="ao-button ao-button-secondary" disabled={!props.authorized || props.ownerSubmissionPending || !!props.busy} onClick={createAccount}>{props.busy === "simulate" ? "Preparing review…" : "Create WaterX account"}</button>
          </div>}
        </div>}
        <div className="ao-reassurance"><LockKeyhole size={15} /><span>Your wallet connection does not move funds or grant trading access.</span></div>
        {props.notice && <p className="ao-notice" role="status">{props.notice}</p>}
        {(props.pendingAction || props.pendingDescription) && <OwnerReview {...props} />}
        <div className="ao-shadow-card ao-connect-shadow"><div><span className="ao-shadow-label">NO REAL MONEY TRADES</span><strong>Explore the agent safely</strong><p>Shadow mode does not sign or submit orders.</p></div>
          <button type="button" className="ao-button ao-button-secondary" disabled={!props.onTryShadow} onClick={() => props.onTryShadow?.()}>Try shadow mode</button>
        </div>
      </section>}

      {step === 1 && <section className="ao-stage" aria-labelledby="fund-title">
        <div className="ao-stage-heading"><span className="ao-stage-index">02 / FUND</span><h3 id="fund-title">Choose what to add.</h3><p>Funds stay in your WaterX account. Review the exact transaction in Slush before approving.</p></div>
        {!accountReady ? <div className="ao-empty-state"><CircleHelp size={22} /><strong>Connect and select your account first.</strong><span>We’ll show its balance here when it’s available.</span><button type="button" className="ao-button ao-button-secondary" onClick={() => setStep(0)}>Back to Connect</button></div> :
          <div className="ao-fund-panel">
            <div className="ao-balance"><span>AVAILABLE WATERX BALANCE</span><strong>{balanceLabel}</strong><small>{props.fundingAssetLabel || props.supportedAsset || "Asset details unavailable"}</small></div>
            {funded && <div className="ao-funded-note"><Check size={15} />WaterX funds available.</div>}
            <label className="ao-field-label">Choose amount to add</label>
            <div className="ao-presets" role="group" aria-label="Funding amount presets">
              {["10", "25", "50", "100"].map(value => <button type="button" key={value} className={props.fundingAmount === value ? "is-selected" : ""} aria-pressed={props.fundingAmount === value} onClick={() => props.onFundingAmountChange(value)}>${value}</button>)}
              <label className={`ao-custom-preset ${!["10", "25", "50", "100"].includes(props.fundingAmount) ? "is-selected" : ""}`}>Custom<input aria-label="Custom funding amount in dollars" inputMode="decimal" placeholder="Other" value={["10", "25", "50", "100"].includes(props.fundingAmount) ? "" : props.fundingAmount} onChange={event => props.onFundingAmountChange(event.target.value)} /></label>
            </div>
            <div className="ao-funding-amount"><span>$</span><input aria-label="Funding amount in dollars" inputMode="decimal" value={props.fundingAmount} onChange={event => props.onFundingAmountChange(event.target.value)} /><small>USD</small></div>
            <div className="ao-asset-line"><span>Funding asset</span><strong>{props.fundingAssetLabel || props.supportedAsset || "Not reported"}</strong></div>
            {props.settlementDecimals == null && <p className="ao-inline-hint">Funding asset details are still being checked. We won’t guess the balance or amount.</p>}
            <button type="button" className="ao-button ao-button-primary ao-full-button" disabled={!props.authorized || !accountReady || !fundingAmountValid || props.ownerSubmissionPending || !!props.busy} onClick={() => submitFunding("FUND", props.fundingAmount)}>
              {props.busy === "simulate" ? "Preparing review…" : "Add funds"}
            </button>
            <p className="ao-button-caption">This prepares an owner review. It does not mark funding complete.</p>
            {props.notice && <p className="ao-notice" role="status">{props.notice}</p>}
            {(props.pendingAction || props.pendingDescription) && <OwnerReview {...props} />}
            <details className="ao-more-funding"><summary>Other funding option</summary>
              <label className="ao-small-field">USDC amount<input inputMode="decimal" value={props.usdcFundingAmount} onChange={event => props.onUsdcFundingAmountChange(event.target.value)} placeholder="0.00" /></label>
              <button type="button" className="ao-button ao-button-secondary" disabled={!accountReady || !props.authorized || !usdcAmountValid || props.ownerSubmissionPending || !!props.busy} onClick={() => submitFunding("FUND_USDC", props.usdcFundingAmount)}>Review USDC conversion</button>
            </details>
            <details className="ao-tech ao-transaction-details"><summary>Transaction details</summary><p>Owner coin selection and protocol values are handled in the review step. You do not need to find or enter coin object IDs.</p>
              <label className="ao-small-field">Optional coin IDs<input value={props.coinObjectIds} onChange={event => props.onCoinObjectIdsChange(event.target.value)} placeholder="Only if supplied by your wallet flow" /></label>
            </details>
          </div>}
      </section>}

      {step === 2 && <section className="ao-stage" aria-labelledby="strategy-title">
        <div className="ao-stage-heading"><span className="ao-stage-index">03 / STRATEGY</span><h3 id="strategy-title">How should it trade?</h3><p>Choose a starting plan. You can review every limit before saving.</p></div>
        <div className="ao-strategy-list">
          {([
            { name: "Conservative", tag: "LOWER ACTIVITY", summary: "Trades selectively, with a stronger edge filter and smaller positions." },
            { name: "Balanced", tag: "STEADY", summary: "Selects qualifying rounds with moderate sizing and loss protection." },
            { name: "Continuous", tag: "EVERY ELIGIBLE ROUND", summary: "Considers every eligible round, compounds available balance, and has no daily turnover cap." },
            { name: "Custom", tag: "MAKE IT YOURS", summary: "Set the full policy, including the advanced risk limits." },
          ] as const).map(item => <button key={item.name} type="button" className={`ao-strategy-card ${strategyChoice === item.name ? "is-selected" : ""}`} aria-pressed={strategyChoice === item.name} onClick={() => chooseStrategy(item.name)}>
            <span className="ao-strategy-top"><strong>{item.name}</strong><span>{item.tag}</span></span><span className="ao-strategy-summary">{item.summary}</span>
          </button>)}
        </div>
        {strategyChoice === "Continuous" && <div className="ao-continuous-controls">
          <div className="ao-control-intro"><strong>Continuous essentials</strong><span>These changes apply only because you chose this strategy.</span></div>
          <div className="ao-toggle-row"><div><strong>Trade each eligible round</strong><span>When the round meets your safety rules.</span></div><span className="ao-toggle-on">ON</span></div>
          <label className="ao-inline-control"><span>Minimum edge</span><span className="ao-edge-input"><input type="number" min="0" max="100" step="0.5" value={props.policy.minimumEdgePp} onChange={event => updatePolicy(policy => ({ ...policy, minimumEdgePp: Number(event.target.value), edgeEnabled: true }))} />%</span></label>
          <label className="ao-inline-control"><span>Position size</span><span className="ao-edge-input"><input type="number" min="0.1" max="100" step="0.5" value={props.policy.sizingPercent} onChange={event => updatePolicy(policy => ({ ...policy, sizingPercent: Number(event.target.value), sizingMode: "AVAILABLE_PERCENT" }))} />% of available balance</span></label>
          <label className="ao-toggle-row ao-check-row"><span><strong>Compound profits</strong><small>Uses available balance to calculate future positions.</small></span><input type="checkbox" checked={props.policy.compound} onChange={event => { const value = event.target.checked; setCompoundConsent(false); updatePolicy(policy => ({ ...policy, compound: value })); }} /></label>
          <label className="ao-inline-control"><span>Daily turnover</span><select value={props.policy.dailyTurnoverCents === null ? "unlimited" : "limited"} onChange={event => updatePolicy(policy => ({ ...policy, dailyTurnoverCents: event.target.value === "unlimited" ? null : (policy.dailyTurnoverCents ?? 1000) }))}><option value="unlimited">Unlimited</option><option value="limited">Limited</option></select></label>
          {props.policy.dailyTurnoverCents !== null && <label className="ao-inline-control"><span>Daily turnover limit</span><span className="ao-edge-input"><span>$</span><input type="number" min="1" step="1" value={(props.policy.dailyTurnoverCents / 100).toFixed(2)} onChange={event => { const cents = dollarsToCents(event.target.value); if (cents != null) updatePolicy(policy => ({ ...policy, dailyTurnoverCents: cents })); }} /></span></label>}
          <label className="ao-small-field">Maximum daily loss · optional<input inputMode="decimal" placeholder="No daily loss limit" value={dailyLossInput} onChange={event => setDailyLoss(event.target.value)} /></label>
          <label className="ao-small-field">Pause at balance · optional<input inputMode="decimal" placeholder="No balance target" value={targetInput} onChange={event => setTarget(event.target.value)} /></label>
        </div>}
        {(strategyChoice === "Conservative" || strategyChoice === "Balanced") && <div className="ao-selection-note"><ShieldCheck size={17} /><span>Existing session, order, exposure, timing and slippage limits remain in place.</span></div>}
        <details className="ao-advanced-settings" open={customOpen || advancedTouched} onToggle={event => { setAdvancedTouched(event.currentTarget.open); }}>
          <summary onClick={() => { if (strategyChoice !== "Custom") setStrategyChoice("Custom"); }}>Advanced settings</summary>
          <div className="ao-advanced-body">
            {strategyChoice !== "Custom" && <p>These controls edit your current draft. Presets above set only their named strategy values; other safeguards are preserved.</p>}
            <div className="ao-control-grid">
              <label className="ao-small-field">Round frequency<select value={props.policy.frequency} onChange={event => updatePolicy(policy => ({ ...policy, frequency: event.target.value as AgentPolicy["frequency"] }))}><option value="SELECTIVE">Selective</option><option value="EVERY_ELIGIBLE_ROUND">Every eligible round</option></select></label>
              <label className="ao-small-field">Minimum edge filter<select value={String(props.policy.edgeEnabled)} onChange={event => updatePolicy(policy => ({ ...policy, edgeEnabled: event.target.value === "true" }))}><option value="true">On</option><option value="false">Off</option></select></label>
              <label className="ao-small-field">Signal source<select value={props.policy.signalSource} onChange={event => updatePolicy(policy => ({ ...policy, signalSource: event.target.value as AgentPolicy["signalSource"] }))}><option value="BLUEWATER_CHAMPION">Bluewater champion</option><option value="EXPERIMENTAL_QUALIFICATION_GATES">Experimental qualification gates</option></select></label>
              {experimental && <label className="ao-consent"><input type="checkbox" checked={experimentalConfirmed} onChange={event => setExperimentalConsent(event.target.checked)} /><span><strong>Confirm experimental strategy</strong><small>These qualification gates are experimental and are not a profitability claim.</small></span></label>}
              {props.policy.frequency === "SELECTIVE" && <label className="ao-small-field">Minimum probability<input type="number" min="0.5" max="1" step="0.01" value={props.policy.selectiveMinProbability} onChange={event => updatePolicy(policy => ({ ...policy, selectiveMinProbability: Number(event.target.value) }))} /></label>}
              <label className="ao-small-field">BTC round intervals<select value={props.policy.intervals.join(",")} onChange={event => updatePolicy(policy => ({ ...policy, intervals: event.target.value.split(",").map(Number) as AgentPolicy["intervals"] }))}><option value="5,15">5 and 15 minutes</option><option value="5">5 minutes</option><option value="15">15 minutes</option></select></label>
              <label className="ao-small-field">Sizing method<select value={props.policy.sizingMode} onChange={event => updatePolicy(policy => ({ ...policy, sizingMode: event.target.value as AgentPolicy["sizingMode"] }))}><option value="FIXED">Fixed amount</option><option value="AVAILABLE_PERCENT">Percent of available balance</option><option value="ALLOCATION_PERCENT">Percent of original allocation</option></select></label>
              {props.policy.sizingMode === "FIXED" ? <label className="ao-small-field">Fixed order amount ($)<input type="number" min="1" step="0.01" value={(props.policy.fixedCents / 100).toFixed(2)} onChange={event => { const cents = dollarsToCents(event.target.value); if (cents != null) updatePolicy(policy => ({ ...policy, fixedCents: cents })); }} /></label> : <label className="ao-small-field">Position size (%)<input type="number" min="0.1" max="100" step="0.1" value={props.policy.sizingPercent} onChange={event => updatePolicy(policy => ({ ...policy, sizingPercent: Number(event.target.value) }))} /></label>}
              {props.policy.sizingMode === "ALLOCATION_PERCENT" && <label className="ao-small-field">Original allocation ($)<input type="number" min="1" step="0.01" value={(props.policy.allocationCents / 100).toFixed(2)} onChange={event => { const cents = dollarsToCents(event.target.value); if (cents != null) updatePolicy(policy => ({ ...policy, allocationCents: cents })); }} /></label>}
              <label className="ao-small-field">Compounding<select value={String(props.policy.compound)} onChange={event => { const value = event.target.value === "true"; setCompoundConsent(false); updatePolicy(policy => ({ ...policy, compound: value })); }}><option value="false">Off</option><option value="true">On</option></select></label>
              <label className="ao-small-field">Maximum daily loss<select value={props.policy.dailyLoss?.mode ?? "NONE"} onChange={event => updatePolicy(policy => ({ ...policy, dailyLoss: event.target.value === "NONE" ? null : { mode: event.target.value as "AMOUNT" | "PERCENT", value: policy.dailyLoss?.value ?? 400 } }))}><option value="NONE">Off</option><option value="AMOUNT">Dollar amount</option><option value="PERCENT">Percent</option></select><input type="number" min="0.1" value={props.policy.dailyLoss?.value ?? ""} disabled={!props.policy.dailyLoss} onChange={event => updatePolicy(policy => ({ ...policy, dailyLoss: policy.dailyLoss ? { ...policy.dailyLoss, value: Number(event.target.value) } : null }))} /></label>
              <label className="ao-small-field">Pause at balance ($)<input type="number" min="0" step="0.01" value={props.policy.targetCents == null ? "" : (props.policy.targetCents / 100).toFixed(2)} onChange={event => { const cents = dollarsToCents(event.target.value); updatePolicy(policy => ({ ...policy, targetCents: event.target.value === "" ? null : cents ?? policy.targetCents })); }} /></label>
              <label className="ao-small-field">Daily profit target ($)<input type="number" min="0" step="0.01" value={props.policy.dailyProfitTargetCents == null ? "" : (props.policy.dailyProfitTargetCents / 100).toFixed(2)} onChange={event => { const cents = dollarsToCents(event.target.value); updatePolicy(policy => ({ ...policy, dailyProfitTargetCents: event.target.value === "" ? null : cents ?? policy.dailyProfitTargetCents })); }} /></label>
              <label className="ao-small-field">At profit target<select value={props.policy.dailyProfitAction} onChange={event => updatePolicy(policy => ({ ...policy, dailyProfitAction: event.target.value as AgentPolicy["dailyProfitAction"] }))}><option value="PAUSE">Pause</option><option value="CONTINUE">Continue</option></select></label>
              <label className="ao-small-field">Round collateral limit ($)<input type="number" min="1" step="0.01" value={(props.policy.roundCollateralCents / 100).toFixed(2)} onChange={event => { const cents = dollarsToCents(event.target.value); if (cents != null) updatePolicy(policy => ({ ...policy, roundCollateralCents: cents })); }} /></label>
              <label className="ao-small-field">Minimum win return ($)<input type="number" min="0.01" step="0.01" value={(props.policy.minimumWinningReturnCents / 100).toFixed(2)} onChange={event => { const cents = dollarsToCents(event.target.value); if (cents != null) updatePolicy(policy => ({ ...policy, minimumWinningReturnCents: cents })); }} /></label>
              <label className="ao-small-field">Preferred win return ($)<input type="number" min="0.01" step="0.01" value={(props.policy.preferredWinningReturnCents / 100).toFixed(2)} onChange={event => { const cents = dollarsToCents(event.target.value); if (cents != null) updatePolicy(policy => ({ ...policy, preferredWinningReturnCents: cents })); }} /></label>
              <label className="ao-small-field">Signal freshness (ms)<input type="number" min="1000" max="60000" value={props.policy.maxSignalAgeMs} onChange={event => updatePolicy(policy => ({ ...policy, maxSignalAgeMs: Number(event.target.value) }))} /></label>
              <label className="ao-small-field">Minimum edge<input type="number" min="0" max="100" step="0.5" value={props.policy.minimumEdgePp} onChange={event => updatePolicy(policy => ({ ...policy, edgeEnabled: true, minimumEdgePp: Number(event.target.value) }))} /></label>
              <label className="ao-small-field">Minimum edge filter<select value={String(props.policy.edgeEnabled)} onChange={event => updatePolicy(policy => ({ ...policy, edgeEnabled: event.target.value === "true" }))}><option value="true">On</option><option value="false">Off</option></select></label>
              <label className="ao-small-field">Daily turnover ($)<input type="number" min="0" step="1" placeholder="Blank means unlimited" value={props.policy.dailyTurnoverCents == null ? "" : (props.policy.dailyTurnoverCents / 100).toFixed(2)} onChange={event => { const cents = dollarsToCents(event.target.value); updatePolicy(policy => ({ ...policy, dailyTurnoverCents: event.target.value === "" ? null : cents ?? policy.dailyTurnoverCents })); }} /></label>
              <label className="ao-small-field">Per-order maximum ($)<input type="number" min="0" step="0.01" value={props.policy.maxOrderCents == null ? "" : (props.policy.maxOrderCents / 100).toFixed(2)} onChange={event => { const cents = dollarsToCents(event.target.value); updatePolicy(policy => ({ ...policy, maxOrderCents: event.target.value === "" ? null : cents ?? policy.maxOrderCents })); }} /></label>
              <label className="ao-small-field">Maximum unresolved exposure<select value={props.policy.maxUnresolved.mode} onChange={event => updatePolicy(policy => ({ ...policy, maxUnresolved: { ...policy.maxUnresolved, mode: event.target.value as "AMOUNT" | "PERCENT" } }))}><option value="AMOUNT">Amount</option><option value="PERCENT">Percent</option></select><input type="number" min="0.1" value={props.policy.maxUnresolved.value} onChange={event => updatePolicy(policy => ({ ...policy, maxUnresolved: { ...policy.maxUnresolved, value: Number(event.target.value) } }))} /></label>
              <label className="ao-small-field">Cash reserve ($)<input type="number" min="0" step="0.01" value={(props.policy.reserveCents / 100).toFixed(2)} onChange={event => { const cents = dollarsToCents(event.target.value); if (cents != null || event.target.value === "0") updatePolicy(policy => ({ ...policy, reserveCents: cents ?? 0 })); }} /></label>
              <label className="ao-small-field">Maximum consecutive losses<input type="number" min="1" value={props.policy.maxConsecutiveLosses ?? ""} onChange={event => updatePolicy(policy => ({ ...policy, maxConsecutiveLosses: event.target.value ? Number(event.target.value) : null }))} /></label>
              <label className="ao-small-field">Maximum drawdown (%)<input type="number" min="0" max="100" value={props.policy.maxDrawdownPercent ?? ""} onChange={event => updatePolicy(policy => ({ ...policy, maxDrawdownPercent: event.target.value ? Number(event.target.value) : null }))} /></label>
              <label className="ao-small-field">Quote freshness (ms)<input type="number" min="100" max="5000" value={props.policy.maxQuoteAgeMs} onChange={event => updatePolicy(policy => ({ ...policy, maxQuoteAgeMs: Number(event.target.value) }))} /></label>
              <label className="ao-small-field">Minimum execution time (ms)<input type="number" min="5000" max="180000" value={props.policy.minRemainingMs} onChange={event => updatePolicy(policy => ({ ...policy, minRemainingMs: Number(event.target.value) }))} /></label>
              <label className="ao-small-field">Slippage limit (bps)<input type="number" min="0" max="500" value={props.policy.slippageBps} onChange={event => updatePolicy(policy => ({ ...policy, slippageBps: Number(event.target.value) }))} /></label>
              <label className="ao-small-field">Transaction expiry (ms)<input type="number" min="1000" max="10000" value={props.policy.orderTtlMs} onChange={event => updatePolicy(policy => ({ ...policy, orderTtlMs: Number(event.target.value) }))} /></label>
              <label className="ao-small-field">Session duration<select value={props.policy.sessionDurationMs} onChange={event => updatePolicy(policy => ({ ...policy, sessionDurationMs: Number(event.target.value) }))}>{AGENT_SESSION_DURATIONS.map(item => <option key={item.milliseconds} value={item.milliseconds}>{item.label}</option>)}</select></label>
              <label className="ao-small-field">Session turnover ($)<input type="number" min="1" step="1" value={(props.policy.sessionTurnoverCents / 100).toFixed(2)} onChange={event => { const cents = dollarsToCents(event.target.value); if (cents != null) updatePolicy(policy => ({ ...policy, sessionTurnoverCents: cents })); }} /></label>
              <label className="ao-small-field">Session loss limit ($)<input type="number" min="1" step="1" value={(props.policy.sessionLossCents / 100).toFixed(2)} onChange={event => { const cents = dollarsToCents(event.target.value); if (cents != null) updatePolicy(policy => ({ ...policy, sessionLossCents: cents })); }} /></label>
              <label className="ao-small-field">Session gas budget (SUI)<input inputMode="decimal" value={mistToSui(props.policy.sessionGasBudgetMist)} onChange={event => { const mist = suiToMist(event.target.value); if (mist != null) updatePolicy(policy => ({ ...policy, sessionGasBudgetMist: mist })); }} /></label>
            </div>
          </div>
        </details>
        {props.policy.compound && <label className="ao-consent ao-compound-consent"><input type="checkbox" checked={compoundingConfirmed} onChange={event => setCompoundConsent(event.target.checked)} /><span><strong>Confirm compounding</strong><small>I understand future position sizing can include available gains. This is a policy setting, not a promise of returns.</small></span></label>}
        <div className="ao-policy-save">
          <div><strong>{props.dirty ? "Draft changes not saved" : "Your saved policy is unchanged"}</strong><span>Saving stores your strategy only. It does not authorize or start the agent.</span></div>
          {props.dirty && <button type="button" className="ao-button ao-button-secondary" disabled={!canSave} onClick={props.onSave}>{props.busy === "policy" ? "Saving…" : "Save strategy"}</button>}
        </div>
        {props.dirty && ((experimental && !experimentalConfirmed) || (props.policy.compound && !compoundingConfirmed)) && <p className="ao-inline-hint">Confirm the selected strategy’s consent above before saving.</p>}
      </section>}

      {step === 3 && <section className="ao-stage" aria-labelledby="start-title">
        <div className="ao-stage-heading"><span className="ao-stage-index">04 / START</span><h3 id="start-title">Your agent, at a glance.</h3><p>Review the plan. Live agent authorization and starting are not available yet.</p></div>
        <div className="ao-summary">
          <div className="ao-summary-title"><span>YOUR AGENT</span><span className="ao-summary-dot">DRAFT</span></div>
          <dl>
            <div><dt>Wallet</dt><dd>{props.walletName || "Not connected"}{props.ownerAddress && <small>{shortId(props.ownerAddress)}</small>}</dd></div>
            <div><dt>WaterX account</dt><dd>{accountReady ? shortId(props.accountId || "") : "Not selected"}</dd></div>
            <div><dt>Available balance</dt><dd>{balanceLabel}</dd></div>
            <div><dt>Strategy</dt><dd>{strategyChoice || "Choose a strategy"}</dd></div>
            <div><dt>Trades</dt><dd>{props.policy.frequency === "EVERY_ELIGIBLE_ROUND" ? "Every eligible round" : "Selective opportunities"} · {props.policy.intervals.join(" / ")}m</dd></div>
            <div><dt>Minimum edge</dt><dd>{props.policy.edgeEnabled ? `${props.policy.minimumEdgePp}%` : "Off"}</dd></div>
            <div><dt>Position</dt><dd>{props.policy.sizingMode === "FIXED" ? usd(props.policy.fixedCents) : `${props.policy.sizingPercent}% of ${props.policy.sizingMode === "AVAILABLE_PERCENT" ? "available balance" : "original allocation"}`}</dd></div>
            <div><dt>Compounding</dt><dd>{props.policy.compound ? "On" : "Off"}</dd></div>
            <div><dt>Daily loss stop</dt><dd>{props.policy.dailyLoss?.mode === "AMOUNT" ? usd(props.policy.dailyLoss.value) : props.policy.dailyLoss?.mode === "PERCENT" ? `${props.policy.dailyLoss.value}%` : "Not set"}</dd></div>
            <div><dt>Balance target</dt><dd>{props.policy.targetCents == null ? "Not set" : usd(props.policy.targetCents)}</dd></div>
          </dl>
        </div>
        <div className="ao-permissions">
          <div className="ao-permission-heading"><ShieldCheck size={19} /><div><strong>BLUEWATER AGENT PERMISSIONS</strong><span>Intended scope · actual delegation is not verified</span></div></div>
          <ul><li><Check size={15} /><span>Intended: place prediction orders in your selected WaterX account</span></li>
            <li><span className="ao-no">×</span><span>Not intended: withdraw or transfer your funds</span></li>
            <li><span className="ao-no">×</span><span>Not intended: change wallet permissions or add delegates</span></li></ul>
          <p>These describe the intended limits. Bluewater has not verified that an on-chain delegation is active or enforces these limits.</p>
        </div>
        <div className="ao-unavailable" role="status">
          <span className="ao-unavailable-mark" />
          <div><strong>Live agent temporarily unavailable</strong><span>Bluewater is completing secure mainnet execution setup. Your wallet remains in control; no trading permission has been activated.</span></div>
        </div>
        <div className="ao-authorize-info"><LockKeyhole size={16} /><div><strong>Automatic trading permission is not available yet.</strong><span>{props.delegateStatus === "authorized" ? "A previous authorization is reported, but live trading is still unavailable." : props.delegateStatus === "expired" ? "Any previous authorization is reported as expired." : "No authorization action is available in this setup."}</span></div></div>
        <button type="button" className="ao-button ao-button-disabled" disabled title="Authorization and live execution are not released.">Authorize Agent · unavailable</button>
        <p className="ao-button-caption">Saving a strategy is not the same as authorizing it or starting trades.</p>
        <div className="ao-shadow-card"><div><span className="ao-shadow-label">NO REAL MONEY TRADES</span><strong>Try the agent in shadow mode</strong><p>See how the experience works without signing or submitting orders.</p></div>
          <button type="button" className="ao-button ao-button-secondary" disabled={!props.onTryShadow} onClick={() => props.onTryShadow?.()}>Try shadow mode</button>
        </div>
        {props.notice && <p className="ao-notice" role="status">{props.notice}</p>}
        <details className="ao-tech ao-diagnostics"><summary>Technical diagnostics</summary>
          <div>{!props.capabilitiesAvailable && <button type="button" className="ao-button ao-button-secondary" disabled={props.busy === "capabilities"} onClick={props.onRetryCapabilities}>{props.busy === "capabilities" ? "Checking…" : "Retry capability report"}</button>}
            <ul>{props.technicalBlockers.map((item, index) => <li key={`block-${index}`}>{item}</li>)}{props.capabilitySummary.map((item, index) => <li key={`cap-${index}`}>{item}</li>)}{props.readiness?.items?.map(item => <li key={`readiness-${item.id}`}><b>{item.label} · {item.status}</b>{item.evidence ? ` — ${item.evidence}` : ""}{item.nextAction ? ` · next: ${item.nextAction}` : ""}</li>)}</ul>
            {props.readiness?.blocker && <p>Readiness: {props.readiness.blocker}{props.readiness.nextAction ? ` · ${props.readiness.nextAction}` : ""}</p>}
            <p>Gas: {props.policy.sessionGasBudgetMist.toLocaleString()} MIST · Settlement decimals: {props.settlementDecimals ?? "not reported"}</p>
          </div>
        </details>
      </section>}

      <footer className="ao-footer">
        <button type="button" className="ao-nav-button" disabled={step === 0} onClick={() => setStep(current => Math.max(0, current - 1))}><ChevronLeft size={17} /> Back</button>
        <span>{step + 1} <i>/</i> 4</span>
        {step < 3 ? <button type="button" className="ao-nav-button ao-nav-next" disabled={!mayAdvance(step + 1)} onClick={() => goTo(step + 1)}>Continue <ChevronRight size={17} /></button> : <span className="ao-footer-safe"><LockKeyhole size={13} /> You stay in control</span>}
      </footer>
    </main>
    <p className="ao-under-card"><LockKeyhole size={14} /> No real-money trading starts from setup.</p>
  </section>;
}

function OwnerReview(props: Props) {
  return <details className="ao-owner-review">
    <summary>{props.pendingAction ? `Review prepared action · ${props.pendingAction}` : "Transaction review"}</summary>
    <div className="ao-owner-review-body">
      {props.pendingDescription && <p>{props.pendingDescription}</p>}
      {props.pendingTransaction && <details className="ao-tech"><summary>Transaction details</summary><pre>{props.pendingTransaction}</pre></details>}
      {props.pendingAction && <label className="ao-consent"><input type="checkbox" checked={props.ownerChoice} onChange={event => props.onOwnerChoiceChange(event.target.checked)} /><span><strong>I reviewed this action</strong><small>Confirm the account, asset and simulation before preparing a wallet transaction.</small></span></label>}
      {props.pendingAction && !props.pendingTransaction && <button type="button" className="ao-button ao-button-secondary" disabled={!props.simulationPassed || !props.ownerChoice || !!props.busy} onClick={props.onPrepare}>{props.busy === "prepare" ? "Preparing…" : "Prepare reviewed transaction"}</button>}
      {props.pendingTransaction && <button type="button" className="ao-button ao-button-secondary" disabled={!props.simulationPassed || !props.ownerChoice || props.ownerSubmissionPending || !!props.busy} onClick={props.onApprove}>{props.ownerSubmissionPending ? "Submission unresolved" : props.busy === "sign" ? "Waiting for Slush…" : "Approve in Slush"}</button>}
      {props.ownerSubmissionPending && !props.uncertainDigest && <p className="ao-alert-copy" role="alert">The wallet submission may be unresolved. Do not submit again until it is reconciled.</p>}
      {props.uncertainDigest && <div className="ao-alert-copy" role="status"><span>Confirmation is not verified. Digest: <code>{props.uncertainDigest}</code></span><button type="button" className="ao-button ao-button-secondary" disabled={!!props.busy} onClick={props.onRetryConfirmation}>Retry confirmation only</button></div>}
    </div>
  </details>;
}
