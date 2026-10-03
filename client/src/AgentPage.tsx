import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Activity, AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, CircleHelp, Clock3, LockKeyhole, Pause, RefreshCw, Shield, ShieldCheck, Wallet, X } from "lucide-react";
import { getWallets, type WalletAccount } from "@mysten/wallet-standard";
import { Transaction } from "@mysten/sui/transactions";
import { agentPolicySchema, defaultAgentPolicy, policySummary, type AgentPolicy } from "../../shared/agent-policy";
import { agentDate, agentMoney, asErrorMessage, changePolicyLimitMode, copyPolicy, policyAmountInputValue, policyValueFromInput } from "./agent-format";
import AgentCurrentRound from "./AgentCurrentRound";

type Paper = { startingCents: number; availableCents: number; committedCents: number; turnoverCents: number; realizedPnlCents: number; highWaterCents: number; consecutiveLosses: number; targetCents: number | null; startedAt: number | null };
type LedgerItem = { id: string; event: string; at: number | string; details: string };
type AgentState = { owner: string; policy: AgentPolicy; policyVersion: number; status: "PAUSED" | "SHADOW" | "LOSS_STOP" | "TARGET_REACHED"; accountId: string | null; delegateAddress: string | null; delegateExpiresAtMs: number | null; paper: Paper | null; ledger: LedgerItem[]; summary: string[]; blockers: string[]; balances: null };
type Capabilities = { developmentOnly: boolean; sdkVersion: string; network: "testnet"; globalExecutionDisabled: boolean; mainnetEnabled: boolean; blockers: string[]; defaultPolicy: AgentPolicy; permissions: { prediction: number; account: number }; config: { status: string; reason: string; settlements?: unknown; packages?: unknown } };
type OwnerTransaction = { transaction: string; description: string; network: "testnet"; permissions: { account: number; prediction: number } };
type WalletLike = { name: string; icon?: string; chains?: string[]; features?: Record<string, { connect?: () => Promise<{ accounts?: WalletAccount[] }>; signPersonalMessage?: (input: { message: Uint8Array; account: WalletAccount; chain?: string }) => Promise<{ signature: string; bytes?: string }>; signAndExecuteTransaction?: (input: { transaction: Transaction; account: WalletAccount; chain: string }) => Promise<{ digest: string }> } | undefined>; accounts?: WalletAccount[] };
type WalletIdentity = { address: string; wallet: WalletLike | null; account: WalletAccount | null; generation: number };
const identityStillCurrent = (expected: WalletIdentity, current: WalletIdentity) =>
  expected.generation === current.generation && expected.address !== "" &&
  expected.address.toLowerCase() === current.address.toLowerCase() &&
  expected.wallet === current.wallet &&
  expected.account?.address.toLowerCase() === current.account?.address.toLowerCase() &&
  (!expected.wallet?.accounts || expected.wallet.accounts.some(account => account.address.toLowerCase() === expected.address.toLowerCase()));
