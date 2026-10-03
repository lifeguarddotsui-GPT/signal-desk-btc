import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Activity, AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, CircleHelp, Clock3, LockKeyhole, Pause, RefreshCw, Shield, ShieldCheck, Wallet, X } from "lucide-react";
import { getWallets, type WalletAccount } from "@mysten/wallet-standard";
import { agentPolicySchema, defaultAgentPolicy, policySummary, type AgentPolicy } from "../../shared/agent-policy";
import { agentDate, asErrorMessage, changePolicyLimitMode, copyPolicy, policyAmountInputValue, policyValueFromInput } from "./agent-format";
import AgentCurrentRound from "./AgentCurrentRound";

type Paper = { startingCents: number; availableCents: number; committedCents: number; turnoverCents: number; realizedPnlCents: number; highWaterCents: number; consecutiveLosses: number; targetCents: number | null; startedAt: number | null };
type LedgerItem = { id: string; event: string; at: number | string; details: unknown };
type AgentState = { owner: string; policy: AgentPolicy; policyVersion: number; status: "PAUSED" | "SHADOW" | "LOSS_STOP" | "TARGET_REACHED"; accountId: string | null; delegateAddress: string | null; delegateExpiresAtMs: number | null; paper: Paper | null; ledger: LedgerItem[]; summary: string[]; blockers: string[]; balances: null; walletSessionExpiresAtMs?: number | null };
type Capabilities = { developmentOnly: boolean; sdkVersion: string; network: "mainnet"; globalExecutionDisabled: boolean; mainnetEnabled: boolean; blockers: string[]; defaultPolicy: AgentPolicy; permissions: { prediction: number; account: number }; config: { status: "VERIFIED_IDENTITY_ONLY" | "UNAVAILABLE" | string; reason: string; decimals?: number; marketSemanticsVerified?: false; settlements?: unknown; packages?: unknown } };
type OwnerTransaction = { transaction: string; description: string; network: "mainnet"; permissions: { account: number; prediction: number } };
type WalletLike = { name: string; icon?: string; chains?: string[]; features?: Record<string, { connect?: () => Promise<{ accounts?: WalletAccount[] }>; signPersonalMessage?: (input: { message: Uint8Array; account: WalletAccount; chain?: string }) => Promise<{ signature: string; bytes?: string }> } | undefined>; accounts?: WalletAccount[] };
type WalletIdentity = { address: string; wallet: WalletLike | null; account: WalletAccount | null; generation: number };
const identityStillCurrent = (expected: WalletIdentity, current: WalletIdentity) =>
  expected.generation === current.generation && expected.address !== "" &&
  expected.address.toLowerCase() === current.address.toLowerCase() &&
  expected.wallet === current.wallet &&
  expected.account?.address.toLowerCase() === current.account?.address.toLowerCase() &&
  accountIsMainnet(expected.account) && accountIsMainnet(current.account) &&
  (!expected.wallet?.accounts || expected.wallet.accounts.some(account => account.address.toLowerCase() === expected.address.toLowerCase()));
