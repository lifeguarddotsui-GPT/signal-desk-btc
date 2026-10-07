import React, { useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight, LockKeyhole, ShieldAlert, Wallet } from "lucide-react";
import type { AgentPolicy } from "../../shared/agent-policy";
import { AGENT_SESSION_DURATIONS, mistToSui, suiToMist } from "./agent-format";

if (typeof document !== "undefined") void import("./agent.css");

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
};

const usd = (cents: number | null | undefined) => cents == null ? "Not set" : `$${(cents / 100).toFixed(2)}`;
const durationLabel = (ms: number) => AGENT_SESSION_DURATIONS.find(item => item.milliseconds === ms)?.label ?? `${Math.round(ms / 60_000)} minutes · saved value`;
const steps = ["Connect Slush", "Owned account", "Review funding", "Set session", "Permissions", "Start"];
const centsFromDollarInput = (value: string) => {
  if (!/^\d+(?:\.\d{0,2})?$/.test(value)) return null;
  const cents = Math.round(Number(value) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
};
const supportedAmount = (value: string, decimals: number | undefined) => decimals != null &&
  new RegExp(`^\\d+(?:\\.\\d{0,${decimals}})?$`).test(value) && Number(value) > 0;

export default function GuidedAgentSetup(props: Props) {
  const [step, setStep] = useState(() => Math.max(0, Math.min(5, props.initialStep ?? 0)));
  const [reviewed, setReviewed] = useState(false);
  const [sessionSpend, setSessionSpend] = useState((props.policy.sessionTurnoverCents / 100).toFixed(2));
  const [gasInput, setGasInput] = useState(mistToSui(props.policy.sessionGasBudgetMist));
  const [minimumReturn, setMinimumReturn] = useState((props.policy.minimumWinningReturnCents / 100).toFixed(2));
  const [preferredReturn, setPreferredReturn] = useState((props.policy.preferredWinningReturnCents / 100).toFixed(2));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const policyReviewKey = JSON.stringify([props.policy.intervals, props.policy.sessionTurnoverCents, props.policy.sessionDurationMs, props.policy.sessionGasBudgetMist, props.policy.signalSource, props.policy.minimumWinningReturnCents, props.policy.preferredWinningReturnCents]);
  useEffect(() => setReviewed(false), [policyReviewKey, props.accountId, props.ownerSetupSigning]);
  useEffect(() => setSessionSpend((props.policy.sessionTurnoverCents / 100).toFixed(2)), [props.policy.sessionTurnoverCents]);
  useEffect(() => setGasInput(mistToSui(props.policy.sessionGasBudgetMist)), [props.policy.sessionGasBudgetMist]);
  useEffect(() => setMinimumReturn((props.policy.minimumWinningReturnCents / 100).toFixed(2)), [props.policy.minimumWinningReturnCents]);
  useEffect(() => setPreferredReturn((props.policy.preferredWinningReturnCents / 100).toFixed(2)), [props.policy.preferredWinningReturnCents]);

  const accountReady = !!props.accountId;
  const liveSetupReady = props.authorized && props.accountAddress !== "" && props.network === "Sui mainnet" &&
    props.ownerSetupSigning && props.simulationPassed && reviewed;
  const fundingDollars = supportedAmount(props.fundingAmount, props.settlementDecimals);
  const usdcDollars = supportedAmount(props.usdcFundingAmount, 6);
  const minimumReturnCents = centsFromDollarInput(minimumReturn);
  const preferredReturnCents = centsFromDollarInput(preferredReturn);
  const returnPreferencesValid = minimumReturnCents != null && preferredReturnCents != null &&
    minimumReturnCents > 0 && preferredReturnCents >= minimumReturnCents;
  const blocker = props.readiness?.blocker || "Owner-controlled setup signing is not verified for this deployment.";
  const nextAction = props.readiness?.nextAction || "Review the reported capability evidence below.";

  return <section className="guided-agent" aria-labelledby="guided-agent-title">
    <div className="guided-head">
      <div><span className="agent-kicker">OWNER-CONTROLLED SETUP / LIVE BETA</span><h2 id="guided-agent-title">One deliberate path to readiness.</h2>
        <p>Connect, choose an owned account, review each setup action, then approve it yourself. No setup action starts trading.</p></div>
      <span className="guided-step-count">0{step + 1} <i>/</i> 06</span>
    </div>
    <nav className="guided-progress" aria-label="Owner setup steps">
      {steps.map((label, index) => <button key={label} type="button" className={step === index ? "active" : step > index ? "complete" : ""} onClick={() => setStep(index)} aria-current={step === index ? "step" : undefined}>
        <b>{step > index ? <Check size={13} /> : `0${index + 1}`}</b><span>{label}</span>
      </button>)}
    </nav>
    <div className="guided-content">
      {step === 0 && <div className="guided-step-panel">
        <div className="guided-step-title"><span>01</span><div><h3>Connect Slush</h3><p>Verify the owner identity on Sui mainnet. Connection requests a personal-message login only; it never requests transaction approval automatically.</p></div></div>
        {!props.authorized ? <div className="guided-wallet-connect">
          <Wallet size={18} /><div><strong>Connect an owner wallet</strong><small>Slush or a compatible Sui wallet-standard wallet on mainnet.</small></div>
          <select aria-label="Choose supported wallet" value="" disabled={!props.wallets.length || !!props.busy} onChange={event => {
            const index = Number(event.target.value);
            if (event.target.value !== "" && Number.isInteger(index)) props.onConnect(index);
          }}><option value="">{props.wallets.length ? "Choose wallet" : "No supported wallet detected"}</option>{props.wallets.map((item, index) => <option key={`${item.name}-${index}`} value={index}>{item.name}</option>)}</select>
        </div> : <div className="guided-facts">
          <div><span>WALLET</span><b>{props.walletName || "Connected wallet"}</b></div><div><span>NETWORK</span><b>{props.network}</b></div>
          <div><span>OWNER</span><b>{props.ownerAddress}</b></div><div><span>IDENTITY SESSION</span><b>Verified · transaction approval remains manual</b></div>
        </div>}
        {props.authorized && <p className="guided-note"><LockKeyhole size={15} /> Wallet session must remain current for each explicit owner approval.</p>}
      </div>}

      {step === 1 && <div className="guided-step-panel">
        <div className="guided-step-title"><span>02</span><div><h3>Select or create an owned account</h3><p>Only account IDs returned by the authenticated accounts endpoint are selectable. No balance is inferred.</p></div></div>
        <div className="guided-account-row">
          <label>WaterX account<select aria-label="Select owned account" value={props.accountId ?? ""} disabled={!props.accounts.length || !!props.busy} onChange={event => event.target.value && props.onSelectAccount(event.target.value)}>
            <option value="">{props.accounts.length ? "Choose returned owned account" : "Refresh to load owned accounts"}</option>
            {props.accounts.map(option => <option key={option.accountId} value={option.accountId}>{option.accountId}</option>)}
          </select></label>
          <button type="button" className="agent-secondary" disabled={!props.authorized || !!props.busy} onClick={props.onRefreshAsset}>{props.busy === "accounts" ? "Loading accounts…" : "Refresh accounts"}</button>
          <button type="button" className="agent-primary" disabled={!props.authorized || props.ownerSubmissionPending || !!props.busy} onClick={() => props.onOwnerAction("CREATE_ACCOUNT")}>{props.busy === "simulate" ? "Preparing review…" : "Review account creation"}</button>
        </div>
        <div className="guided-facts"><div><span>SELECTED ACCOUNT</span><b>{props.accountId || "Not selected"}</b></div><div><span>REPORTED BALANCE</span><b>Not reported · /accounts returns no balance</b></div></div>
        {props.notice && <p className="guided-inline-status" role="status">{props.notice}</p>}
      </div>}

      {step === 2 && <div className="guided-step-panel">
        <div className="guided-step-title"><span>03</span><div><h3>Review funding</h3><p>Enter human-readable dollars. The client converts explicitly to atomic units using the reported settlement decimals or native USDC’s six decimals.</p></div></div>
        <div className="guided-fields">
          <div className="guided-control"><label htmlFor="owner-funding-usd">Settlement-native USD funding</label><div className="guided-input"><span>$</span><input id="owner-funding-usd" inputMode="decimal" placeholder="0.00" value={props.fundingAmount} onChange={event => props.onFundingAmountChange(event.target.value)} /><small>{props.settlementDecimals == null ? "decimals not reported" : `${props.settlementDecimals} decimals reported`}</small></div><small>Human dollar amount; simulation and owner review happen before any wallet prompt.</small>
            <button type="button" className="agent-secondary" disabled={!props.authorized || props.ownerSubmissionPending || !accountReady || !fundingDollars || !!props.busy} onClick={() => props.onOwnerAction("FUND", { amountHuman: props.fundingAmount, coinObjectIds: props.coinObjectIds.split(",").map(value => value.trim()).filter(Boolean) })}>Review settlement funding</button>
          </div>
          <div className="guided-control"><label htmlFor="owner-funding-usdc">Native USDC conversion</label><div className="guided-input"><span>$</span><input id="owner-funding-usdc" inputMode="decimal" placeholder="0.00" value={props.usdcFundingAmount} onChange={event => props.onUsdcFundingAmountChange(event.target.value)} /><small>USDC · 6 decimals</small></div><small>Conversion availability and credited balance must be reported by the service; neither is assumed.</small>
            <button type="button" className="agent-secondary" disabled={!props.authorized || props.ownerSubmissionPending || !accountReady || !usdcDollars || !!props.busy} onClick={() => props.onOwnerAction("FUND_USDC", { amountHuman: props.usdcFundingAmount, coinObjectIds: props.coinObjectIds.split(",").map(value => value.trim()).filter(Boolean) })}>Review USDC conversion</button>
          </div>
        </div>
        <div className="guided-facts"><div><span>SETTLEMENT ASSET</span><b>{props.supportedAsset || "Not reported"}</b></div><div><span>AVAILABLE BALANCE</span><b>Not reported</b></div></div>
        <details className="guided-amount-advanced"><summary>Advanced · optional owner coin object IDs</summary><label>Coin object IDs<input value={props.coinObjectIds} onChange={event => props.onCoinObjectIdsChange(event.target.value)} placeholder="Comma-separated IDs" /></label><small>Only use object IDs you recognize from the connected owner wallet.</small></details>
      </div>}

      {step === 3 && <div className="guided-step-panel">
        <div className="guided-step-title"><span>04</span><div><h3>Set the beta session</h3><p>These are reviewed policy values, not a claim that the session can currently trade.</p></div></div>
        <div className="guided-fields">
          <div className="guided-control"><label>BTC round interval</label><div className="guided-options">{([5, 15] as const).map(minutes => <button type="button" key={minutes} className={props.policy.intervals.includes(minutes) ? "selected" : ""} aria-pressed={props.policy.intervals.includes(minutes)} onClick={() => props.onPolicyChange(policy => ({ ...policy, intervals: policy.intervals.includes(minutes) ? policy.intervals.filter(value => value !== minutes) as AgentPolicy["intervals"] : [...policy.intervals, minutes].sort() as AgentPolicy["intervals"] }))}>{minutes} minutes</button>)}</div></div>
          <div className="guided-control"><label htmlFor="session-cap">Cumulative session budget</label><div className="guided-input"><span>$</span><input id="session-cap" inputMode="decimal" value={sessionSpend} onChange={event => { setSessionSpend(event.target.value); if (/^\d+(?:\.\d{0,2})?$/.test(event.target.value) && Number(event.target.value) > 0) props.onPolicyChange(policy => ({ ...policy, sessionTurnoverCents: Math.round(Number(event.target.value) * 100) })); }} /></div><small>Existing session policy limit. No balance, order or profit is implied.</small></div>
          <div className="guided-control"><label htmlFor="session-duration">Session duration</label><select id="session-duration" value={props.policy.sessionDurationMs} onChange={event => props.onPolicyChange(policy => ({ ...policy, sessionDurationMs: Number(event.target.value) }))}>{AGENT_SESSION_DURATIONS.map(item => <option key={item.milliseconds} value={item.milliseconds}>{item.label}</option>)}</select></div>
          <div className="guided-control"><label htmlFor="session-gas">Gas allowance</label><div className="guided-input"><input id="session-gas" inputMode="decimal" value={gasInput} onChange={event => { setGasInput(event.target.value); const mist = suiToMist(event.target.value); if (mist != null) props.onPolicyChange(policy => ({ ...policy, sessionGasBudgetMist: mist })); }} /><span>SUI</span></div><small>Displayed in SUI; MIST is hidden in advanced diagnostics.</small></div>
          <div className="guided-control"><label htmlFor="minimum-win-return">Minimum preferred total return on a win</label><div className="guided-input"><span>$</span><input id="minimum-win-return" inputMode="decimal" value={minimumReturn} onChange={event => { const value = event.target.value; setMinimumReturn(value); const cents = centsFromDollarInput(value); if (cents != null && cents > 0) props.onPolicyChange(policy => ({ ...policy, minimumWinningReturnCents: cents })); }} /></div><small>Preference only. No forced lock and no order authorization.</small></div>
          <div className="guided-control"><label htmlFor="preferred-win-return">Preferred total return on a win</label><div className="guided-input"><span>$</span><input id="preferred-win-return" inputMode="decimal" value={preferredReturn} onChange={event => { const value = event.target.value; setPreferredReturn(value); const cents = centsFromDollarInput(value); if (cents != null && cents > 0) props.onPolicyChange(policy => ({ ...policy, preferredWinningReturnCents: cents })); }} /></div><small>Not a maximum: better returns are allowed; no return is promised.</small></div>
        </div>
        <div className="guided-review-grid"><div><span>STRATEGY</span><b>{props.policy.signalSource === "BLUEWATER_CHAMPION" ? "Bluewater champion" : "Experimental qualification gates"}</b></div><div><span>ORDER CAP</span><b>{usd(props.policy.maxOrderCents)}</b></div><div><span>SESSION BUDGET</span><b>${(props.policy.sessionTurnoverCents / 100).toFixed(2)}</b></div><div><span>DURATION / GAS</span><b>{durationLabel(props.policy.sessionDurationMs)} · {mistToSui(props.policy.sessionGasBudgetMist)} SUI</b></div><div><span>MINIMUM PREFERRED WIN RETURN</span><b>{usd(props.policy.minimumWinningReturnCents)}</b></div><div><span>PREFERRED WIN RETURN · NOT A MAXIMUM</span><b>{usd(props.policy.preferredWinningReturnCents)}</b></div></div>
        <p className="guided-return-note">Return preferences do not currently change active research qualification or authorize an order. They never force a lock; better returns remain allowed, and no return is promised.</p>
        {!returnPreferencesValid && <p className="guided-error" role="alert">Enter valid dollar preferences, with the preferred return at or above the minimum.</p>}
        <label className="guided-review-check"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /> I reviewed the session values and understand this does not authorize trading.</label>
        {props.dirty && <div className="guided-save-row"><span>Save changes to the owner-reviewed policy. Saving does not start a session.</span><button type="button" className="agent-primary" disabled={!props.authorized || !reviewed || !returnPreferencesValid || !!props.busy} onClick={props.onSave}>{props.busy === "policy" ? "Saving…" : "Save reviewed session"}</button></div>}
      </div>}

      {step === 4 && <div className="guided-step-panel">
        <div className="guided-step-title"><span>05</span><div><h3>Review permissions</h3><p>Setup funding approvals are separate owner-signed transactions. Delegated authorization and automated trading remain unavailable.</p></div></div>
        <div className="guided-permission-state"><ShieldAlert size={18} /><div><b>{props.ownerSetupSigning ? "Owner setup signing capability reported" : "Owner setup signing not verified"}</b><span>{props.ownerSetupSigning ? "Each supported setup action still requires its own explicit Slush approval." : "No signing control is presented until the backend capability verifies this path."}</span></div></div>
        <div className="guided-review-grid"><div><span>OWNER IDENTITY</span><b>{props.authorized ? `${props.walletName} · ${props.network}` : "Not connected"}</b></div><div><span>OWNED ACCOUNT</span><b>{props.accountId || "Not selected"}</b></div><div><span>DELEGATE / AUTOMATION</span><b>Unavailable · no AUTHORIZE flow</b></div><div><span>LIVE ORDER PERMISSION</span><b>Disabled · no trading order submission</b></div></div>
        <div className="guided-owner-review">
          <b>{props.pendingAction ? `Owner action: ${props.pendingAction}` : "No owner transaction is prepared"}</b>
          {props.pendingDescription && <p>{props.pendingDescription}</p>}
          {props.pendingTransaction && <details><summary>Advanced · exact prepared payload</summary><pre>{props.pendingTransaction}</pre></details>}
          {props.pendingAction && <label className="guided-review-check"><input type="checkbox" checked={props.ownerChoice} onChange={event => props.onOwnerChoiceChange(event.target.checked)} /> I reviewed the action, account, asset and simulation. Continue to the separate owner approval control.</label>}
          {props.pendingAction && !props.pendingTransaction && <button type="button" className="agent-primary" disabled={!props.simulationPassed || !props.ownerChoice || !!props.busy} onClick={props.onPrepare}>{props.busy === "prepare" ? "Preparing transaction…" : "Prepare reviewed transaction"}</button>}
          {props.pendingTransaction && <button type="button" className="agent-primary" disabled={!liveSetupReady || props.ownerSubmissionPending || !!props.busy} onClick={props.onApprove}>{props.ownerSubmissionPending ? "Submission unresolved · approval blocked" : props.busy === "sign" ? "Waiting for explicit wallet approval…" : "Approve this setup transaction in Slush"}</button>}
          {props.ownerSubmissionPending && !props.uncertainDigest && <p className="guided-uncertain" role="alert">A wallet submission may be unresolved and no usable digest was returned. Do not submit again; check the owner wallet activity and reconcile before continuing.</p>}
          {props.uncertainDigest && <div className="guided-uncertain" role="status"><span>Transaction may have been signed; confirmation is not yet verified. Digest: <code>{props.uncertainDigest}</code></span><button type="button" className="agent-secondary" disabled={!!props.busy} onClick={props.onRetryConfirmation}>Retry confirmation only</button></div>}
        </div>
        <p className="guided-note"><LockKeyhole size={15} /> The wallet is never prompted on connect, simulation or preparation. Approval is a distinct, user-initiated step.</p>
      </div>}

      {step === 5 && <div className="guided-step-panel">
        <div className="guided-step-title"><span>06</span><div><h3>Start remains locked</h3><p>The setup flow is integrated, but no live start action is exposed until the backend verifies every required execution capability.</p></div></div>
        <div className="guided-blocker" role="status"><span className="guided-blocker-mark" /><div><small>ONE CURRENT BLOCKER</small><strong>{blocker}</strong><small>Next action: {nextAction}</small></div></div>
        <button type="button" className="guided-disabled-start" disabled title="Live execution is not released; no Start action is available.">Live beta session unavailable</button>
        {props.readiness?.items?.length ? <details className="guided-readiness"><summary>Readiness evidence · {props.readiness.items.length} dependencies</summary><ul>{props.readiness.items.map(item => <li key={item.id}><b>{item.label}</b><span>{item.status}</span>{item.evidence && <p>{item.evidence}</p>}{item.nextAction && <small>Next: {item.nextAction}</small>}</li>)}</ul></details> : null}
      </div>}
      {props.pendingAction && step < 4 && <div className="guided-sim-bridge" role="status">
        <span>{props.simulationPassed ? `Simulation passed for ${props.pendingAction}; no transaction has been signed.` : `Review simulation result for ${props.pendingAction} in Permissions.`}</span>
        <button type="button" className="agent-secondary" onClick={() => setStep(4)}>Continue to permission review</button>
      </div>}
      <div className="guided-step-footer">
        <button type="button" className="agent-secondary" disabled={step === 0} onClick={() => setStep(current => Math.max(0, current - 1))}><ChevronLeft size={15} /> Previous</button>
        <span>No setup action starts trading.</span>
        <button type="button" className="agent-secondary" disabled={step === 5} onClick={() => setStep(current => Math.min(5, current + 1))}>Continue <ChevronRight size={15} /></button>
      </div>
    </div>
    <details className="guided-advanced" open={advancedOpen} onToggle={event => setAdvancedOpen(event.currentTarget.open)}>
      <summary>Advanced · diagnostics and protocol values</summary>
      <div className="guided-advanced-content">
        <p>Technical values are diagnostic only; public controls use dollars, SUI and minutes.</p>
        {!props.capabilitiesAvailable && <button type="button" className="agent-secondary" disabled={props.busy === "capabilities"} onClick={props.onRetryCapabilities}>{props.busy === "capabilities" ? "Retrying…" : "Retry capability report"}</button>}
        <ul>{props.technicalBlockers.map((item, index) => <li key={`block-${index}`}>{item}</li>)}{props.capabilitySummary.map((item, index) => <li key={`cap-${index}`}>{item}</li>)}{props.readiness?.items?.map(item => <li key={`readiness-${item.id}`}><b>{item.label} · {item.status}</b>{item.evidence ? ` — ${item.evidence}` : ""}{item.nextAction ? ` · next: ${item.nextAction}` : ""}</li>)}</ul>
        <div className="guided-checklist"><b>Reported setup diagnostics</b><span>Account object: {props.accountId || "not selected"}</span><span>Session gas: {props.policy.sessionGasBudgetMist.toLocaleString()} MIST</span><span>Settlement decimals: {props.settlementDecimals ?? "not reported"}</span></div>
      </div>
    </details>
  </section>;
}
