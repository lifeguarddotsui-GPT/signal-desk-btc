import React, { useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight, LockKeyhole, Pause, ShieldAlert, Wallet } from "lucide-react";
import type { AgentPolicy } from "../../shared/agent-policy";
import { AGENT_SESSION_DURATIONS, canStartGuidedShadow, dollarsToSafeCents, mistToSui, paperCapitalFromInput, suiToMist } from "./agent-format";

if (typeof document !== "undefined") void import("./agent.css");

type SetupStatus = "PAUSED" | "SHADOW" | "LOSS_STOP" | "TARGET_REACHED" | "NOT LOADED" | string;
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
  supportedAsset: string | null;
  onRefreshAsset: () => void;
  status: SetupStatus;
  busy: string;
  dirty: boolean;
  onSave: () => void;
  onStartShadow: () => void;
  onPause: () => void;
  paperExists: boolean;
  paperCapital: string;
  onPaperCapitalChange: (value: string) => void;
  experimentalConfirmed: boolean;
  onExperimentalConfirmedChange: (value: boolean) => void;
  compoundingConfirmed: boolean;
  onCompoundingConfirmedChange: (value: boolean) => void;
  everyRoundAck: boolean;
  onEveryRoundAckChange: (value: boolean) => void;
  edgeOffAck: boolean;
  onEdgeOffAckChange: (value: boolean) => void;
  zeroReserveAck: boolean;
  onZeroReserveAckChange: (value: boolean) => void;
  shadowAvailable: boolean;
  onRetryCapabilities: () => void;
  capabilitiesAvailable: boolean;
  initialStep?: number;
  reviewGeneration: string | number;
  blocker: string;
  technicalBlockers: string[];
  capabilitySummary: string[];
};

const dollars = (cents: number | null) => cents == null ? "No cap" : `$${(cents / 100).toFixed(2)}`;
const humanDuration = (milliseconds: number) => AGENT_SESSION_DURATIONS.find(x => x.milliseconds === milliseconds)?.label ?? "Other saved duration";