const BASE = "/api/agent";
const messageOf = async (response: Response) => {
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
};
async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { method, credentials: "include", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  return await messageOf(response) as T;
}
const walletFeature = (wallet: WalletLike, name: string) => wallet.features?.[name] ?? {};
const eligibleWallet = (wallet: WalletLike) => {
  if (!wallet || typeof wallet.name !== "string" || !wallet.features || typeof wallet.features !== "object") return false;
  const name = wallet.name.toLowerCase();
  return (name.includes("slush") || name === "sui wallet") &&
    typeof walletFeature(wallet, "standard:connect").connect === "function" &&
    typeof walletFeature(wallet, "sui:signPersonalMessage").signPersonalMessage === "function";
};
const shortAddress = (address: string) => address.length > 18 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
const centsFrom = (value: string) => Math.round(Number(value || 0) * 100);
const localDateTime = (ms: number) => {
  const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
};

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return <label className="agent-field"><span>{label}</span>{children}{help && <small>{help}</small>}</label>;
}
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} className={`agent-toggle${checked ? " on" : ""}`} onClick={() => onChange(!checked)}><i />{label}</button>;
}
function MoneyField({ label, cents, onChange, nullable = false, help }: { label: string; cents: number | null; onChange: (v: number | null) => void; nullable?: boolean; help?: string }) {
  return <Field label={label} help={help}><div className="agent-input-wrap"><span>$</span><input type="number" min="0" step="0.01" value={cents == null ? "" : (cents / 100).toFixed(2)} placeholder={nullable ? "No limit" : "0.00"} onChange={e => onChange(e.target.value === "" && nullable ? null : centsFrom(e.target.value))} />{nullable && <button type="button" className="agent-inline-action" onClick={() => onChange(cents == null ? 0 : null)}>{cents == null ? "Set" : "Unlimited"}</button>}</div></Field>;
}
function AgentPage() {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [state, setState] = useState<AgentState | null>(null);
  const [policyDraft, setPolicyDraft] = useState<AgentPolicy>(() => copyPolicy(defaultAgentPolicy));
  const [wallets, setWallets] = useState<WalletLike[]>([]);
  const [wallet, setWallet] = useState<WalletLike | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<WalletAccount | null>(null);
  const [address, setAddress] = useState("");
  const [pageError, setPageError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [dirtyPolicy, setDirtyPolicy] = useState(false);
  const [everyRoundAck, setEveryRoundAck] = useState(false);
  const [edgeOffAck, setEdgeOffAck] = useState(false);
  const [zeroReserveAck, setZeroReserveAck] = useState(false);
  const [fundingAmount, setFundingAmount] = useState("");
  const [coinIds, setCoinIds] = useState("");
  const [paperCapital, setPaperCapital] = useState("");
  const [settlementInfo, setSettlementInfo] = useState<{ coinType: string; network: string; decimals?: number } | null>(null);
  const [delegateAddress, setDelegateAddress] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [pendingTx, setPendingTx] = useState<OwnerTransaction | null>(null);
  const [pendingAction, setPendingAction] = useState("");
  const [pendingAccountId, setPendingAccountId] = useState<string | undefined>();
  const [pendingDelegate, setPendingDelegate] = useState("");
  const [pendingDelegateExpiry, setPendingDelegateExpiry] = useState<number | undefined>();
  const [pendingOwner, setPendingOwner] = useState("");
  const [pendingGeneration, setPendingGeneration] = useState(-1);
  const [configInfoOpen, setConfigInfoOpen] = useState(false);
  const [accounts, setAccounts] = useState<{ accountId: string }[]>([]);
  const [lastUpdated, setLastUpdated] = useState(0);
  const requestSeq = useRef(0);
  const accountRef = useRef("");
  const sessionGeneration = useRef(0);
  const identityRef = useRef<WalletIdentity>({ address: "", wallet: null, account: null, generation: 0 });
  const stateRef = useRef<AgentState | null>(null);
  const dirtyPolicyRef = useRef(false);
  stateRef.current = state;
  dirtyPolicyRef.current = dirtyPolicy;
  const policy = dirtyPolicy ? policyDraft : state?.policy ?? policyDraft;
  const isAuthorized = !!state && !!address && selectedAccount?.address.toLowerCase() === address.toLowerCase() && state.owner.toLowerCase() === address.toLowerCase();

  const loadState = useCallback(async (quiet = false) => {
    if (!address) return;
    const seq = ++requestSeq.current;
    try {
      const next = await request<AgentState>("/state");
      if (seq !== requestSeq.current || accountRef.current.toLowerCase() !== address.toLowerCase()) return;
      if (next.owner.toLowerCase() !== address.toLowerCase()) {
        setState(null);
        setAddress("");
        setWallet(null);
        accountRef.current = "";
        setPageError("The authenticated agent owner did not match the connected wallet. Session cleared.");
        void request("/logout", "POST", {}).catch(() => undefined);
        return;
      }
      const previousVersion = stateRef.current?.policyVersion;
      setState(next);
      setDelegateAddress(next.delegateAddress ?? "");
      if (!dirtyPolicyRef.current) {
        setPolicyDraft(copyPolicy(next.policy));
        setDirtyPolicy(false);
      } else if (previousVersion != null && previousVersion !== next.policyVersion) {
        setNotice(`Saved policy changed on the server to version ${next.policyVersion}. Your unsaved draft is preserved.`);
      }
      setLastUpdated(Date.now());
      if (!quiet) setPageError("");
    } catch (error) {
      if (seq === requestSeq.current && !quiet) setPageError(asErrorMessage(error, "Agent state is unavailable."));
    }
  }, [address]);

  useEffect(() => {
    let active = true;
    request<Capabilities>("/capabilities").then(data => { if (active) { setCapabilities(data); setPolicyDraft(copyPolicy(data.defaultPolicy)); } }).catch(error => { if (active) setPageError(asErrorMessage(error, "Agent capabilities are unavailable.")); });
    const registered = getWallets();
    const updateWallets = () => {
      const all = (registered.get() as unknown as WalletLike[]).filter(eligibleWallet);
      if (active) setWallets(all);
    };
    updateWallets();
    const registryOn = (registered as unknown as { on?: (event: string, callback: () => void) => (() => void) }).on;
    const unsubscribe = typeof registryOn === "function" ? registryOn.call(registered, "register", updateWallets) : undefined;
    return () => { active = false; unsubscribe?.(); };
  }, []);

  useEffect(() => {
    if (!isAuthorized) return;
    void loadState(true);
    const timer = window.setInterval(() => { void loadState(true); }, 5000);
    return () => window.clearInterval(timer);
  }, [isAuthorized, loadState]);

  const clearIdentity = useCallback(async (logout = true) => {
    const generation = ++sessionGeneration.current;
    requestSeq.current++;
    setState(null);
    setAddress("");
    setWallet(null);
    setSelectedAccount(null);
    setDelegateAddress("");
    setPolicyDraft(copyPolicy(capabilities?.defaultPolicy ?? defaultAgentPolicy));
    setDirtyPolicy(false);
    setPendingTx(null);
    setNotice("");
    setPageError("");
    accountRef.current = "";
    identityRef.current = { address: "", wallet: null, account: null, generation };
    if (logout) await request("/logout", "POST", {}).catch(() => undefined);
  }, [capabilities]);

  const connectWallet = async (candidate: WalletLike) => {
    let generation: number | null = null;
    let boundAddress = "";
    setBusy("connect"); setPageError(""); setNotice("");
    try {
      const connect = walletFeature(candidate, "standard:connect").connect;
      if (!connect) throw new Error("This wallet does not provide standard:connect.");
      const result = await connect();
      const account = result.accounts?.[0] ?? candidate.accounts?.[0];
      if (!account?.address) throw new Error("Wallet connected without a Sui account.");
      await clearIdentity(true);
      accountRef.current = account.address;
      boundAddress = account.address;
      generation = sessionGeneration.current;
      identityRef.current = { address: boundAddress, wallet: candidate, account, generation };
      setWallet(candidate); setSelectedAccount(account); setAddress(account.address);
      const isCurrent = () => identityRef.current.generation === generation &&
        identityRef.current.address.toLowerCase() === boundAddress.toLowerCase() &&
        identityRef.current.wallet === candidate && identityRef.current.account?.address === boundAddress;
      const challenge = await request<{ message: string }>("/challenge", "POST", { address: account.address });
      if (!isCurrent()) return;
      const signMessage = walletFeature(candidate, "sui:signPersonalMessage").signPersonalMessage;
      if (!signMessage) throw new Error("This wallet does not provide sui:signPersonalMessage.");
      const signed = await signMessage({ message: new TextEncoder().encode(challenge.message), account, chain: "sui:testnet" });
      if (!isCurrent()) return;
      await request("/auth", "POST", { message: challenge.message, signature: signed.signature });
      if (!isCurrent()) {
        void request("/logout", "POST", {}).catch(() => undefined);
        return;
      }
      const authenticatedState = await request<AgentState>("/state");
      if (!isCurrent()) return;
      if (authenticatedState.owner.toLowerCase() !== boundAddress.toLowerCase()) throw new Error("Authenticated agent owner did not match the connected wallet.");
      setState(authenticatedState);
      setPolicyDraft(copyPolicy(authenticatedState.policy));
      setDelegateAddress(authenticatedState.delegateAddress ?? "");
      setDirtyPolicy(false);
      setLastUpdated(Date.now());
      setNotice("Wallet identity verified. No transaction was signed.");
    } catch (error) {
      if (generation == null || identityRef.current.generation === generation) {
        await clearIdentity(true);
        setPageError(asErrorMessage(error, "Wallet authentication failed."));
      }
    }
    finally { setBusy(""); }
  };

  useEffect(() => {
    if (!wallet || !address) return;
    const events = wallet.features?.["standard:events"] as { on?: (event: string, listener: (change: { accounts?: WalletAccount[] }) => void) => (() => void) } | undefined;
    const unsubscribe = events?.on?.("change", change => {
      const next = change.accounts?.[0];
      if (!next || next.address !== address) void clearIdentity(true);
      else {
        identityRef.current = { ...identityRef.current, account: next };
        accountRef.current = next.address;
        setSelectedAccount(next);
      }
    });
    return () => unsubscribe?.();
  }, [wallet, address, clearIdentity]);

  const logout = async () => { setBusy("logout"); await clearIdentity(true); setBusy(""); setNotice("Disconnected. The agent session was cleared."); };
  const changePolicy = (updater: (p: AgentPolicy) => AgentPolicy) => {
    setPolicyDraft(old => {
      const next = updater(copyPolicy(old));
      if (next.frequency !== "EVERY_ELIGIBLE_ROUND") setEveryRoundAck(false);
      if (next.edgeEnabled) setEdgeOffAck(false);
      if (next.reserveCents !== 0) setZeroReserveAck(false);
      return next;
    });
    setDirtyPolicy(true);
  };
  const policySummaries = useMemo(() => policySummary(policy), [policy]);
  const updatePolicy = async () => {
    if (!isAuthorized || !dirtyPolicy) return;
    const validation = agentPolicySchema.safeParse(policyDraft);
    if (!validation.success) {
      const issue = validation.error.issues[0];
      setPageError(`${issue.path.join(".") || "policy"}: ${issue.message}`);
      return;
    }
    setBusy("policy"); setPageError(""); setNotice("");
    try { const result = await request<AgentState>("/policy", "POST", { policy: validation.data }); setState(result); setPolicyDraft(copyPolicy(result.policy)); setDirtyPolicy(false); setNotice("Policy saved to the authenticated agent account."); }
    catch (error) { setPageError(asErrorMessage(error)); }
    finally { setBusy(""); }
  };
  const control = async (action: "PAUSE" | "ARM_SHADOW" | "STOP_GOAL") => {
    setBusy(action); setPageError(""); setNotice("");
    try {
      const result = await request<AgentState>("/control", "POST", { action, ...(action === "ARM_SHADOW" && paperCapital !== "" ? { paperCapitalCents: centsFrom(paperCapital) } : {}), acknowledged: action !== "ARM_SHADOW" || ((policy.frequency !== "EVERY_ELIGIBLE_ROUND" || everyRoundAck) && (policy.edgeEnabled || edgeOffAck) && (policy.reserveCents !== 0 || zeroReserveAck)), ...(!policy.edgeEnabled ? { edgeOffConfirmed: edgeOffAck } : {}), ...(policy.reserveCents === 0 ? { zeroReserveConfirmed: zeroReserveAck } : {}) });
      setState(result); setPolicyDraft(copyPolicy(result.policy)); setNotice(action === "ARM_SHADOW" ? "Shadow mode requested. It does not authorize live execution." : action === "PAUSE" ? "Persistent pause requested." : "Goal stop requested.");
      if (action === "ARM_SHADOW") { setEveryRoundAck(false); setEdgeOffAck(false); setZeroReserveAck(false); }
    } catch (error) { setPageError(asErrorMessage(error)); }
    finally { setBusy(""); }
  };
  const beginOwnerAction = async (action: string, extra: Record<string, unknown> = {}) => {
    const identity = identityRef.current;
    if (!identity.wallet || !identity.account || !isAuthorized || !state) return;
    setBusy("prepare"); setPageError(""); setNotice("");
    try {
      const response = await request<OwnerTransaction>("/owner-transaction", "POST", { action, ...(action !== "CREATE_ACCOUNT" && state.accountId ? { accountId: state.accountId } : {}), ...extra });
      if (!identityStillCurrent(identity, identityRef.current)) return;
      setPendingTx(response); setPendingAction(action); setPendingAccountId(typeof extra.accountId === "string" ? extra.accountId : state.accountId ?? undefined);
      setPendingDelegate(typeof extra.delegateAddress === "string" ? extra.delegateAddress : "");
      setPendingDelegateExpiry(typeof extra.expiresAtMs === "number" ? extra.expiresAtMs : undefined);
      setPendingOwner(identity.address);
      setPendingGeneration(identity.generation);
    } catch (error) { setPageError(asErrorMessage(error)); }
    finally { setBusy(""); }
  };
  const approveOwnerAction = async () => {
    const expected = identityRef.current;
    if (!pendingTx || !expected.wallet || !expected.account ||
      expected.address.toLowerCase() !== pendingOwner.toLowerCase() ||
      expected.generation !== pendingGeneration ||
      !identityStillCurrent(expected, identityRef.current)) {
      setPendingTx(null);
      setPageError("Wallet identity changed. Review this owner transaction again before signing.");
      return;
    }
    setBusy("wallet-sign"); setPageError("");
    try {
      const tx = Transaction.from(pendingTx.transaction);
      const exec = walletFeature(expected.wallet, "sui:signAndExecuteTransaction").signAndExecuteTransaction;
      if (!exec) throw new Error("This wallet does not support Sui transaction signing.");
      if (!identityStillCurrent(expected, identityRef.current)) return;
      const result = await exec({ transaction: tx, account: expected.account, chain: "sui:testnet" });
      if (!identityStillCurrent(expected, identityRef.current)) return;
      setPendingTx(null); setBusy("verify");
      const confirmed = await request<AgentState>("/owner-confirm", "POST", { digest: result.digest, action: pendingAction, ...(pendingAccountId ? { accountId: pendingAccountId } : {}), ...(pendingAction === "AUTHORIZE" ? { delegateAddress: pendingDelegate, expiresAtMs: pendingDelegateExpiry } : {}) });
      if (!identityStillCurrent(expected, identityRef.current)) return;
      setState(confirmed); setPolicyDraft(copyPolicy(confirmed.policy));
      setNotice(pendingAction === "AUTHORIZE"
        ? "Owner-signed transaction effects verified. Effective on-chain delegate permission remains UNVERIFIED."
        : `Wallet confirmed ${pendingAction.toLowerCase()}; server verified the successful testnet transaction effects.`);
      if (pendingAction === "CREATE_ACCOUNT") {
        const accountResult = await request<{ accounts: { accountId: string }[]; settlementCoinType: string; network: string; decimals?: number }>("/accounts", "POST", {});
        if (!identityStillCurrent(expected, identityRef.current)) return;
        setAccounts(accountResult.accounts);
        setSettlementInfo({ coinType: accountResult.settlementCoinType, network: accountResult.network, decimals: accountResult.decimals });
      }
    } catch (error) { setPageError(asErrorMessage(error, "Transaction was not confirmed.")); }
    finally { setBusy(""); }
  };
  const accountOptions = async () => {
    setBusy("accounts");
    try { const result = await request<{ accounts: { accountId: string }[]; settlementCoinType: string; network: string; decimals?: number }>("/accounts", "POST", {}); setAccounts(result.accounts); setSettlementInfo({ coinType: result.settlementCoinType, network: result.network, decimals: result.decimals }); setNotice(result.accounts.length ? `${result.accounts.length} agent account${result.accounts.length === 1 ? "" : "s"} returned. Select one below.` : "No agent accounts were returned."); }
    catch (error) { setPageError(asErrorMessage(error)); }
    finally { setBusy(""); }
  };
  const setAccount = async (accountId: string) => {
    setBusy("account");
    try { const result = await request<AgentState>("/account", "POST", { accountId }); setState(result); setPolicyDraft(copyPolicy(result.policy)); setDelegateAddress(result.delegateAddress ?? ""); setDirtyPolicy(false); setNotice("Agent account selected."); }
    catch (error) { setPageError(asErrorMessage(error)); }
    finally { setBusy(""); }
  };
  const createDelegate = async () => {
    const identity = identityRef.current;
    if (!isAuthorized || !state?.accountId || !identity.wallet || !identityStillCurrent(identity, identityRef.current)) return;
    setBusy("delegate"); setPageError(""); setNotice("");
    try {
      const result = await request<AgentState>("/delegate", "POST", {});
      if (!identityStillCurrent(identity, identityRef.current)) return;
      if (result.owner.toLowerCase() !== identity.address.toLowerCase() || result.accountId !== state.accountId) {
        throw new Error("Delegate response did not match the linked owner and account. Response withheld.");
      }
      setState(result);
      setDelegateAddress(result.delegateAddress ?? "");
      setNotice(result.delegateAddress
        ? "Disposable testnet delegate created. Effective on-chain permission is still unverified; authorization requires your explicit owner signature."
        : "Delegate endpoint returned no address; no delegate is available to authorize.");
    } catch (error) { setPageError(asErrorMessage(error)); }
    finally { setBusy(""); }
  };
  const cap = capabilities;
  const blockers = Array.from(new Set([...(cap?.blockers ?? []), ...(state?.blockers ?? [])]));
  const status = state?.status ?? "PAUSED";
  const accountId = state?.accountId;
  const available = state?.paper?.availableCents;
  const minDelegateExpiry = Date.now() + 60_000;
  const maxDelegateExpiry = Date.now() + 7 * 24 * 60 * 60_000;
  const delegateExpiryMs = expiresAt ? Date.parse(expiresAt) : NaN;
  const delegateExpiryInBounds = Number.isFinite(delegateExpiryMs) &&
    delegateExpiryMs >= minDelegateExpiry && delegateExpiryMs <= maxDelegateExpiry;

  return <div className="page agent-page">
    <header className="agent-mast">
      <div><div className="eyebrow">BLUEWATERAI / AGENT CONTROL</div><h1>Evidence in. <em>Execution out.</em></h1><p>Separate research from authority. Every owner action is reviewed and signed in your wallet.</p></div>
      <div className="agent-mast-badge"><span className="agent-pulse" />TESTNET ONLY <b>·</b> MAINNET DISABLED</div>
    </header>

    <section className="agent-safety-strip">
      <ShieldCheck size={19} /><div><strong>SHADOW OBSERVATION ONLY · no executable adapter is verified</strong><span>Champion evidence, real quotes, and delegated authority are not yet proven together. No hypothetical fills, trade outcomes, or compounding results are generated here.</span></div><span className="agent-permission">PREDICTION 1 <i /> ACCOUNT 0</span>
    </section>

    <div className="agent-overview">
      <section className="agent-status-panel">
        <div className="agent-section-top"><span className="agent-kicker">CONTROL STATE</span><span className={`agent-status ${status.toLowerCase()}`}><i />{status.replace("_", " ")}</span></div>
        <div className="agent-status-main"><strong>{status === "SHADOW" ? "Shadow observation" : status === "LOSS_STOP" ? "Risk stop engaged" : status === "TARGET_REACHED" ? "Target reached" : "Agent paused"}</strong><p>{isAuthorized ? `Authenticated owner ${shortAddress(address)} · server session uses an HttpOnly cookie (8 hours); no private keys are held here.` : "Connect an eligible Slush wallet to load private agent state."}</p></div>
        <div className="agent-actions">
          <button className="agent-primary" disabled={!isAuthorized || dirtyPolicy || !!busy || (policy.frequency === "EVERY_ELIGIBLE_ROUND" && !everyRoundAck) || (!policy.edgeEnabled && !edgeOffAck) || (policy.reserveCents === 0 && !zeroReserveAck)} onClick={() => void control("ARM_SHADOW")}><Activity size={15} /> Start observation</button>
          <button className="agent-pause" disabled={!isAuthorized || !!busy || status === "PAUSED"} onClick={() => void control("PAUSE")}><Pause size={15} /> Pause</button>
          {isAuthorized ? <button className="agent-logout" disabled={!!busy} onClick={() => void logout()}><X size={15} /> Disconnect</button> : <div className="agent-wallet-picker"><Wallet size={15} /><select aria-label="Choose eligible Sui wallet" value="" disabled={!wallets.length || !!busy} onChange={e => { const selected = wallets[Number(e.target.value)]; if (selected) void connectWallet(selected); }}><option value="">{wallets.length ? "Connect Slush wallet" : "Slush wallet not detected"}</option>{wallets.map((item, i) => <option key={`${item.name}-${i}`} value={i}>{item.name}</option>)}</select></div>}
        </div>
        <div className="agent-paper-capital"><label htmlFor="paper-capital">Observation session starting value <small>optional · no hypothetical fills are generated</small></label><div className="agent-input-wrap"><span>$</span><input id="paper-capital" type="number" min="0.01" step="0.01" placeholder={state?.paper ? (state.paper.startingCents / 100).toFixed(2) : "Not set"} value={paperCapital} onChange={e => setPaperCapital(e.target.value)} /></div></div>
        <div className="agent-auth-note"><LockKeyhole size={13} /> Signing a short-lived challenge only. No transaction requested on connect.</div>
      </section>

      <section className="agent-equity-panel">
        <div className="agent-section-top"><span className="agent-kicker">PAPER ACCOUNT · NEVER ON-CHAIN BALANCE</span><button className="agent-icon-button" aria-label="Refresh private state" disabled={!isAuthorized || !!busy} onClick={() => void loadState()}><RefreshCw size={14} /></button></div>
        <div className="agent-equity">{available == null ? "—" : agentMoney(available)}</div><div className="agent-equity-caption">{state?.paper ? "Server-reported paper observation value · not an on-chain balance" : "Balance not reported"}</div>
        <div className="agent-mini-stats"><div><span>REPORTED COMMITTED</span><b>{agentMoney(state?.paper?.committedCents)}</b></div><div><span>REPORTED P/L</span><b>{state?.paper ? agentMoney(state.paper.realizedPnlCents) : "Not reported"}</b></div><div><span>REPORTED TURNOVER</span><b>{agentMoney(state?.paper?.turnoverCents)}</b></div></div>
        <small className="agent-unverified-copy">Server-reported paper counters only. They do not establish fills or qualified trade outcomes; policy sizing and compounding are stored settings, not active execution behavior.</small>
        <small className="agent-update-label">{lastUpdated ? `LAST STATE CHECK · ${new Date(lastUpdated).toLocaleTimeString()}` : "STATE NOT LOADED"} · refresh every 5 sec while authenticated</small>
      </section>
    </div>

    <AgentCurrentRound agentStatus={state?.status ?? "PAUSED"} />

    {(pageError || notice) && <div role={pageError ? "alert" : "status"} className={pageError ? "agent-message error" : "agent-message"}>{pageError ? <AlertTriangle size={16} /> : <Check size={16} />}{pageError || notice}<button aria-label="Dismiss message" onClick={() => { setPageError(""); setNotice(""); }}><X size={14} /></button></div>}

    <div className="agent-columns">
      <main className="agent-main-column">
        <section className="agent-card agent-policy-card">
          <div className="agent-card-heading"><div><span className="agent-kicker">01 / AUTHORITY BOUNDARY</span><h2>Policy surface</h2><p>Each control is independent. Sizing and compounding are saved policy intent only; they do not generate hypothetical trades before adapter verification.</p></div><span className={dirtyPolicy ? "agent-dirty" : "agent-saved"}>{dirtyPolicy ? "UNSAVED PREVIEW" : isAuthorized ? `SAVED · V${state?.policyVersion ?? "—"}` : "PUBLIC PREVIEW"}</span></div>
          <fieldset className="agent-fields">
            <div className="agent-control-grid">
              <Field label="Network" help="Mainnet is unavailable in this agent."><select value={policy.network} onChange={e => changePolicy(p => ({ ...p, network: e.target.value as AgentPolicy["network"] }))}><option value="testnet">Sui testnet</option><option value="mainnet" disabled>Mainnet unavailable</option></select></Field>
              <Field label="Eligible round intervals"><div className="agent-choice-row">{([5, 15] as const).map(n => <button type="button" key={n} className={policy.intervals.includes(n) ? "chosen" : ""} aria-pressed={policy.intervals.includes(n)} onClick={() => changePolicy(p => ({ ...p, intervals: p.intervals.includes(n) ? p.intervals.filter(v => v !== n) as AgentPolicy["intervals"] : [...p.intervals, n].sort() as AgentPolicy["intervals"] }))}>{n} minutes</button>)}</div></Field>
              <Field label="Signal source" help="Research evidence is produced by Bluewater champion."><select value={policy.signalSource} onChange={e => changePolicy(p => ({ ...p, signalSource: e.target.value as AgentPolicy["signalSource"] }))}><option value="BLUEWATER_CHAMPION">Bluewater champion</option></select></Field>
              <Field label="Frequency"><select value={policy.frequency} onChange={e => changePolicy(p => ({ ...p, frequency: e.target.value as AgentPolicy["frequency"] }))}><option value="SELECTIVE">Selective</option><option value="EVERY_ELIGIBLE_ROUND">Every eligible round</option></select></Field>
              {policy.frequency === "SELECTIVE" && <Field label="Selective minimum probability" help="Fraction from 0.50 to 1.00."><div className="agent-input-wrap"><input type="number" min=".5" max="1" step=".01" value={policy.selectiveMinProbability} onChange={e => changePolicy(p => ({ ...p, selectiveMinProbability: Number(e.target.value) }))} /><span>fraction</span></div></Field>}
              <Field label="Verified edge filter"><Toggle checked={policy.edgeEnabled} onChange={edgeEnabled => changePolicy(p => ({ ...p, edgeEnabled }))} label={policy.edgeEnabled ? "On" : "Off"} /></Field>
              {policy.edgeEnabled && <Field label="Minimum edge" help="Percentage points after verified costs."><div className="agent-input-wrap"><input type="number" min="0" max="100" step=".1" value={policy.minimumEdgePp} onChange={e => changePolicy(p => ({ ...p, minimumEdgePp: Number(e.target.value) }))} /><span>pp</span></div></Field>}
              <Field label="Sizing mode"><select value={policy.sizingMode} onChange={e => changePolicy(p => ({ ...p, sizingMode: e.target.value as AgentPolicy["sizingMode"] }))}><option value="FIXED">Fixed amount</option><option value="AVAILABLE_PERCENT">Available equity percent</option><option value="ALLOCATION_PERCENT">Allocation percent</option></select></Field>
              {policy.sizingMode === "FIXED" ? <MoneyField label="Fixed order size" cents={policy.fixedCents} onChange={v => changePolicy(p => ({ ...p, fixedCents: v ?? 0 }))} /> : <Field label="Sizing percentage" help="Percent used by the selected sizing mode."><div className="agent-input-wrap"><input type="number" min=".01" max="100" step=".1" value={policy.sizingPercent} onChange={e => changePolicy(p => ({ ...p, sizingPercent: Number(e.target.value) }))} /><span>%</span></div></Field>}
              <MoneyField label="Allocation amount" cents={policy.allocationCents} onChange={v => changePolicy(p => ({ ...p, allocationCents: v ?? 0 }))} />
              <Field label="Compounding"><Toggle checked={policy.compound} onChange={compound => changePolicy(p => ({ ...p, compound }))} label={policy.compound ? "On" : "Off"} /></Field>
              <MoneyField label="Daily turnover limit" cents={policy.dailyTurnoverCents} nullable onChange={v => changePolicy(p => ({ ...p, dailyTurnoverCents: v }))} help="Unlimited still obeys other risk stops." />
              <Field label="Daily loss guard"><div className="agent-pair-fields"><select aria-label="Daily loss mode" value={policy.dailyLoss?.mode ?? "AMOUNT"} onChange={e => changePolicy(p => { const mode = e.target.value as "AMOUNT" | "PERCENT"; const from = p.dailyLoss?.mode ?? mode; return { ...p, dailyLoss: { mode, value: p.dailyLoss ? changePolicyLimitMode(from, mode, p.dailyLoss.value) : mode === "AMOUNT" ? 100 : 1 } }; })}><option value="AMOUNT">Amount</option><option value="PERCENT">Percent</option></select><div className="agent-input-wrap"><input aria-label="Daily loss value" type="number" min=".01" max={policy.dailyLoss?.mode === "PERCENT" ? 100 : 1000000} step={policy.dailyLoss?.mode === "PERCENT" ? ".1" : ".01"} value={policy.dailyLoss ? policyAmountInputValue(policy.dailyLoss.mode, policy.dailyLoss.value) : ""} placeholder="Disabled" onChange={e => changePolicy(p => ({ ...p, dailyLoss: e.target.value === "" ? null : { mode: p.dailyLoss?.mode ?? "AMOUNT", value: policyValueFromInput(p.dailyLoss?.mode ?? "AMOUNT", e.target.value) } }))} /><span>{policy.dailyLoss?.mode === "PERCENT" ? "%" : "$"}</span></div></div></Field>
              <Field label="Maximum drawdown"><div className="agent-input-wrap"><input type="number" min="0" max="100" step=".1" placeholder="Disabled" value={policy.maxDrawdownPercent ?? ""} onChange={e => changePolicy(p => ({ ...p, maxDrawdownPercent: e.target.value === "" ? null : Number(e.target.value) }))} /><span>%</span></div></Field>
              <Field label="Maximum consecutive losses"><input type="number" min="1" step="1" placeholder="Disabled" value={policy.maxConsecutiveLosses ?? ""} onChange={e => changePolicy(p => ({ ...p, maxConsecutiveLosses: e.target.value === "" ? null : Number(e.target.value) }))} /></Field>
              <MoneyField label="Reserve" cents={policy.reserveCents} onChange={v => changePolicy(p => ({ ...p, reserveCents: v ?? 0 }))} help="Zero reserve requires an explicit start confirmation." />
              <MoneyField label="Maximum order" cents={policy.maxOrderCents} nullable onChange={v => changePolicy(p => ({ ...p, maxOrderCents: v }))} />
              <Field label="Maximum unresolved exposure"><div className="agent-pair-fields"><select aria-label="Maximum unresolved exposure mode" value={policy.maxUnresolved.mode} onChange={e => changePolicy(p => { const mode = e.target.value as "AMOUNT" | "PERCENT"; return { ...p, maxUnresolved: { mode, value: changePolicyLimitMode(p.maxUnresolved.mode, mode, p.maxUnresolved.value) } }; })}><option value="AMOUNT">Amount</option><option value="PERCENT">Percent</option></select><div className="agent-input-wrap"><input aria-label="Maximum unresolved exposure value" type="number" min=".01" max={policy.maxUnresolved.mode === "PERCENT" ? 100 : 1000000} step={policy.maxUnresolved.mode === "PERCENT" ? ".1" : ".01"} value={policyAmountInputValue(policy.maxUnresolved.mode, policy.maxUnresolved.value)} onChange={e => changePolicy(p => ({ ...p, maxUnresolved: { ...p.maxUnresolved, value: policyValueFromInput(p.maxUnresolved.mode, e.target.value) } }))} /><span>{policy.maxUnresolved.mode === "PERCENT" ? "%" : "$"}</span></div></div></Field>
              <MoneyField label="Session equity target" cents={policy.targetCents} nullable onChange={v => changePolicy(p => ({ ...p, targetCents: v }))} />
              <MoneyField label="Daily profit target" cents={policy.dailyProfitTargetCents} nullable onChange={v => changePolicy(p => ({ ...p, dailyProfitTargetCents: v }))} />
              <Field label="Daily profit target action"><select value={policy.dailyProfitAction} onChange={e => changePolicy(p => ({ ...p, dailyProfitAction: e.target.value as AgentPolicy["dailyProfitAction"] }))}><option value="PAUSE">Pause</option><option value="CONTINUE">Continue</option></select></Field>
              <Field label="Auto claim"><div className="agent-locked-control"><LockKeyhole size={14} /> Permanently off · not configurable</div></Field>
              <Field label="Minimum remaining time"><div className="agent-input-wrap"><input type="number" min="5000" max="180000" step="1000" value={policy.minRemainingMs} onChange={e => changePolicy(p => ({ ...p, minRemainingMs: Number(e.target.value) }))} /><span>ms</span></div></Field>
              <Field label="Maximum signal age"><div className="agent-input-wrap"><input type="number" min="1000" max="60000" step="1000" value={policy.maxSignalAgeMs} onChange={e => changePolicy(p => ({ ...p, maxSignalAgeMs: Number(e.target.value) }))} /><span>ms</span></div></Field>
              <Field label="Maximum quote age"><div className="agent-input-wrap"><input type="number" min="100" max="5000" step="100" value={policy.maxQuoteAgeMs} onChange={e => changePolicy(p => ({ ...p, maxQuoteAgeMs: Number(e.target.value) }))} /><span>ms</span></div></Field>
              <Field label="Order time to live"><div className="agent-input-wrap"><input type="number" min="1000" max="10000" step="100" value={policy.orderTtlMs} onChange={e => changePolicy(p => ({ ...p, orderTtlMs: Number(e.target.value) }))} /><span>ms</span></div></Field>
              <Field label="Slippage tolerance"><div className="agent-input-wrap"><input type="number" min="0" max="500" step="1" value={policy.slippageBps} onChange={e => changePolicy(p => ({ ...p, slippageBps: Number(e.target.value) }))} /><span>bps</span></div></Field>
            </div>
          </fieldset>
          {!isAuthorized && <div className="agent-lock-overlay"><LockKeyhole size={14} /> Public preview only. Changes remain in this tab and cannot be saved without the authenticated owner wallet.</div>}
          <section className="agent-summary"><div><span className="agent-kicker">POLICY SUMMARY</span><span className="agent-summary-note">{dirtyPolicy ? "PREVIEW" : "CURRENT VIEW"}</span></div><ul>{policySummaries.map((line, i) => <li key={i}>{line}</li>)}</ul></section>
          {isAuthorized && <>
            {(policy.frequency === "EVERY_ELIGIBLE_ROUND" || !policy.edgeEnabled || policy.reserveCents === 0) && <div className="agent-confirm-group">
              <span className="agent-kicker">START CONFIRMATIONS · REQUIRED EACH SHADOW START</span>
              {policy.frequency === "EVERY_ELIGIBLE_ROUND" && <label><input type="checkbox" checked={everyRoundAck} onChange={e => setEveryRoundAck(e.target.checked)} /> I understand this evaluates every eligible round.</label>}
              {!policy.edgeEnabled && <label><input type="checkbox" checked={edgeOffAck} onChange={e => setEdgeOffAck(e.target.checked)} /> I understand the edge filter is off; rounds may qualify without positive estimated edge.</label>}
              {policy.reserveCents === 0 && <label><input type="checkbox" checked={zeroReserveAck} onChange={e => setZeroReserveAck(e.target.checked)} /> I understand zero reserve permits all available simulation capital to be committed.</label>}
            </div>}
            <div className="agent-policy-actions"><span>{dirtyPolicy ? "Preview differs from saved policy." : "Authenticated policy is current."}</span><button className="agent-primary" disabled={!dirtyPolicy || !!busy} onClick={() => void updatePolicy()}>{busy === "policy" ? "Saving…" : "Save policy"}</button></div>
          </>}
        </section>

        <section className="agent-card">
          <div className="agent-card-heading"><div><span className="agent-kicker">02 / CAPITAL & ACCOUNT</span><h2>Owner-controlled setup</h2><p>Transactions are built by the service, reviewed here, and signed only after your approval.</p></div><span className="agent-flag">OWNER SIGNATURE REQUIRED</span></div>
          <div className="agent-account-row"><div><span>SELECTED ACCOUNT</span><strong>{accountId || "No agent account selected"}</strong></div><div className="agent-account-select"><select aria-label="Select an agent account" disabled={!accounts.length || !!busy} value={accountId || ""} onChange={e => { if (e.target.value) void setAccount(e.target.value); }}><option value="">{accounts.length ? "Choose returned account" : "No accounts loaded"}</option>{accounts.map(item => <option key={item.accountId} value={item.accountId}>{item.accountId}</option>)}</select><button className="agent-secondary" disabled={!isAuthorized || !!busy} onClick={() => void accountOptions()}><RefreshCw size={14} /> Refresh accounts</button></div></div>
          <div className="agent-owner-actions">
            <button disabled={!isAuthorized || !!busy} onClick={() => void beginOwnerAction("CREATE_ACCOUNT")}><Wallet size={15} /> Create account</button>
            <button disabled={!isAuthorized || !accountId || !/^[0-9]+$/.test(fundingAmount) || Number(fundingAmount) <= 0 || !!busy} onClick={() => void beginOwnerAction("FUND", { amountAtomic: fundingAmount, coinObjectIds: coinIds.split(",").map(x => x.trim()).filter(Boolean) })}><ArrowDownToLine size={15} /> Review funding</button>
            <button disabled={!isAuthorized || !accountId || !!busy} onClick={() => void createDelegate()}><Shield size={15} /> Create testnet delegate</button>
            <button disabled={!isAuthorized || !accountId || !delegateAddress || !delegateExpiryInBounds || !!busy} onClick={() => void beginOwnerAction("AUTHORIZE", { delegateAddress, expiresAtMs: delegateExpiryMs })}><ShieldCheck size={15} /> Review authorization</button>
            <button disabled={!isAuthorized || !accountId || !!busy} onClick={() => void beginOwnerAction("REVOKE")}><ShieldCheck size={15} /> Revoke delegate</button>
            <button disabled={!isAuthorized || !accountId || !!busy} onClick={() => void beginOwnerAction("WITHDRAW")}><ArrowUpFromLine size={15} /> Review withdrawal</button>
          </div>
          <div className="agent-funding-form">
            <Field label="Funding amount · atomic units" help="Settlement coin decimals are not assumed."><input inputMode="numeric" placeholder="Enter exact atomic amount" value={fundingAmount} onChange={e => setFundingAmount(e.target.value)} /></Field>
            <Field label="Coin object IDs" help="Comma-separated owner coin object IDs from your wallet."><input placeholder="Required only if service requests specific coins" value={coinIds} onChange={e => setCoinIds(e.target.value)} /></Field>
            <Field label="Disposable testnet delegate address" help="Generated by the service for the linked account; no key or seed is entered here."><input readOnly placeholder="Create after linking an account" value={delegateAddress} /></Field>
            <Field label="Owner authorization expiry" help="Explicit owner signature required · from 1 minute to 7 days."><input type="datetime-local" min={localDateTime(minDelegateExpiry)} max={localDateTime(maxDelegateExpiry)} value={expiresAt} onChange={e => setExpiresAt(e.target.value)} /></Field>
          </div>
          <div className="agent-delegate-warning"><AlertTriangle size={15} /><span>Disposable process-memory testnet key: a service restart loses it. The owner must revoke any old on-chain authorization after restart. No production signer or live execution is provided. Effective on-chain delegation is UNVERIFIED even after the owner transaction is confirmed.</span></div>
          <div className="agent-account-facts"><div><span>ACCOUNT ID</span><b>{accountId || "Not selected"}</b></div><div><span>DELEGATE ADDRESS</span><b>{state?.delegateAddress ? shortAddress(state.delegateAddress) : "Not reported"}</b></div><div><span>OWNER AUTHORIZATION EXPIRY</span><b>{agentDate(state?.delegateExpiresAtMs)}</b></div><div><span>EFFECTIVE DELEGATE PERMISSION</span><b>UNVERIFIED</b></div><div><span>ON-CHAIN BALANCES</span><b>Not requested / not reported</b></div></div>
          <p className="agent-caution"><AlertTriangle size={14} /> Settlement: {settlementInfo?.coinType ?? "not returned"} · {settlementInfo ? `${settlementInfo.network} · ${settlementInfo.decimals == null ? "decimals unknown; atomic amount only" : `${settlementInfo.decimals} decimals reported`}` : "token decimals not reported; atomic units only. No human amount conversion is guessed."}</p>
        </section>

        <section className="agent-card agent-ledger">
          <div className="agent-card-heading"><div><span className="agent-kicker">03 / AUDIT TRAIL</span><h2>Paper ledger</h2><p>Records are shown only when returned by the authenticated state API.</p></div><Clock3 size={18} /></div>
          {state?.ledger?.length ? <div className="agent-ledger-list">{state.ledger.slice().reverse().map(entry => <article key={entry.id}><time>{typeof entry.at === "number" ? agentDate(entry.at) : entry.at}</time><b>{entry.event}</b><p>{entry.details}</p></article>)}</div> : <div className="agent-empty-ledger"><span>NO LEDGER RECORDS</span><p>{isAuthorized ? "The server has not reported any agent ledger events." : "Authenticate to load private ledger events."}</p></div>}
        </section>
      </main>

      <aside className="agent-side-column">
        <section className="agent-card agent-guard-card"><div className="agent-card-heading"><div><span className="agent-kicker">RELEASE GATES</span><h2>Execution blockers</h2></div><Shield size={18} /></div>
          <div className="agent-blocker-state"><i /> RELEASE UNAVAILABLE</div>
          {blockers.length ? <ul className="agent-blockers">{blockers.map((item, i) => <li key={i}><AlertTriangle size={14} />{item}</li>)}</ul> : <p className="agent-unreported">No blocker list returned. This is not evidence of release readiness.</p>}
          <div className="agent-hard-blockers"><span>ALWAYS DISABLED HERE</span><b>Mainnet execution</b><b>Live automatic execution</b><b>Automatic claims</b><b>Account permissions</b></div>
          <button className="agent-quiet-link" onClick={() => setConfigInfoOpen(v => !v)} aria-expanded={configInfoOpen}><CircleHelp size={14} /> Configuration readiness <ChevronDown size={14} /></button>
          {configInfoOpen && <div className="agent-config-facts"><div><span>Service configuration</span><b>{cap?.config.status ?? "Not reported"}</b></div><p>{cap?.config.reason || "Capabilities have not reported a configuration reason."}</p><div><span>SDK version</span><b>{cap?.sdkVersion || "Not reported"}</b></div><div><span>Global execution</span><b>{cap ? cap.globalExecutionDisabled ? "Disabled" : "Not confirmed disabled" : "Not reported"}</b></div></div>}
        </section>
        <section className="agent-card agent-paper-card"><div className="agent-card-heading"><div><span className="agent-kicker">SHADOW OBSERVATION ONLY</span><h2>Paper policy target</h2></div><span className="agent-shadow-tag">NOT LIVE</span></div>
          <div className="agent-goal-value">{agentMoney(state?.paper?.targetCents ?? policy.targetCents)}</div><p>Configured stop parameter, not evidence of simulated gains, fills, or completed qualification.</p>
          <div className="agent-goal-note">Returned paper fields only · no fill or compounding progress is generated.</div>
          <div className="agent-goal-labels"><span>AVAILABLE {agentMoney(state?.paper?.availableCents)}</span><span>TARGET {agentMoney(state?.paper?.targetCents ?? policy.targetCents)}</span></div>
          <div className="agent-goal-meta"><span>High-water mark</span><b>{agentMoney(state?.paper?.highWaterCents)}</b><span>Consecutive losses</span><b>{state?.paper?.consecutiveLosses ?? "Not reported"}</b><span>Paper session started</span><b>{agentDate(state?.paper?.startedAt)}</b></div>
          <button className="agent-secondary full" disabled={!isAuthorized || !state?.paper?.targetCents || !!busy} onClick={() => void control("STOP_GOAL")}>Request goal stop</button>
        </section>
        <section className="agent-card agent-copy-card"><span className="agent-kicker">RESEARCH IS NOT AUTHORITY</span><p>Research may inform a shadow decision. It cannot grant custody or turn this panel into a live trading interface.</p><div><span>Prediction permission</span><b>{cap?.permissions.prediction ?? 1}</b></div><div><span>Account permission</span><b>{cap?.permissions.account ?? 0}</b></div></section>
      </aside>
    </div>

    <footer className="agent-footer"><span>BLUEWATERAI AGENT · TESTNET PAPER CONTROL</span><span>Balances are never inferred <i /> No background signing <i /> No live execution</span></footer>

    {pendingTx && <div className="agent-modal-backdrop" role="presentation"><section className="agent-review-modal" role="dialog" aria-modal="true" aria-labelledby="owner-review-title">
      <button className="agent-modal-close" aria-label="Close transaction review" onClick={() => setPendingTx(null)}><X size={17} /></button>
      <span className="agent-kicker">OWNER WALLET REVIEW · TESTNET</span><h2 id="owner-review-title">Review before signing</h2>
      <div className="agent-review-warning"><AlertTriangle size={16} /> Nothing is signed until you approve in your wallet. Read the transaction in both places.</div>
      <p>{pendingTx.description}</p><div className="agent-review-facts"><span>Action</span><b>{pendingAction}</b><span>Owner account</span><b>{shortAddress(pendingOwner)}</b><span>Network</span><b>{pendingTx.network}</b><span>Permissions</span><b>prediction {pendingTx.permissions.prediction} · account {pendingTx.permissions.account}</b></div>
      <details><summary>Transaction payload</summary><pre>{pendingTx.transaction}</pre></details>
      <div className="agent-modal-actions"><button className="agent-secondary" onClick={() => setPendingTx(null)}>Cancel</button><button className="agent-primary" disabled={!!busy} onClick={() => void approveOwnerAction()}>{busy === "wallet-sign" ? "Awaiting wallet…" : "Open wallet to sign"}</button></div>
    </section></div>}
  </div>;
}
export default AgentPage;