const BASE = "/api/agent";
const messageOf = async (response: Response) => {
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
};
async function request<T>(path: string, method = "GET", body?: unknown, authenticatedIdentity?: WalletIdentity): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { method, credentials: "include", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (response.status === 401 && authenticatedIdentity && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("agent:session-unauthorized", { detail: { generation: authenticatedIdentity.generation } }));
  }
  return await messageOf(response) as T;
}
const walletFeature = (wallet: WalletLike, name: string) => wallet.features?.[name] ?? {};
const MAINNET = "sui:mainnet";
const accountChains = (account: WalletAccount) => (account as WalletAccount & { chains?: string[] }).chains ?? [];
const accountIsMainnet = (account: WalletAccount | undefined | null) => !!account && accountChains(account).includes(MAINNET);
const eligibleWallet = (wallet: WalletLike) => {
  if (!wallet || typeof wallet.name !== "string" || !wallet.features || typeof wallet.features !== "object") return false;
  return typeof walletFeature(wallet, "standard:connect").connect === "function" &&
    typeof walletFeature(wallet, "sui:signPersonalMessage").signPersonalMessage === "function";
};
const shortAddress = (address: string) => address.length > 18 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
const centsFrom = (value: string) => Math.round(Number(value || 0) * 100);
function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return <label className="agent-field"><span>{label}</span>{children}{help && <small>{help}</small>}</label>;
}
function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} disabled={disabled} className={`agent-toggle${checked ? " on" : ""}`} onClick={() => onChange(!checked)}><i />{label}</button>;
}
function MoneyField({ label, cents, onChange, nullable = false, help, maxCents, disabled = false }: { label: string; cents: number | null; onChange: (v: number | null) => void; nullable?: boolean; help?: string; maxCents?: number; disabled?: boolean }) {
  return <Field label={label} help={help}><div className="agent-input-wrap"><span>$</span><input disabled={disabled} type="number" min="0" max={maxCents == null ? undefined : maxCents / 100} step="0.01" value={cents == null ? "" : (cents / 100).toFixed(2)} placeholder={nullable ? "No limit" : "0.00"} onChange={e => onChange(e.target.value === "" && nullable ? null : Math.min(centsFrom(e.target.value), maxCents ?? Number.MAX_SAFE_INTEGER))} />{nullable && <button type="button" disabled={disabled} className="agent-inline-action" onClick={() => onChange(cents == null ? 0 : null)}>{cents == null ? "Set" : "Unlimited"}</button>}</div></Field>;
}
const betaPolicy = (policy: AgentPolicy): AgentPolicy => ({
  ...copyPolicy(policy),
  network: "mainnet",
  sizingMode: "FIXED",
  fixedCents: Math.min(500, Math.max(1, policy.fixedCents || 500)),
  allocationCents: Math.min(500, Math.max(1, policy.allocationCents || 500)),
  compound: false,
  dailyTurnoverCents: Math.min(500, policy.dailyTurnoverCents ?? 500),
  maxOrderCents: Math.min(500, policy.maxOrderCents ?? 500),
  maxUnresolved: { mode: "AMOUNT", value: 1000 },
});
const ledgerDetails = (details: unknown) => {
  if (typeof details === "string") return details;
  if (details == null) return "No details returned.";
  try { return JSON.stringify(details, null, 2); }
  catch { return String(details); }
};
function AgentPage() {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [state, setState] = useState<AgentState | null>(null);
  const [policyDraft, setPolicyDraft] = useState<AgentPolicy>(() => betaPolicy(defaultAgentPolicy));
  const [wallets, setWallets] = useState<WalletLike[]>([]);
  const [wallet, setWallet] = useState<WalletLike | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<WalletAccount | null>(null);
  const [address, setAddress] = useState("");
  const [lastSessionExpiryMs, setLastSessionExpiryMs] = useState<number | null>(null);
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
  const [pendingTx, setPendingTx] = useState<OwnerTransaction | null>(null);
  const [pendingAction, setPendingAction] = useState("");
  const [pendingOwner, setPendingOwner] = useState("");
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
  const policy = betaPolicy(dirtyPolicy ? policyDraft : state?.policy ?? policyDraft);
  const isAuthorized = !!state && !!address && selectedAccount?.address.toLowerCase() === address.toLowerCase() && state.owner.toLowerCase() === address.toLowerCase() && lastSessionExpiryMs != null && lastSessionExpiryMs > Date.now();
  const rememberSessionExpiry = (expiry: number | null | undefined) => {
    if (typeof expiry === "number" && Number.isFinite(expiry) && expiry > 0) setLastSessionExpiryMs(expiry);
  };

  const loadState = useCallback(async (quiet = false) => {
    if (!address) return;
    const seq = ++requestSeq.current;
    try {
      const expectedIdentity = identityRef.current;
      const next = await request<AgentState>("/state", "GET", undefined, expectedIdentity);
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
      rememberSessionExpiry(next.walletSessionExpiresAtMs);
      const previousVersion = stateRef.current?.policyVersion;
      setState(next);
      if (!dirtyPolicyRef.current) {
        setPolicyDraft(betaPolicy(next.policy));
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
    request<Capabilities>("/capabilities").then(data => { if (active) { setCapabilities(data); setPolicyDraft(betaPolicy(data.defaultPolicy)); } }).catch(error => { if (active) setPageError(asErrorMessage(error, "Agent capabilities are unavailable.")); });
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
    setLastSessionExpiryMs(null);
    setWallet(null);
    setSelectedAccount(null);
    setPolicyDraft(betaPolicy(capabilities?.defaultPolicy ?? defaultAgentPolicy));
    setDirtyPolicy(false);
    setPendingTx(null);
    setAccounts([]);
    setSettlementInfo(null);
    setLastUpdated(0);
    setFundingAmount("");
    setCoinIds("");
    setPaperCapital("");
    setNotice("");
    setPageError("");
    accountRef.current = "";
    identityRef.current = { address: "", wallet: null, account: null, generation };
    if (logout) await request("/logout", "POST", {}).catch(() => undefined);
  }, [capabilities]);

  useEffect(() => {
    const onUnauthorized = (event: Event) => {
      const detail = (event as CustomEvent<{ generation?: number }>).detail;
      if (detail?.generation == null || detail.generation !== identityRef.current.generation || !identityRef.current.address) return;
      void clearIdentity(false).then(() => setPageError("The authenticated session expired or was rejected. Reconnect your mainnet wallet."));
    };
    window.addEventListener("agent:session-unauthorized", onUnauthorized);
    return () => window.removeEventListener("agent:session-unauthorized", onUnauthorized);
  }, [clearIdentity]);

  useEffect(() => {
    if (!address || lastSessionExpiryMs == null) return;
    const expireIfDue = () => {
      const remaining = lastSessionExpiryMs - Date.now();
      if (remaining > 0) {
        timer = window.setTimeout(expireIfDue, remaining);
        return;
      }
      if (!identityRef.current.address) return;
      void clearIdentity(false).then(() => setPageError("The 15-minute wallet session expired. Reconnect to continue."));
    };
    let timer = window.setTimeout(expireIfDue, Math.max(0, lastSessionExpiryMs - Date.now()));
    return () => window.clearTimeout(timer);
  }, [address, lastSessionExpiryMs, clearIdentity]);

  const connectWallet = async (candidate: WalletLike) => {
    let generation: number | null = null;
    let boundAddress = "";
    setBusy("connect"); setPageError(""); setNotice("");
    try {
      const connect = walletFeature(candidate, "standard:connect").connect;
      if (!connect) throw new Error("This wallet does not provide standard:connect.");
      const result = await connect();
      const account = [...(result.accounts ?? candidate.accounts ?? [])].find(accountIsMainnet);
      if (!account?.address) throw new Error("This wallet did not return an account enabled for Sui mainnet. No login signature was requested.");
      await clearIdentity(true);
      accountRef.current = account.address;
      boundAddress = account.address;
      generation = sessionGeneration.current;
      identityRef.current = { address: boundAddress, wallet: candidate, account, generation };
      setWallet(candidate); setSelectedAccount(account); setAddress(account.address);
      const isCurrent = () => identityRef.current.generation === generation &&
        identityRef.current.address.toLowerCase() === boundAddress.toLowerCase() &&
        identityRef.current.wallet === candidate && identityRef.current.account?.address === boundAddress &&
        accountIsMainnet(identityRef.current.account);
      if (!accountIsMainnet(account)) throw new Error("A Sui mainnet account is required before requesting a login signature.");
      const challenge = await request<{ message: string }>("/challenge", "POST", { address: account.address, chain: MAINNET });
      if (!isCurrent()) return;
      const signMessage = walletFeature(candidate, "sui:signPersonalMessage").signPersonalMessage;
      if (!signMessage) throw new Error("This wallet does not provide sui:signPersonalMessage.");
      if (!accountIsMainnet(identityRef.current.account)) throw new Error("The selected account is not enabled for Sui mainnet; no signature was requested.");
      const signed = await signMessage({ message: new TextEncoder().encode(challenge.message), account, chain: MAINNET });
      if (!isCurrent()) return;
      const authResult = await request<{ walletSessionExpiresAtMs?: number | null }>("/auth", "POST", { message: challenge.message, signature: signed.signature, chain: MAINNET });
      rememberSessionExpiry(authResult.walletSessionExpiresAtMs);
      if (typeof authResult.walletSessionExpiresAtMs !== "number" ||
        !Number.isFinite(authResult.walletSessionExpiresAtMs) ||
        authResult.walletSessionExpiresAtMs <= Date.now()) {
        throw new Error("Authentication did not return a future stored session expiry. Session withheld.");
      }
      if (!isCurrent()) {
        void request("/logout", "POST", {}).catch(() => undefined);
        return;
      }
      const authenticatedState = await request<AgentState>("/state", "GET", undefined, identityRef.current);
      if (!isCurrent()) return;
      if (authenticatedState.owner.toLowerCase() !== boundAddress.toLowerCase()) throw new Error("Authenticated agent owner did not match the connected wallet.");
      rememberSessionExpiry(authenticatedState.walletSessionExpiresAtMs);
      if (typeof authenticatedState.walletSessionExpiresAtMs !== "number" ||
        !Number.isFinite(authenticatedState.walletSessionExpiresAtMs) ||
        authenticatedState.walletSessionExpiresAtMs <= Date.now()) {
        throw new Error("The stored wallet session is already expired. Session withheld.");
      }
      setState(authenticatedState);
      setPolicyDraft(betaPolicy(authenticatedState.policy));
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
      const next = change.accounts?.find(account => account.address === address && accountIsMainnet(account));
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
      const next = betaPolicy(updater(betaPolicy(old)));
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
    const validation = agentPolicySchema.safeParse(betaPolicy(policyDraft));
    if (!validation.success) {
      const issue = validation.error.issues[0];
      setPageError(`${issue.path.join(".") || "policy"}: ${issue.message}`);
      return;
    }
    setBusy("policy"); setPageError(""); setNotice("");
    try { const result = await request<AgentState>("/policy", "POST", { policy: betaPolicy(validation.data) }, identityRef.current); rememberSessionExpiry(result.walletSessionExpiresAtMs); setState(result); setPolicyDraft(betaPolicy(result.policy)); setDirtyPolicy(false); setNotice("Policy saved to the authenticated agent account with fixed beta limits."); }
    catch (error) { setPageError(asErrorMessage(error)); }
    finally { setBusy(""); }
  };
  const control = async (action: "PAUSE" | "ARM_SHADOW" | "STOP_GOAL") => {
    setBusy(action); setPageError(""); setNotice("");
    try {
      const result = await request<AgentState>("/control", "POST", { action, ...(action === "ARM_SHADOW" && paperCapital !== "" ? { paperCapitalCents: centsFrom(paperCapital) } : {}), acknowledged: action !== "ARM_SHADOW" || ((policy.frequency !== "EVERY_ELIGIBLE_ROUND" || everyRoundAck) && (policy.edgeEnabled || edgeOffAck) && (policy.reserveCents !== 0 || zeroReserveAck)), ...(!policy.edgeEnabled ? { edgeOffConfirmed: edgeOffAck } : {}), ...(policy.reserveCents === 0 ? { zeroReserveConfirmed: zeroReserveAck } : {}) }, identityRef.current);
      rememberSessionExpiry(result.walletSessionExpiresAtMs);
      setState(result); setPolicyDraft(betaPolicy(result.policy)); setNotice(action === "ARM_SHADOW" ? "Shadow observation requested. Mainnet execution remains blocked." : action === "PAUSE" ? "Persistent pause requested." : "Goal stop requested.");
      if (action === "ARM_SHADOW") { setEveryRoundAck(false); setEdgeOffAck(false); setZeroReserveAck(false); }
    } catch (error) { setPageError(asErrorMessage(error)); }
    finally { setBusy(""); }
  };
  const beginOwnerAction = async (action: string, extra: Record<string, unknown> = {}) => {
    const identity = identityRef.current;
    if (!identity.wallet || !identity.account || !isAuthorized || !state) return;
    setBusy("prepare"); setPageError(""); setNotice("");
    try {
      const response = await request<OwnerTransaction>("/owner-transaction", "POST", { action, ...(action !== "CREATE_ACCOUNT" && state.accountId ? { accountId: state.accountId } : {}), ...extra }, identity);
      if (!identityStillCurrent(identity, identityRef.current)) return;
      setPendingTx(response); setPendingAction(action);
      setPendingOwner(identity.address);
    } catch (error) { setPageError(asErrorMessage(error)); }
    finally { setBusy(""); }
  };
  const accountOptions = async () => {
    setBusy("accounts");
    try { const result = await request<{ accounts: { accountId: string }[]; settlementCoinType: string; network: string; decimals?: number }>("/accounts", "POST", {}, identityRef.current); setAccounts(result.accounts); setSettlementInfo({ coinType: result.settlementCoinType, network: result.network, decimals: result.decimals }); setNotice(result.accounts.length ? `${result.accounts.length} agent account${result.accounts.length === 1 ? "" : "s"} returned. Select one below.` : "No agent accounts were returned."); }
    catch (error) { setPageError(asErrorMessage(error)); }
    finally { setBusy(""); }
  };
  const setAccount = async (accountId: string) => {
    setBusy("account");
    try { const result = await request<AgentState>("/account", "POST", { accountId }, identityRef.current); rememberSessionExpiry(result.walletSessionExpiresAtMs); setState(result); setPolicyDraft(betaPolicy(result.policy)); setDirtyPolicy(false); setNotice("Agent account selected."); }
    catch (error) { setPageError(asErrorMessage(error)); }
    finally { setBusy(""); }
  };
  const cap = capabilities;
  const blockers = Array.from(new Set([...(cap?.blockers ?? []), ...(state?.blockers ?? [])]));
  const status = state?.status ?? "PAUSED";
  const accountId = state?.accountId;

  return <div className="page agent-page">
    <header className="agent-mast">
      <div><div className="eyebrow">BLUEWATERAI / AGENT CONTROL</div><h1>Evidence first. <em>Execution blocked.</em></h1><p>Separate research from authority. Wallet identity grants no order permission.</p></div>
      <div className="agent-mast-badge"><span className="agent-pulse" />EXPERIMENTAL MAINNET <b>·</b> NOT RELEASED</div>
    </header>

    <section className="agent-safety-strip">
      <ShieldCheck size={19} /><div><strong>DEVELOPMENT ONLY · no executable adapter is verified</strong><span>Identity only; execution remains blocked until release review. No hypothetical fills, trade outcomes, or compounding results are generated here.</span></div><span className="agent-permission">EXECUTION OFF</span>
    </section>
    <div className="agent-release-banner" style={{ display: "flex", gap: 12, alignItems: "flex-start", margin: "14px 0", padding: "14px 16px", border: "1px solid #e7c9a9", borderRadius: 10, background: "#fbf2e7", color: "#73543a", fontSize: 12, lineHeight: 1.55 }}><LockKeyhole size={16} /><div><strong style={{ display: "block", marginBottom: 3, color: "#764a28", fontFamily: "monospace", fontSize: 10, letterSpacing: ".08em" }}>NOT A LIVE OR PRODUCTION BETA</strong>Wallet login proves identity only. The $5 cap below is a policy ceiling, not an executable quote or permission to trade. Any future cap is $5 all-in settlement collateral per exact 5m or 15m round; SUI gas is separate and not included.</div></div>

    <div className="agent-overview">
      <section className="agent-status-panel">
        <div className="agent-section-top"><span className="agent-kicker">CONTROL STATE</span><span className={`agent-status ${status.toLowerCase()}`}><i />{status.replace("_", " ")}</span></div>
        <div className="agent-status-main"><strong>{isAuthorized ? "CONNECTED MAINNET · IDENTITY ONLY" : "Execution blocked"}</strong><p>{isAuthorized ? `Authenticated owner ${shortAddress(address)} · 15-minute HttpOnly session expires ${agentDate(lastSessionExpiryMs)}; wallet login grants no trading authority.` : "Connect a compatible Sui mainnet wallet to load private agent state."}</p></div>
        <div className="agent-actions">
          <button className="agent-primary" disabled title="Unavailable until release review"><Activity size={15} /> Execution unavailable</button>
          <button className="agent-pause" disabled={!isAuthorized || !!busy || status === "PAUSED"} onClick={() => void control("PAUSE")}><Pause size={15} /> Pause</button>
          {isAuthorized ? <button className="agent-logout" disabled={!!busy} onClick={() => void logout()}><X size={15} /> Disconnect</button> : <div className="agent-wallet-picker"><Wallet size={15} /><select aria-label="Connect compatible Sui mainnet wallet" value="" disabled={!wallets.length || !!busy} onChange={e => { const selected = wallets[Number(e.target.value)]; if (selected) void connectWallet(selected); }}><option value="">{wallets.length ? "CONNECT WALLET" : "No compatible wallet detected"}</option>{wallets.map((item, i) => <option key={`${item.name}-${i}`} value={i}>{item.name}</option>)}</select></div>}
        </div>
        <div className="agent-paper-capital"><label>Wallet authority <small>identity session only · no order signer</small></label><div className="agent-locked-control"><LockKeyhole size={14} /> No trading permission granted</div></div>
        <div className="agent-auth-note"><LockKeyhole size={13} /> Mainnet-bound short-lived login challenge. No transaction signature requested on connect.</div>
      </section>

      <section className="agent-equity-panel">
        <div className="agent-section-top"><span className="agent-kicker">WALLET / SETTLEMENT STATUS</span><button className="agent-icon-button" aria-label="Refresh private state" disabled={!isAuthorized || !!busy} onClick={() => void loadState()}><RefreshCw size={14} /></button></div>
        <div className="agent-equity">NOT AVAILABLE</div><div className="agent-equity-caption">Balance not reported · no wallet balance, executable quote, or fill.</div>
        <div className="agent-mini-stats"><div><span>ORDER STATE</span><b>BLOCKED</b></div><div><span>FILLS</span><b>None reported</b></div><div><span>DELEGATION</span><b>Unavailable</b></div></div>
        <small className="agent-unverified-copy">There is no verified WaterX settlement path or live account balance in this development-only interface.</small>
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
              <Field label="Network" help="Identity may connect to mainnet; execution is not released."><select value="mainnet" disabled><option value="mainnet">Sui mainnet · identity only</option></select></Field>
              <Field label="Eligible round intervals"><div className="agent-choice-row">{([5, 15] as const).map(n => <button type="button" key={n} className={policy.intervals.includes(n) ? "chosen" : ""} aria-pressed={policy.intervals.includes(n)} onClick={() => changePolicy(p => ({ ...p, intervals: p.intervals.includes(n) ? p.intervals.filter(v => v !== n) as AgentPolicy["intervals"] : [...p.intervals, n].sort() as AgentPolicy["intervals"] }))}>{n} minutes</button>)}</div></Field>
              <Field label="Signal source" help="Research evidence is produced by Bluewater champion."><select value={policy.signalSource} onChange={e => changePolicy(p => ({ ...p, signalSource: e.target.value as AgentPolicy["signalSource"] }))}><option value="BLUEWATER_CHAMPION">Bluewater champion</option></select></Field>
              <Field label="Frequency"><select value={policy.frequency} onChange={e => changePolicy(p => ({ ...p, frequency: e.target.value as AgentPolicy["frequency"] }))}><option value="SELECTIVE">Selective</option><option value="EVERY_ELIGIBLE_ROUND">Every eligible round</option></select></Field>
              {policy.frequency === "SELECTIVE" && <Field label="Selective minimum probability" help="Fraction from 0.50 to 1.00."><div className="agent-input-wrap"><input type="number" min=".5" max="1" step=".01" value={policy.selectiveMinProbability} onChange={e => changePolicy(p => ({ ...p, selectiveMinProbability: Number(e.target.value) }))} /><span>fraction</span></div></Field>}
              <Field label="Verified edge filter"><Toggle checked={policy.edgeEnabled} onChange={edgeEnabled => changePolicy(p => ({ ...p, edgeEnabled }))} label={policy.edgeEnabled ? "On" : "Off"} /></Field>
              {policy.edgeEnabled && <Field label="Minimum edge" help="Percentage points after verified costs."><div className="agent-input-wrap"><input type="number" min="0" max="100" step=".1" value={policy.minimumEdgePp} onChange={e => changePolicy(p => ({ ...p, minimumEdgePp: Number(e.target.value) }))} /><span>pp</span></div></Field>}
              <Field label="Sizing mode" help="Beta sizing is fixed only."><select value="FIXED" disabled><option value="FIXED">Fixed amount</option></select></Field>
              <MoneyField label="Fixed order size ceiling" cents={policy.fixedCents} maxCents={500} onChange={v => changePolicy(p => ({ ...p, fixedCents: Math.min(v ?? 500, 500) }))} help="Up to $5.00. This setting does not execute an order." />
              <MoneyField label="Allocation amount ceiling" cents={policy.allocationCents} maxCents={500} onChange={v => changePolicy(p => ({ ...p, allocationCents: Math.min(v ?? 500, 500) }))} />
              <Field label="Compounding" help="Disabled for this development-only beta policy."><Toggle checked={false} disabled onChange={() => undefined} label="Off · locked" /></Field>
              <MoneyField label="Daily turnover limit" cents={policy.dailyTurnoverCents} maxCents={500} onChange={v => changePolicy(p => ({ ...p, dailyTurnoverCents: Math.min(v ?? 500, 500) }))} help="Fixed at or below $5.00; unlimited turnover is unavailable." />
              <Field label="Daily loss guard"><div className="agent-pair-fields"><select aria-label="Daily loss mode" value={policy.dailyLoss?.mode ?? "AMOUNT"} onChange={e => changePolicy(p => { const mode = e.target.value as "AMOUNT" | "PERCENT"; const from = p.dailyLoss?.mode ?? mode; return { ...p, dailyLoss: { mode, value: p.dailyLoss ? changePolicyLimitMode(from, mode, p.dailyLoss.value) : mode === "AMOUNT" ? 100 : 1 } }; })}><option value="AMOUNT">Amount</option><option value="PERCENT">Percent</option></select><div className="agent-input-wrap"><input aria-label="Daily loss value" type="number" min=".01" max={policy.dailyLoss?.mode === "PERCENT" ? 100 : 1000000} step={policy.dailyLoss?.mode === "PERCENT" ? ".1" : ".01"} value={policy.dailyLoss ? policyAmountInputValue(policy.dailyLoss.mode, policy.dailyLoss.value) : ""} placeholder="Disabled" onChange={e => changePolicy(p => ({ ...p, dailyLoss: e.target.value === "" ? null : { mode: p.dailyLoss?.mode ?? "AMOUNT", value: policyValueFromInput(p.dailyLoss?.mode ?? "AMOUNT", e.target.value) } }))} /><span>{policy.dailyLoss?.mode === "PERCENT" ? "%" : "$"}</span></div></div></Field>
              <Field label="Maximum drawdown"><div className="agent-input-wrap"><input type="number" min="0" max="100" step=".1" placeholder="Disabled" value={policy.maxDrawdownPercent ?? ""} onChange={e => changePolicy(p => ({ ...p, maxDrawdownPercent: e.target.value === "" ? null : Number(e.target.value) }))} /><span>%</span></div></Field>
              <Field label="Maximum consecutive losses"><input type="number" min="1" step="1" placeholder="Disabled" value={policy.maxConsecutiveLosses ?? ""} onChange={e => changePolicy(p => ({ ...p, maxConsecutiveLosses: e.target.value === "" ? null : Number(e.target.value) }))} /></Field>
              <MoneyField label="Reserve" cents={policy.reserveCents} onChange={v => changePolicy(p => ({ ...p, reserveCents: v ?? 0 }))} help="Zero reserve requires an explicit start confirmation." />
              <MoneyField label="Maximum order" cents={policy.maxOrderCents} maxCents={500} onChange={v => changePolicy(p => ({ ...p, maxOrderCents: Math.min(v ?? 500, 500) }))} />
              <MoneyField label="Maximum unresolved exposure" cents={policy.maxUnresolved.value} maxCents={1000} disabled onChange={() => undefined} help="Amount mode · $10.00 maximum." />
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
           <section className="agent-summary"><div><span className="agent-kicker">POLICY SUMMARY</span><span className="agent-summary-note">{dirtyPolicy ? "PREVIEW" : "CURRENT VIEW"}</span></div><ul>{policySummaries.map((line, i) => <li key={i}>{line}</li>)}</ul><p className="agent-unverified-copy">All-in settlement collateral is capped at $5.00 per exact round, independently for 5m and 15m. Overlapping intervals are separate exposure. SUI gas is additional and excluded from that cap.</p></section>
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
          <div className="agent-card-heading"><div><span className="agent-kicker">02 / CAPITAL & ACCOUNT</span><h2>Owner-controlled setup</h2><p>Account and funds actions can be reviewed. Wallet signing is disabled until release review.</p></div><span className="agent-flag">OWNER REVIEW ONLY</span></div>
          <div className="agent-account-row"><div><span>SELECTED ACCOUNT</span><strong>{accountId || "No agent account selected"}</strong></div><div className="agent-account-select"><select aria-label="Select an agent account" disabled={!accounts.length || !!busy} value={accountId || ""} onChange={e => { if (e.target.value) void setAccount(e.target.value); }}><option value="">{accounts.length ? "Choose returned account" : "No accounts loaded"}</option>{accounts.map(item => <option key={item.accountId} value={item.accountId}>{item.accountId}</option>)}</select><button className="agent-secondary" disabled={!isAuthorized || !!busy} onClick={() => void accountOptions()}><RefreshCw size={14} /> Refresh accounts</button></div></div>
          <div className="agent-owner-actions">
            <button disabled={!isAuthorized || !!busy} onClick={() => void beginOwnerAction("CREATE_ACCOUNT")}><Wallet size={15} /> Create account</button>
            <button disabled={!isAuthorized || !accountId || !/^[0-9]+$/.test(fundingAmount) || Number(fundingAmount) <= 0 || !!busy} onClick={() => void beginOwnerAction("FUND", { amountAtomic: fundingAmount, coinObjectIds: coinIds.split(",").map(x => x.trim()).filter(Boolean) })}><ArrowDownToLine size={15} /> Review funding</button>
            <button disabled title="Unsupported until independent mainnet delegation review"><Shield size={15} /> Create delegate · unavailable</button>
            <button disabled title="Unsupported until effective prediction-only permission is verified"><ShieldCheck size={15} /> Authorization unavailable</button>
            <button disabled={!isAuthorized || !accountId || !!busy} onClick={() => void beginOwnerAction("REVOKE")}><ShieldCheck size={15} /> Revoke delegate</button>
            <button disabled={!isAuthorized || !accountId || !!busy} onClick={() => void beginOwnerAction("WITHDRAW")}><ArrowUpFromLine size={15} /> Review withdrawal</button>
          </div>
          <div className="agent-funding-form">
            <Field label="Funding amount · atomic units" help="Settlement coin decimals are not assumed."><input inputMode="numeric" placeholder="Enter exact atomic amount" value={fundingAmount} onChange={e => setFundingAmount(e.target.value)} /></Field>
            <Field label="Coin object IDs" help="Comma-separated owner coin object IDs from your wallet."><input placeholder="Required only if service requests specific coins" value={coinIds} onChange={e => setCoinIds(e.target.value)} /></Field>
            <Field label="Mainnet delegate" help="No delegate is created or represented as authorized."><input readOnly value="Unavailable · release review required" /></Field>
            <Field label="Owner authorization" help="Unsupported in this release."><input readOnly value="Not authorized" /></Field>
          </div>
          <div className="agent-delegate-warning"><AlertTriangle size={15} /><span>Delegate creation and authorization are disabled. Account creation, selection, funding review, revoke review, and withdrawal review remain owner-controlled; wallet signing is blocked until release review.</span></div>
          <div className="agent-account-facts"><div><span>ACCOUNT ID</span><b>{accountId || "Not selected"}</b></div><div><span>DELEGATE ADDRESS</span><b>Not available</b></div><div><span>OWNER AUTHORIZATION</span><b>Not authorized</b></div><div><span>EFFECTIVE DELEGATE PERMISSION</span><b>Unavailable</b></div><div><span>ON-CHAIN BALANCES</span><b>Not requested / not reported</b></div></div>
          <p className="agent-caution"><AlertTriangle size={14} /> Settlement: {settlementInfo?.coinType ?? "not verified"} {settlementInfo?.decimals === 6 ? "· 6 decimals observed" : "· decimals not verified"} · USD is the settlement denomination, not automatically wallet USDC. Only an on-chain verified 6-decimal definition may be used. No USDC conversion or deposit is claimed.</p>
        </section>

        <section className="agent-card agent-ledger">
          <div className="agent-card-heading"><div><span className="agent-kicker">03 / AUDIT TRAIL</span><h2>Paper ledger</h2><p>Records are shown only when returned by the authenticated state API.</p></div><Clock3 size={18} /></div>
          {state?.ledger?.length ? <div className="agent-ledger-list">{state.ledger.slice().reverse().map(entry => <article key={entry.id}><time>{typeof entry.at === "number" ? agentDate(entry.at) : entry.at}</time><b>{entry.event}</b><pre>{ledgerDetails(entry.details)}</pre></article>)}</div> : <div className="agent-empty-ledger"><span>NO LEDGER RECORDS</span><p>{isAuthorized ? "The server has not reported any agent ledger events." : "Authenticate to load private ledger events."}</p></div>}
        </section>
      </main>

      <aside className="agent-side-column">
        <section className="agent-card agent-guard-card"><div className="agent-card-heading"><div><span className="agent-kicker">RELEASE GATES</span><h2>Execution blockers</h2></div><Shield size={18} /></div>
           <div className="agent-blocker-state"><i /> RELEASE UNAVAILABLE · EXECUTION BLOCKED</div>
          {blockers.length ? <ul className="agent-blockers">{blockers.map((item, i) => <li key={i}><AlertTriangle size={14} />{item}</li>)}</ul> : <p className="agent-unreported">No blocker list returned. This is not evidence of release readiness.</p>}
          <div className="agent-hard-blockers"><span>ALWAYS DISABLED HERE</span><b>Mainnet execution</b><b>Live automatic execution</b><b>Automatic claims</b><b>Account permissions</b></div>
          <button className="agent-quiet-link" onClick={() => setConfigInfoOpen(v => !v)} aria-expanded={configInfoOpen}><CircleHelp size={14} /> Configuration readiness <ChevronDown size={14} /></button>
           {configInfoOpen && <div className="agent-config-facts"><div><span>Service configuration</span><b>{cap?.config.status ?? "UNAVAILABLE"}</b></div><p>{cap?.config.reason || "Mainnet configuration is unavailable."}</p><div><span>Network</span><b>{cap?.network ?? "Not reported"}</b></div><div><span>Settlement decimals</span><b>{cap?.config.decimals === 6 ? "6 observed · verify on-chain before use" : "Not verified"}</b></div><div><span>Market semantics verified</span><b>No</b></div><div><span>SDK version</span><b>{cap?.sdkVersion || "Not reported"}</b></div><div><span>Global execution</span><b>Blocked in this interface</b></div></div>}
        </section>
        <section className="agent-card agent-paper-card"><div className="agent-card-heading"><div><span className="agent-kicker">SHADOW OBSERVATION ONLY</span><h2>Paper policy target</h2></div><span className="agent-shadow-tag">NOT LIVE</span></div>
           <div className="agent-goal-value">NO EXECUTION</div><p>Targets and paper counters are not presented as live balances or trading results.</p>
           <div className="agent-goal-note">No mainnet quote, order, fill, or realized P/L is available.</div>
           <div className="agent-goal-labels"><span>PER-ROUND LIMIT $5.00</span><span>GAS SEPARATE</span></div>
        </section>
        <section className="agent-card agent-copy-card"><span className="agent-kicker">RESEARCH IS NOT AUTHORITY</span><p>Research may inform a shadow decision. It cannot grant custody or turn this panel into a live trading interface.</p><div><span>Prediction permission</span><b>{cap?.permissions.prediction ?? 1}</b></div><div><span>Account permission</span><b>{cap?.permissions.account ?? 0}</b></div></section>
      </aside>
    </div>

    <footer className="agent-footer"><span>BLUEWATERAI AGENT · MAINNET IDENTITY ONLY</span><span>Balances are never inferred <i /> No background signing <i /> Execution blocked</span></footer>

    {pendingTx && <div className="agent-modal-backdrop" role="presentation"><section className="agent-review-modal" role="dialog" aria-modal="true" aria-labelledby="owner-review-title">
      <button className="agent-modal-close" aria-label="Close transaction review" onClick={() => setPendingTx(null)}><X size={17} /></button>
      <span className="agent-kicker">OWNER ACTION REVIEW · MAINNET IDENTITY</span><h2 id="owner-review-title">Review request</h2>
      <div className="agent-review-warning"><AlertTriangle size={16} /> Development-only. Transaction signing and execution are blocked. No wallet approval will be requested.</div>
      <p>{pendingTx.description}</p><div className="agent-review-facts"><span>Action</span><b>{pendingAction}</b><span>Owner account</span><b>{shortAddress(pendingOwner)}</b><span>Network</span><b>{pendingTx.network}</b><span>Permissions</span><b>prediction {pendingTx.permissions.prediction} · account {pendingTx.permissions.account}</b></div>
      <details><summary>Transaction payload</summary><pre>{pendingTx.transaction}</pre></details>
      <div className="agent-modal-actions"><button className="agent-secondary" onClick={() => setPendingTx(null)}>Close review</button><button className="agent-primary" disabled title="Signing is blocked until release review">Signing blocked</button></div>
    </section></div>}
  </div>;
}
export default AgentPage;