function GuidedAgentSetup(props: Props) {
  const {
    policy, onPolicyChange, authorized, ownerAddress, network, accountAddress, walletName,
    wallets, onConnect, supportedAsset, onRefreshAsset, status, busy, dirty, onSave,
    onStartShadow, onPause, paperExists, paperCapital, onPaperCapitalChange,
    experimentalConfirmed, onExperimentalConfirmedChange, compoundingConfirmed, onCompoundingConfirmedChange,
    everyRoundAck, onEveryRoundAckChange, edgeOffAck, onEdgeOffAckChange, zeroReserveAck, onZeroReserveAckChange,
    shadowAvailable, onRetryCapabilities, capabilitiesAvailable, blocker, technicalBlockers, capabilitySummary,
    reviewGeneration,
  } = props;
  const [step, setStep] = useState(() => Math.max(0, Math.min(3, props.initialStep ?? 0)));
  const [reviewed, setReviewed] = useState(false);
  const [gasInput, setGasInput] = useState(() => mistToSui(policy.sessionGasBudgetMist));
  const [spendInput, setSpendInput] = useState(() => (policy.sessionTurnoverCents / 100).toFixed(2));
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const reviewSignature = JSON.stringify([
    policy.intervals, policy.signalSource, policy.frequency, policy.selectiveMinProbability,
    policy.edgeEnabled, policy.minimumEdgePp, policy.sizingMode, policy.fixedCents,
    policy.sizingPercent, policy.maxOrderCents, policy.roundCollateralCents,
    policy.sessionTurnoverCents, policy.sessionDurationMs, policy.sessionGasBudgetMist,
    policy.compound, policy.dailyTurnoverCents, policy.dailyLoss, policy.maxDrawdownPercent,
    policy.maxConsecutiveLosses, policy.reserveCents, policy.maxUnresolved, policy.autoClaim,
  ]);
  useEffect(() => { setReviewed(false); }, [reviewSignature, reviewGeneration]);
  useEffect(() => {
    setGasInput(mistToSui(policy.sessionGasBudgetMist));
  }, [policy.sessionGasBudgetMist]);
  useEffect(() => {
    setSpendInput((policy.sessionTurnoverCents / 100).toFixed(2));
  }, [policy.sessionTurnoverCents]);

  const supportedDuration = AGENT_SESSION_DURATIONS.some(item => item.milliseconds === policy.sessionDurationMs);
  const safeOrderCap = policy.maxOrderCents != null && policy.maxOrderCents > 0 && policy.maxOrderCents <= 500 &&
    policy.roundCollateralCents <= 500 && policy.maxOrderCents <= policy.roundCollateralCents &&
    (policy.sizingMode !== "FIXED" || policy.fixedCents <= 500);
  const safeGas = Number.isSafeInteger(policy.sessionGasBudgetMist) && policy.sessionGasBudgetMist >= 0 && policy.sessionGasBudgetMist <= 500_000_000;
  const safeSpend = Number.isSafeInteger(policy.sessionTurnoverCents) && policy.sessionTurnoverCents > 0;
  const spendInputValid = dollarsToSafeCents(spendInput) === policy.sessionTurnoverCents;
  const gasInputValid = suiToMist(gasInput) === policy.sessionGasBudgetMist;
  const boundedBetaStrategy = !policy.compound && policy.dailyTurnoverCents != null;
  const paperCapitalValid = paperExists || paperCapitalFromInput(paperCapital) != null;
  const sessionTerminal = status === "LOSS_STOP" || status === "TARGET_REACHED";
  const canStartShadow = canStartGuidedShadow({
    policy, gasInput, spendInput, authorized, shadowAvailable, dirty, paperExists, paperCapital,
    status, busy: !!busy, reviewed, everyRoundAck, edgeOffAck, zeroReserveAck,
  });
  const isSessionActive = status === "SHADOW";
  const dailyLossSummary = policy.dailyLoss
    ? policy.dailyLoss.mode === "AMOUNT" ? `${dollars(policy.dailyLoss.value)} daily loss` : `${policy.dailyLoss.value}% daily loss`
    : "no daily loss guard";
  const strategySummary = `${policy.signalSource === "BLUEWATER_CHAMPION" ? "Bluewater champion" : "Experimental qualification gates"} · ${policy.frequency === "SELECTIVE" ? `selective at ${(policy.selectiveMinProbability * 100).toFixed(0)}% minimum` : "every eligible round"} · ${policy.edgeEnabled ? `${policy.minimumEdgePp} pp edge filter on` : "edge filter off"}`;

  const setOrderCapToBeta = () => onPolicyChange(p => ({
    ...p, sizingMode: "FIXED", fixedCents: 500, maxOrderCents: 500, roundCollateralCents: 500,
  }));

  return <section className="guided-agent" aria-labelledby="guided-agent-title">
    <div className="guided-head">
      <div><span className="agent-kicker">GUIDED SETUP / BETA SESSION</span><h2 id="guided-agent-title">A bounded session, reviewed by you.</h2>
        <p>Configure a finite observation session. Nothing here grants signing or live order authority.</p></div>
      <span className="guided-step-count">0{step + 1} <i>/</i> 04</span>
    </div>
    <nav className="guided-progress" aria-label="Setup steps">
      {["Wallet", "Session", "Review", "Start"].map((label, index) => <button key={label} type="button" className={step === index ? "active" : step > index ? "complete" : ""} onClick={() => setStep(index)} aria-current={step === index ? "step" : undefined}>
        <b>{step > index ? <Check size={13} /> : `0${index + 1}`}</b><span>{label}</span>
      </button>)}
    </nav>

    <div className="guided-content">
      {step === 0 && <div className="guided-step-panel">
        <div className="guided-step-title"><span>01</span><div><h3>Wallet identity</h3><p>Connect an eligible Sui mainnet wallet to verify the owner. A connection is not trading permission.</p></div></div>
        {!authorized ? <div className="guided-wallet-connect">
          <Wallet size={18} /><div><strong>Connect a supported wallet</strong><small>Slush or another wallet-standard wallet with mainnet connect and personal-message signing.</small></div>
          <select aria-label="Choose supported wallet" value="" disabled={!wallets.length || !!busy} onChange={event => {
            const index = Number(event.target.value);
            if (event.target.value !== "" && Number.isInteger(index)) onConnect(index);
          }}><option value="">{wallets.length ? "Choose wallet" : "No supported wallet detected"}</option>{wallets.map((item, index) => <option key={`${item.name}-${index}`} value={index}>{item.name}</option>)}</select>
        </div> : <div className="guided-facts">
          <div><span>WALLET</span><b>{walletName || "Connected wallet"}</b></div>
          <div><span>NETWORK</span><b>{network || "Not verified"}</b></div>
          <div><span>OWNER ACCOUNT</span><b>{accountAddress || ownerAddress || "Not reported"}</b></div>
          <div><span>FUNDING ASSET</span><b>{supportedAsset || "Not reported by the accounts capability"}</b></div>
        </div>}
        {authorized && <div className="guided-wallet-actions"><span><LockKeyhole size={14} /> Identity verification only. No transaction signature, delegation, or funded authority.</span><button type="button" className="agent-secondary" disabled={!!busy} onClick={onRefreshAsset}>{busy === "accounts" ? "Checking…" : "Check supported asset"}</button></div>}
        <div className="guided-note"><ShieldAlert size={15} /><span>Network and selected account are displayed from the wallet-standard mainnet identity. The available settlement asset is shown only after the existing accounts request reports it.</span></div>
      </div>}

      {step === 1 && <div className="guided-step-panel">
        <div className="guided-step-title"><span>02</span><div><h3>Session bounds</h3><p>Pick eligible BTC round intervals and review the finite cumulative spend limit separately from the per-order ceiling.</p></div></div>
        <div className="guided-fields">
          <div className="guided-control"><label>BTC round interval</label><div className="guided-options">
            {[5, 15].map(minutes => <button type="button" key={minutes} className={policy.intervals.includes(minutes as 5 | 15) ? "selected" : ""} aria-pressed={policy.intervals.includes(minutes as 5 | 15)} onClick={() => onPolicyChange(p => ({ ...p, intervals: p.intervals.includes(minutes as 5 | 15) ? p.intervals.filter(x => x !== minutes) as AgentPolicy["intervals"] : [...p.intervals, minutes as 5 | 15].sort() as AgentPolicy["intervals"] }))}>{minutes} min</button>)}
          </div></div>
          <div className="guided-control"><label>Maximum order cap</label><div className="guided-input"><span>$</span><strong>{dollars(policy.maxOrderCents)}</strong><small>beta maximum $5.00</small></div>
            {!safeOrderCap && <div className="guided-inline-warning"><span>Saved policy exceeds the beta ceiling. No existing approval was changed.</span><button type="button" onClick={setOrderCapToBeta}>Review and set $5 beta cap</button></div>}
            <small>Order cap is not the cumulative session spend cap. Fixed sizing and aggregate per-round collateral are included in this check.</small>
          </div>
          <div className="guided-control"><label htmlFor="guided-spend">Cumulative session spend cap</label><div className="guided-input"><span>$</span><input id="guided-spend" type="number" min="0.01" step="0.01" value={spendInput} onChange={event => {
            const next = event.target.value;
            setSpendInput(next);
            const cents = dollarsToSafeCents(next);
            if (cents != null && cents > 0) onPolicyChange(p => ({ ...p, sessionTurnoverCents: cents }));
          }} /><small>finite total · reviewed below</small></div>
            <small>Funds added later do not raise this limit. Uncommitted spend does not imply a return or guarantee.</small>
          </div>
          <div className="guided-control"><label htmlFor="guided-duration">Session duration</label><select id="guided-duration" value={policy.sessionDurationMs} onChange={event => onPolicyChange(p => ({ ...p, sessionDurationMs: Number(event.target.value) }))}>{AGENT_SESSION_DURATIONS.map(duration => <option key={duration.milliseconds} value={duration.milliseconds}>{duration.label}</option>)}{!supportedDuration && <option value={policy.sessionDurationMs}>Other saved duration · requires review</option>}</select></div>
          <div className="guided-control"><label htmlFor="guided-gas">Gas allowance</label><div className="guided-input"><input id="guided-gas" type="number" min="0" max="0.5" step="0.000000001" inputMode="decimal" value={gasInput} onChange={event => {
            const value = event.target.value;
            setGasInput(value);
            const mist = suiToMist(value);
            if (mist != null && mist <= 500_000_000) onPolicyChange(p => ({ ...p, sessionGasBudgetMist: mist }));
          }} /><span>SUI</span><small>stored in MIST; maximum 0.5 SUI</small></div>
            {(!safeGas || !gasInputValid) && <small className="guided-error">Gas allowance is outside the supported safe range. Adjust it before continuing.</small>}
          </div>
        </div>
        {(!safeSpend || !spendInputValid) && <p className="guided-error" role="alert">Enter a positive finite spend cap in cents precision before reviewing.</p>}
        {!supportedDuration && <p className="guided-error">Choose one of the supported finite session durations before starting.</p>}
        {!boundedBetaStrategy && <p className="guided-error">This saved strategy includes broader advanced behavior (compounding, unlimited turnover, non-selective rounds, or disabled edge filter). Review and explicitly bound it under Advanced before a beta shadow start; the saved policy was not changed.</p>}
      </div>}

      {step === 2 && <div className="guided-step-panel">
        <div className="guided-step-title"><span>03</span><div><h3>Review the whole policy</h3><p>Read the saved strategy and all relevant exposure, stop, time, gas, and permission boundaries before saving.</p></div></div>
        <div className="guided-review-grid">
          <div><span>STRATEGY / SOURCE</span><b>{strategySummary}{policy.signalSource === "EXPERIMENTAL_QUALIFICATION_GATES" ? " · uncalibrated research" : ""}</b></div>
          <div><span>ELIGIBLE ROUNDS</span><b>BTC {policy.intervals.join("m / ")}m</b></div>
          <div><span>ORDER / ROUND EXPOSURE</span><b>{dollars(policy.maxOrderCents)} order cap · {dollars(policy.roundCollateralCents)} aggregate collateral</b></div>
          <div><span>CUMULATIVE SESSION SPEND</span><b>{dollars(policy.sessionTurnoverCents)} finite cap</b></div>
          <div><span>GAS / DURATION</span><b>{mistToSui(policy.sessionGasBudgetMist)} SUI · {humanDuration(policy.sessionDurationMs)}</b></div>
          <div><span>STOPS</span><b>{dollars(policy.sessionLossCents)} session loss · {dailyLossSummary} · {policy.maxDrawdownPercent == null ? "no drawdown stop" : `${policy.maxDrawdownPercent}% drawdown`} · {policy.maxConsecutiveLosses ?? "no"} consecutive-loss stop · daily target {dollars(policy.dailyProfitTargetCents)} / {policy.dailyProfitAction.toLowerCase()} · equity target {dollars(policy.targetCents)}</b></div>
          <div><span>RESERVE / OPEN EXPOSURE</span><b>{dollars(policy.reserveCents)} reserve · {policy.maxUnresolved.mode === "AMOUNT" ? dollars(policy.maxUnresolved.value) : `${policy.maxUnresolved.value}%`} unresolved limit</b></div>
          <div><span>OTHER SAVED POLICY</span><b>{policy.compound ? "Compounding enabled" : "Compounding off"} · daily turnover {dollars(policy.dailyTurnoverCents)} · auto claim off</b></div>
          <div><span>PERMISSIONS</span><b>Wallet identity only · no live signer or delegate permission · funding and withdrawal remain separate owner-simulated actions</b></div>
        </div>
        <div className="guided-review-warning"><ShieldAlert size={17} /><p>Connection grants identity only. This setup does not authorize a signer, delegate, transaction, or live orders. Shadow observation is not execution. Funding never arms a session or increases any cap.</p></div>
        <label className="guided-review-check"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /> I reviewed this complete policy, including existing advanced settings that are not changed by guided setup.</label>
        {policy.signalSource === "EXPERIMENTAL_QUALIFICATION_GATES" && <label className="guided-review-check"><input type="checkbox" checked={experimentalConfirmed} onChange={event => onExperimentalConfirmedChange(event.target.checked)} /> I understand this qualification-gates strategy is uncalibrated and I explicitly choose it.</label>}
        {policy.compound && <label className="guided-review-check"><input type="checkbox" checked={compoundingConfirmed} onChange={event => onCompoundingConfirmedChange(event.target.checked)} /> I explicitly confirm compounding in this saved policy. This does not increase spend authority.</label>}
        {policy.frequency === "EVERY_ELIGIBLE_ROUND" && <label className="guided-review-check"><input type="checkbox" checked={everyRoundAck} onChange={event => onEveryRoundAckChange(event.target.checked)} /> I understand this policy evaluates every eligible round.</label>}
        {!policy.edgeEnabled && <label className="guided-review-check"><input type="checkbox" checked={edgeOffAck} onChange={event => onEdgeOffAckChange(event.target.checked)} /> I understand the edge filter is disabled.</label>}
        {policy.reserveCents === 0 && <label className="guided-review-check"><input type="checkbox" checked={zeroReserveAck} onChange={event => onZeroReserveAckChange(event.target.checked)} /> I understand zero reserve permits all available simulation capital to be committed.</label>}
        {dirty && <div className="guided-save-row"><span>Draft differs from the server policy. Saving preserves all other policy values and will not start a session.</span><button type="button" className="agent-primary" disabled={!authorized || !reviewed || (policy.signalSource === "EXPERIMENTAL_QUALIFICATION_GATES" && !experimentalConfirmed) || (policy.compound && !compoundingConfirmed) || !!busy} onClick={onSave}>{busy === "policy" ? "Saving…" : "Save reviewed policy"}</button></div>}
      </div>}

      {step === 3 && <div className="guided-step-panel">
        <div className="guided-step-title"><span>04</span><div><h3>Choose how to proceed</h3><p>Shadow observation and live authorization are different actions with different authority boundaries.</p></div></div>
        <div className="guided-blocker" role="status"><span className="guided-blocker-mark" /><div><small>ONE CURRENT BLOCKER</small><strong>{blocker}</strong></div></div>
        <div className="guided-start-actions">
          <div className="guided-start-card">
            <span className="guided-tag">NO ORDER AUTHORITY</span><h4>Start shadow session</h4>
            <p>Requests the existing shadow control action only. Service status remains authoritative; no live order is placed.</p>
            {!paperExists && <div className="guided-paper-capital"><label htmlFor="guided-paper-capital">Paper-ledger starting capital</label><div className="guided-input"><span>$</span><input id="guided-paper-capital" type="number" min="0.01" max="1000000" step="0.01" inputMode="decimal" value={paperCapital} onChange={event => onPaperCapitalChange(event.target.value)} /><small>simulation only · does not move funds</small></div><small>Required once to initialize the shadow paper ledger; not wallet funding and not an order or spend-cap increase.</small></div>}
            <button type="button" className="agent-primary" disabled={!canStartShadow} onClick={onStartShadow}>{busy === "ARM_SHADOW" ? "Requesting shadow session…" : "Start shadow session"}</button>
            {dirty && <small>Save the reviewed policy first. Starting never saves an unsaved draft.</small>}
            {!shadowAvailable && <small>Shadow arming is not enabled in the current service capability report.</small>}
            {!paperCapitalValid && <small>A positive paper-ledger starting amount from $0.01 to $1,000,000 is required.</small>}
            {sessionTerminal && <small>This paper goal has stopped; the service must close the stopped goal before another shadow start.</small>}
          </div>
          <div className="guided-start-card live-locked">
            <span className="guided-tag">NOT AVAILABLE</span><h4>Authorize and start live</h4>
            <p>Disabled. The current capability contract does not verify a live order adapter, signer, effective permissions, reservation/simulation path, or uncertain-submission recovery.</p>
            <button type="button" disabled title="Live authority is not enabled or verified by the current capabilities.">Live authorization unavailable</button>
          </div>
        </div>
        {isSessionActive && <div className="guided-pause-bar">
          <div><strong><Pause size={15} /> Shadow session active</strong><span>Pause prevents new submissions; already submitted orders are not undone. Reconciliation must continue after pausing.</span></div>
          <button type="button" className="agent-pause" disabled={!authorized || !!busy} onClick={onPause}>{busy === "PAUSE" ? "Pausing…" : "Pause session"}</button>
        </div>}
      </div>}

      <div className="guided-step-footer">
        <button type="button" className="agent-secondary" disabled={step === 0} onClick={() => setStep(current => Math.max(0, current - 1))}><ChevronLeft size={15} /> Previous</button>
        <span>{step < 3 ? "No step authorizes live trading." : "No funded authority is granted by setup."}</span>
        <button type="button" className="agent-secondary" disabled={step === 3} onClick={() => setStep(current => Math.min(3, current + 1))}>Continue <ChevronRight size={15} /></button>
      </div>
    </div>
    <details className="guided-advanced" open={advancedOpen} onToggle={event => setAdvancedOpen(event.currentTarget.open)}>
      <summary>Advanced · execution requirements and saved technical policy</summary>
      <div className="guided-advanced-content">
        <p>These are actual reported dependencies, not a readiness claim. Missing capability fields remain unavailable.</p>
        {!capabilitiesAvailable && <button type="button" className="agent-secondary" disabled={busy === "capabilities"} onClick={onRetryCapabilities}>{busy === "capabilities" ? "Retrying capabilities…" : "Retry capability report"}</button>}
        <ul>{Array.from(new Set([...technicalBlockers, ...capabilitySummary])).map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
        <div className="guided-checklist"><b>Live path checklist</b><span>Verified order adapter</span><span>Owner-approved signer and effective permissions</span><span>Reservations and pre-submit simulation</span><span>Safe recovery for uncertain submission and continuing reconciliation</span></div>
      </div>
    </details>
  </section>;
}

export default GuidedAgentSetup;
