import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Check, LockKeyhole, RefreshCw, ShieldCheck, X } from "lucide-react";
import { getWallets, type WalletAccount } from "@mysten/wallet-standard";
import { agentPolicySchema, defaultAgentPolicy, policySummary, type AgentPolicy } from "../../shared/agent-policy";
import { agentDate, asErrorMessage, changePolicyLimitMode, copyPolicy, policyAmountInputValue, policyValueFromInput } from "./agent-format";
import AgentCurrentRound from "./AgentCurrentRound";
import GuidedAgentSetup from "./GuidedAgentSetup";
import AgentRunningView from "./AgentRunningView";
import { discoveredAccountSelection } from "../../shared/agent-onboarding";
import { dollarsToAtomicAmount, signReviewedOwnerTransaction } from "./owner-wallet-signing";

type Paper = { startingCents: number; availableCents: number; committedCents: number; turnoverCents: number; realizedPnlCents: number; highWaterCents: number; consecutiveLosses: number; targetCents: number | null; startedAt: number | null };
type LedgerItem = { id: string; event: string; at: number | string; details: unknown };
type AgentState = { owner: string; policy: AgentPolicy; policyVersion: number; status: "PAUSED" | "SHADOW" | "LOSS_STOP" | "TARGET_REACHED"; accountId: string | null; delegateAddress: string | null; delegateExpiresAtMs: number | null; paper: Paper | null; ledger: LedgerItem[]; summary: string[]; blockers: string[]; balances: unknown; walletSessionExpiresAtMs?: number | null };
type MainnetPreflight = {
  mode:"READ_ONLY_PREVIEW";ready:boolean;canSign:false;canSubmit:false;
  plannedStakeCents:number|null;observedAvailableCents:number|null;
  accountBalanceVerification:"VERIFIED_OWNER_ACCOUNT_READ"|"UNAVAILABLE";
  currentPolicyVersion:number;checks:{id:string;status:"PASS"|"BLOCKED"|"UNVERIFIED";detail:string}[];
};
type Capabilities = { developmentOnly: boolean; sdkVersion: string; network: "mainnet"; globalExecutionDisabled: boolean; mainnetEnabled: boolean; blockers: string[]; defaultPolicy: AgentPolicy; ownerSetupSigning?: boolean; readiness?: { released: boolean; items: { id: string; label: string; status: "IMPLEMENTED" | "UNVERIFIED" | "BLOCKED" | string; evidence?: string; nextAction?: string }[]; blocker?: string | null; nextAction?: string | null }; capabilities?: { shadow?: boolean; arming?: boolean; execution?: boolean; betaAuthorization?: boolean }; permissions: { prediction: number; account: number }; config: { status: "VERIFIED_IDENTITY_ONLY" | "UNAVAILABLE" | string; reason: string; decimals?: number; marketSemanticsVerified?: false; settlements?: unknown; packages?: unknown } };
type OwnerTransaction = { transaction: string; description: string; network: "mainnet"; permissions: { account: number; prediction: number } };
type FundingInfo = { accountId: string; network: string; availableAtomic: string; availableBalanceUsd: string; nativeUsdcSupported: boolean; walletUsdAtomic?: string | null; walletUsdcAtomic?: string | null; readAtMs: number };
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
const PENDING_OWNER_APPROVAL_KEY = "bluewater:pending-owner-approval";
const readPendingOwnerApproval = () => {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(window.sessionStorage.getItem(PENDING_OWNER_APPROVAL_KEY) ?? "null") as { digest?: string; owner?: string; action?: string } | null;
    return value && typeof value.owner === "string" && typeof value.action === "string" ? value : null;
  } catch { return null; }
};
function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return <label className="agent-field"><span>{label}</span>{children}{help && <small>{help}</small>}</label>;
}
function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} disabled={disabled} className={`agent-toggle${checked ? " on" : ""}`} onClick={() => onChange(!checked)}><i />{label}</button>;
}
function MoneyField({ label, cents, onChange, nullable = false, help, maxCents, disabled = false }: { label: string; cents: number | null; onChange: (v: number | null) => void; nullable?: boolean; help?: string; maxCents?: number; disabled?: boolean }) {
  return <Field label={label} help={help}><div className="agent-input-wrap"><span>$</span><input disabled={disabled} type="number" min="0" max={maxCents == null ? undefined : maxCents / 100} step="0.01" value={cents == null ? "" : (cents / 100).toFixed(2)} placeholder={nullable ? "No limit" : "0.00"} onChange={e => onChange(e.target.value === "" && nullable ? null : Math.min(centsFrom(e.target.value), maxCents ?? Number.MAX_SAFE_INTEGER))} />{nullable && <button type="button" disabled={disabled} className="agent-inline-action" onClick={() => onChange(cents == null ? 0 : null)}>{cents == null ? "Set" : "Unlimited"}</button>}</div></Field>;
}
const completePolicy = (policy: Partial<AgentPolicy> | null | undefined): AgentPolicy =>
  copyPolicy({ ...defaultAgentPolicy, ...(policy ?? {}) } as AgentPolicy);
const ledgerDetails = (details: unknown) => {
  if (typeof details === "string") return details;
  if (details == null) return "No details returned.";
  try { return JSON.stringify(details, null, 2); }
  catch { return String(details); }
};
function AgentPage() {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [state, setState] = useState<AgentState | null>(null);
  const [policyDraft, setPolicyDraft] = useState<AgentPolicy>(() => completePolicy(defaultAgentPolicy));
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
  const [usdcFundingAmount, setUsdcFundingAmount] = useState("");
  const [coinIds, setCoinIds] = useState("");
  const [settlementInfo, setSettlementInfo] = useState<{ coinType: string; network: string; decimals?: number; conversionAvailable?: boolean; collateral?: string } | null>(null);
  const [pendingTx, setPendingTx] = useState<OwnerTransaction | null>(null);
  const [pendingAction, setPendingAction] = useState("");
  const [pendingOwner, setPendingOwner] = useState("");
  const [ownerPayload, setOwnerPayload] = useState<Record<string, unknown> | null>(null);
  const [simulation, setSimulation] = useState<{ success: boolean; checksEnabled: boolean; gasBudgetMist: number; network: string } | null>(null);
  const [ownerChoice, setOwnerChoice] = useState(false);
  const [experimentalConfirmed, setExperimentalConfirmed] = useState(false);
  const [compoundingConfirmed, setCompoundingConfirmed] = useState(false);
  const [walletRecovery, setWalletRecovery] = useState("");
  const [pendingActionType, setPendingActionType] = useState("");
  const [accounts, setAccounts] = useState<{ accountId: string }[]>([]);
  const [discoveryStatus, setDiscoveryStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [discoveryError, setDiscoveryError] = useState("");
  const [fundingInfo, setFundingInfo] = useState<FundingInfo | null>(null);
  const [pilotPreflight, setPilotPreflight] = useState<MainnetPreflight | null>(null);
  const [shadowPreview, setShadowPreview] = useState(false);
  const discoverySeq = useRef(0);
  const balanceSeq = useRef(0);
  const quickActionActive = useRef(false);
  const [uncertainDigest, setUncertainDigest] = useState(() => readPendingOwnerApproval()?.digest ?? "");
  const [uncertainOwner, setUncertainOwner] = useState(() => readPendingOwnerApproval()?.owner ?? "");
  const [uncertainAction, setUncertainAction] = useState(() => readPendingOwnerApproval()?.action ?? "");
  const [ownerSubmissionPending, setOwnerSubmissionPending] = useState(() => readPendingOwnerApproval() != null);
  const [lastUpdated, setLastUpdated] = useState(0);
  const requestSeq = useRef(0);
  const capabilitySeq = useRef(0);
  const accountRef = useRef("");
  const sessionGeneration = useRef(0);
  const pendingGeneration = useRef<number | null>(null);
  const identityRef = useRef<WalletIdentity>({ address: "", wallet: null, account: null, generation: 0 });
  const stateRef = useRef<AgentState | null>(null);
  const dirtyPolicyRef = useRef(false);
  stateRef.current = state;
  dirtyPolicyRef.current = dirtyPolicy;
  const policy = completePolicy(dirtyPolicy ? policyDraft : state?.policy ?? policyDraft);
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
      if (seq !== requestSeq.current || !identityStillCurrent(expectedIdentity, identityRef.current) || accountRef.current.toLowerCase() !== address.toLowerCase()) return;
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
      if (previousVersion != null && previousVersion !== next.policyVersion) {
        setEveryRoundAck(false);
        setEdgeOffAck(false);
        setZeroReserveAck(false);
        setExperimentalConfirmed(false);
        setCompoundingConfirmed(false);
      }
      setState(next);
      if (!dirtyPolicyRef.current) {
         setPolicyDraft(completePolicy(next.policy));
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
    const seq = ++capabilitySeq.current;
    let active = true;
    request<Capabilities>("/capabilities").then(data => {
      if (!active || seq !== capabilitySeq.current) return;
      setCapabilities(data);
      if (!dirtyPolicyRef.current) setPolicyDraft(completePolicy(data.defaultPolicy));
    }).catch(error => {
      if (active && seq === capabilitySeq.current) setPageError(asErrorMessage(error, "Agent capabilities are unavailable."));
    });
    return () => { active = false; };
  }, [isAuthorized]);

  useEffect(() => {
    if (!isAuthorized) return;
    void loadState();
    const timer = window.setInterval(() => { void loadState(true); }, 5000);
    return () => window.clearInterval(timer);
  }, [isAuthorized, loadState]);

  // Restore only a live server session whose owner is already exposed by a
  // connected mainnet wallet. Never request a signature or connect prompt.
  useEffect(() => {
    if (address || busy || !wallets.some(w => w.accounts?.some(accountIsMainnet))) return;
    const generation = identityRef.current.generation;
    let active = true;
    void request<AgentState>("/state").then(next => {
      if (!active || identityRef.current.generation !== generation || identityRef.current.address ||
          !next.walletSessionExpiresAtMs || next.walletSessionExpiresAtMs <= Date.now()) return;
      const candidate = wallets.find(w => w.accounts?.some(a => accountIsMainnet(a) && a.address.toLowerCase() === next.owner.toLowerCase()));
      const account = candidate?.accounts?.find(a => accountIsMainnet(a) && a.address.toLowerCase() === next.owner.toLowerCase());
      if (!candidate || !account) return;
      accountRef.current = account.address;
      identityRef.current = { address: account.address, wallet: candidate, account, generation };
      setWallet(candidate); setSelectedAccount(account); setAddress(account.address);
      setState(next); stateRef.current = next; rememberSessionExpiry(next.walletSessionExpiresAtMs);
      setPolicyDraft(completePolicy(next.policy)); setLastUpdated(Date.now());
    }).catch(() => undefined);
    return () => { active = false; };
  }, [wallets, address, busy]);

  const clearIdentity = useCallback(async (logout = true) => {
    const generation = ++sessionGeneration.current;
    requestSeq.current++;
    setState(null);
    setAddress("");
    setLastSessionExpiryMs(null);
    setWallet(null);
    setSelectedAccount(null);
    setPolicyDraft(completePolicy(capabilities?.defaultPolicy ?? defaultAgentPolicy));
    setDirtyPolicy(false);
    setPendingTx(null);
    if (!ownerSubmissionPending) {
      setUncertainDigest("");
      setUncertainOwner("");
      setUncertainAction("");
    }
    setOwnerPayload(null);
    setSimulation(null);
    setOwnerChoice(false);
    setExperimentalConfirmed(false);
    setCompoundingConfirmed(false);
    setEveryRoundAck(false);
    setEdgeOffAck(false);
    setZeroReserveAck(false);
    setAccounts([]);
    discoverySeq.current++;
    balanceSeq.current++;
    setDiscoveryStatus("idle");
    setDiscoveryError("");
    setFundingInfo(null);
    setShadowPreview(false);
    setSettlementInfo(null);
    setLastUpdated(0);
    setFundingAmount("");
    setUsdcFundingAmount("");
    setCoinIds("");
    setNotice("");
    setPageError("");
    accountRef.current = "";
    pendingGeneration.current = null;
    identityRef.current = { address: "", wallet: null, account: null, generation };
    if (logout) await request("/logout", "POST", {}).catch(() => undefined);
  }, [capabilities, ownerSubmissionPending]);

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
    setBusy("connect"); setPageError(""); setNotice(""); setWalletRecovery("");
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
      setPolicyDraft(completePolicy(authenticatedState.policy));
      setDirtyPolicy(false);
      setLastUpdated(Date.now());
      setNotice("Wallet identity verified. No transaction was signed.");
      setWalletRecovery("");
    } catch (error) {
      if (generation == null || identityRef.current.generation === generation) {
        await clearIdentity(true);
         const raw = asErrorMessage(error, "Wallet authentication failed.");
         const rejected = /reject|denied|cancel/i.test(raw);
         const wrongNetwork = /mainnet|network|chain/i.test(raw);
         setWalletRecovery(rejected
           ? "The wallet request was declined. Reconnect and approve the standard connection and one personal-message login challenge; login never asks for a transaction signature."
           : wrongNetwork
             ? "Switch the selected account to Sui mainnet, then reconnect. The account must report the sui:mainnet wallet-standard chain."
             : "Check that a wallet-standard compatible Sui wallet is installed, unlocked, and supports connect plus personal-message signing, then retry.");
         setPageError(raw);
      }
    }
    finally { setBusy(""); }
  };

  useEffect(() => {
    if (!wallet || !address) return;
    const events = wallet.features?.["standard:events"] as { on?: (event: string, listener: (change: { accounts?: WalletAccount[] }) => void) => (() => void) } | undefined;
    const unsubscribe = events?.on?.("change", change => {
      if (!change.accounts) return;
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
      const next = completePolicy(updater(completePolicy(old)));
      if (next.frequency !== "EVERY_ELIGIBLE_ROUND") setEveryRoundAck(false);
      if (next.edgeEnabled) setEdgeOffAck(false);
      if (next.reserveCents !== 0) setZeroReserveAck(false);
      if (next.signalSource !== "EXPERIMENTAL_QUALIFICATION_GATES") setExperimentalConfirmed(false);
      if (!next.compound) setCompoundingConfirmed(false);
      return next;
    });
    setDirtyPolicy(true);
  };
  const policySummaries = useMemo(() => policySummary(policy), [policy]);
  const updatePolicy = async () => {
    if (!isAuthorized || !dirtyPolicy) return;
    const validation = agentPolicySchema.safeParse(completePolicy(policyDraft));
    if (!validation.success) {
      const issue = validation.error.issues[0];
      setPageError(`${issue.path.join(".") || "policy"}: ${issue.message}`);
      return;
    }
    if (policy.signalSource === "EXPERIMENTAL_QUALIFICATION_GATES" && !experimentalConfirmed) {
      setPageError("Confirm the experimental qualification-gates strategy before saving it.");
      return;
    }
    if (policy.compound && !compoundingConfirmed) {
      setPageError("Confirm compounding explicitly before saving this policy.");
      return;
    }
    setBusy("policy"); setPageError(""); setNotice("");
    const consent = {
      acknowledged: true,
      ...(policy.signalSource === "EXPERIMENTAL_QUALIFICATION_GATES" ? { experimentalConfirmed: true } : {}),
      ...(policy.compound ? { compoundingConfirmed: true } : {}),
    };
    const identity = identityRef.current;
    try { const result = await request<AgentState>("/policy", "POST", { policy: validation.data, ...consent }, identity); if (!identityStillCurrent(identity, identityRef.current)) return; rememberSessionExpiry(result.walletSessionExpiresAtMs); setState(result); setPolicyDraft(completePolicy(result.policy)); setDirtyPolicy(false); setNotice("Strategy saved. The agent has not started."); }
    catch (error) { setPageError(asErrorMessage(error)); }
    finally { setBusy(""); }
  };
  const control = async (action: "PAUSE") => {
    setBusy(action); setPageError(""); setNotice("");
    const identity = identityRef.current;
    try {
      const result = await request<AgentState>("/control", "POST", { action }, identity);
      if (!identityStillCurrent(identity, identityRef.current)) return;
      rememberSessionExpiry(result.walletSessionExpiresAtMs);
      setState(result); setPolicyDraft(completePolicy(result.policy)); setNotice("Persistent pause requested.");
    } catch (error) { setPageError(asErrorMessage(error)); }
    finally { setBusy(""); }
  };
  const beginOwnerAction = async (action: string, extra: Record<string, unknown> = {}) => {
    const identity = identityRef.current;
    if (!identity.wallet || !identity.account || !isAuthorized || !state || ownerSubmissionPending ||
      !identityStillCurrent(identity, identityRef.current) || capabilities?.ownerSetupSigning !== true) {
      setPageError("Owner setup review requires a current authenticated owner identity and ownerSetupSigning=true from backend capabilities.");
      return;
    }
    const payloadExtra = { ...extra };
    const amountHuman = typeof payloadExtra.amountHuman === "string" ? payloadExtra.amountHuman : null;
    delete payloadExtra.amountHuman;
    if (amountHuman != null) {
      const decimals = action === "FUND_USDC" ? 6 : settlementInfo?.decimals;
      if (decimals == null) { setPageError("Settlement decimals were not reported; amount conversion is blocked."); return; }
      const amountAtomic = dollarsToAtomicAmount(amountHuman, decimals);
      if (!amountAtomic) { setPageError(`Enter a positive dollar amount with no more than ${decimals} decimal places.`); return; }
      payloadExtra.amountAtomic = amountAtomic;
    }
    const payload: Record<string, unknown> = { action, ...(action !== "CREATE_ACCOUNT" && state.accountId ? { accountId: state.accountId } : {}), ...payloadExtra };
    setBusy("simulate"); setPageError(""); setNotice(""); setPendingTx(null); setOwnerChoice(false);
    try {
      const result = await request<{ success: boolean; checksEnabled: boolean; gasBudgetMist: number; network: string }>("/owner-simulation", "POST", payload, identity);
      if (!identityStillCurrent(identity, identityRef.current)) return;
      pendingGeneration.current = identity.generation;
      setOwnerPayload(payload);
      setSimulation(result);
      setPendingAction(action);
      setPendingActionType(action === "FUND" || action === "WITHDRAW" ? "Settlement-native USD" : action === "FUND_USDC" || action === "REDEEM_USDC" ? "Native USDC" : "Account control");
      setPendingOwner(identity.address);
      setOwnerChoice(false);
      setPendingTx(null);
      setNotice(result.success && result.checksEnabled && result.network === "mainnet"
        ? "Pre-sign simulation passed. No transaction has been signed or submitted."
        : "Simulation failed or returned unexpected checks. Transaction preparation is blocked.");
    } catch (error) { setPageError(asErrorMessage(error)); }
    finally { setBusy(""); }
  };
  const prepareOwnerTransaction = async () => {
    const identity = identityRef.current;
    if (!ownerPayload || !simulation?.success || !simulation.checksEnabled || simulation.network !== "mainnet" ||
      !ownerChoice || !isAuthorized || capabilities?.ownerSetupSigning !== true ||
      ownerSubmissionPending || pendingGeneration.current !== identity.generation || !identityStillCurrent(identity, identityRef.current)) return;
    setBusy("prepare"); setPageError("");
    try {
      const response = await request<OwnerTransaction>("/owner-transaction", "POST", ownerPayload, identity);
      if (!identityStillCurrent(identity, identityRef.current)) return;
      setPendingTx(response);
      setNotice("Transaction payload prepared after simulation and explicit owner choice. Nothing was signed or submitted.");
    } catch (error) { setPageError(asErrorMessage(error)); }
    finally { setBusy(""); }
  };
  const confirmOwnerDigest = async (digest: string, action: string, identity: WalletIdentity) => {
    if (!isAuthorized || !identityStillCurrent(identity, identityRef.current) || capabilities?.ownerSetupSigning !== true) {
      setPageError("Owner confirmation is blocked because the authenticated wallet or verified setup-signing capability is no longer current.");
      return;
    }
    setBusy("confirm"); setPageError("");
    try {
      await request("/owner-confirm", "POST", { digest, action }, identity);
      if (!identityStillCurrent(identity, identityRef.current)) return;
      setUncertainDigest(""); setUncertainOwner(""); setUncertainAction(""); setOwnerSubmissionPending(false);
      window.sessionStorage.removeItem(PENDING_OWNER_APPROVAL_KEY);
      setNotice("Owner transaction confirmed by the service. Refreshing owned account state.");
      await loadState(true);
      await accountOptions();
    } catch (error) {
      setUncertainDigest(digest); setUncertainOwner(identity.address); setUncertainAction(action);
      setOwnerSubmissionPending(true);
      window.sessionStorage.setItem(PENDING_OWNER_APPROVAL_KEY, JSON.stringify({ digest, owner: identity.address, action }));
      setPageError(`Transaction digest retained; confirmation could not be verified. Retry confirmation only. ${asErrorMessage(error)}`);
    } finally { setBusy(""); }
  };
  const approvePreparedOwnerTransaction = async (review?: { transaction: OwnerTransaction; action: string; passed: boolean; generation: number }) => {
    const identity = identityRef.current;
    const transaction = review?.transaction ?? pendingTx, action = review?.action ?? pendingAction;
    if (!transaction || !action || !(review?.passed ?? simulationPassed) || !(review || ownerChoice) || !isAuthorized ||
      capabilities?.ownerSetupSigning !== true || !identity.wallet || !identity.account ||
      ownerSubmissionPending || (review?.generation ?? pendingGeneration.current) !== identity.generation ||
      !identityStillCurrent(identity, identityRef.current)) {
      setPageError("Explicit wallet approval is blocked until login, owner identity, ownerSetupSigning capability, simulation checks and review are all current.");
      return;
    }
    setBusy("sign"); setPageError(""); setNotice("");
    setOwnerSubmissionPending(true);
    setUncertainOwner(identity.address);
    setUncertainAction(action);
    try {
      window.sessionStorage.setItem(PENDING_OWNER_APPROVAL_KEY, JSON.stringify({ owner: identity.address, action }));
      const isCurrent = () => identityStillCurrent(identity, identityRef.current) &&
        (!!review || identityRef.current.address.toLowerCase() === pendingOwner.toLowerCase());
      const signed = await signReviewedOwnerTransaction({
        wallet: identity.wallet as Parameters<typeof signReviewedOwnerTransaction>[0]["wallet"],
        account: identity.account,
        transaction: transaction.transaction,
        action,
        isCurrent,
      });
      setUncertainDigest(signed.digest); setUncertainOwner(identity.address); setUncertainAction(action);
      window.sessionStorage.setItem(PENDING_OWNER_APPROVAL_KEY, JSON.stringify({ digest: signed.digest, owner: identity.address, action }));
      if (!isCurrent()) {
        setPageError("Owner identity changed after wallet approval. The returned digest is retained; reconnect as the same owner to retry confirmation only.");
        return;
      }
      await confirmOwnerDigest(signed.digest, action, identity);
    } catch (error) {
      const message = asErrorMessage(error, "Owner wallet approval failed or was cancelled.");
      const definitelyNotSubmitted = (error as {submissionState?:unknown})?.submissionState === "NOT_SUBMITTED";
      if (definitelyNotSubmitted) {
        setOwnerSubmissionPending(false);
        setUncertainOwner(""); setUncertainAction("");
        window.sessionStorage.removeItem(PENDING_OWNER_APPROVAL_KEY);
      }
      setPageError(!definitelyNotSubmitted
        ? `${message} If wallet submission may have occurred, do not approve again; reconcile owner activity before continuing.`
        : message);
    } finally { setBusy(""); }
  };
  const retryOwnerConfirmation = async () => {
    const identity = identityRef.current;
    if (!uncertainDigest || uncertainOwner.toLowerCase() !== identity.address.toLowerCase() ||
      !identityStillCurrent(identity, identityRef.current) || capabilities?.ownerSetupSigning !== true) {
      setPageError("Confirmation retry requires the same current authenticated owner and verified setup-signing capability.");
      return;
    }
    await confirmOwnerDigest(uncertainDigest, uncertainAction, identity);
  };
  const accountOptions = async () => {
    const identity = identityRef.current, seq = ++discoverySeq.current;
    if (!isAuthorized || !identityStillCurrent(identity, identityRef.current)) return;
    setDiscoveryStatus("loading"); setDiscoveryError("");
    try {
      const result = await request<{ accounts: { accountId: string }[]; settlementCoinType: string; network: string; decimals?: number; conversionAvailable?: boolean; collateral?: string }>("/accounts", "POST", {}, identity);
      if (seq !== discoverySeq.current || !identityStillCurrent(identity, identityRef.current)) return;
      if (result.network !== "mainnet" || !Array.isArray(result.accounts)) throw new Error("Unexpected mainnet discovery response");
      setAccounts(result.accounts);
      setSettlementInfo({ coinType: result.settlementCoinType, network: result.network, decimals: result.decimals, conversionAvailable: result.conversionAvailable, collateral: result.collateral });
      setDiscoveryStatus("success");
      const chosen = discoveredAccountSelection(result.accounts.map(a => a.accountId), stateRef.current?.accountId ?? null);
      if (chosen && chosen !== stateRef.current?.accountId) await setAccount(chosen, true);
    } catch {
      if (seq !== discoverySeq.current || !identityStillCurrent(identity, identityRef.current)) return;
      setDiscoveryStatus("error");
      setDiscoveryError("We couldn’t check your WaterX accounts. Retry when your connection is available.");
    }
  };
  const setAccount = async (accountId: string, automatic = false) => {
    const identity = identityRef.current;
    if (!isAuthorized || (!automatic && (busy || ownerSubmissionPending || quickActionActive.current)) || !identityStillCurrent(identity, identityRef.current)) return;
    setBusy("account"); setFundingInfo(null); balanceSeq.current++; requestSeq.current++;
    try {
      const result = await request<AgentState>("/account", "POST", { accountId }, identity);
      if (!identityStillCurrent(identity, identityRef.current)) return;
      rememberSessionExpiry(result.walletSessionExpiresAtMs);
      setEveryRoundAck(false); setEdgeOffAck(false); setZeroReserveAck(false); setExperimentalConfirmed(false); setCompoundingConfirmed(false); setPendingTx(null); setPendingAction(""); setOwnerPayload(null); setSimulation(null); setOwnerChoice(false); pendingGeneration.current = null;
      setState(result); stateRef.current = result; setPolicyDraft(completePolicy(result.policy)); setDirtyPolicy(false); setNotice("WaterX account selected.");
    } catch { if (identityStillCurrent(identity, identityRef.current)) setPageError("We couldn’t select that account. Please retry."); }
    finally { if (identityStillCurrent(identity, identityRef.current)) setBusy(""); }
  };
  useEffect(() => {
    if (isAuthorized && discoveryStatus === "idle") void accountOptions();
  }, [isAuthorized, discoveryStatus]);
  useEffect(() => {
    if (!isAuthorized || discoveryStatus !== "success" || !state?.accountId ||
        !accounts.some(a => a.accountId === state.accountId)) return;
    const identity = identityRef.current, selected = state.accountId;
    let active = true;
    const refresh = async () => {
      const seq = ++balanceSeq.current;
      try {
        const next = await request<FundingInfo>("/account-balance", "POST", { accountId: selected }, identity);
        if (!active || seq !== balanceSeq.current || !identityStillCurrent(identity, identityRef.current) ||
            stateRef.current?.accountId !== selected) return;
        if (next.network !== "mainnet" || next.accountId !== selected || !/^\d+$/.test(next.availableAtomic)) throw new Error("Invalid balance response");
        setFundingInfo(next);
      } catch {
        if (active && seq === balanceSeq.current && identityStillCurrent(identity, identityRef.current)) setFundingInfo(null);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30000);
    return () => { active = false; window.clearInterval(timer); };
  }, [isAuthorized, discoveryStatus, state?.accountId, accounts]);
  const quickOwnerAction = async (requested: string, extra: Record<string, unknown> = {}) => {
    const identity = identityRef.current;
    if (quickActionActive.current || busy || !isAuthorized || ownerSubmissionPending ||
        !identityStillCurrent(identity, identityRef.current) || capabilities?.ownerSetupSigning !== true) return;
    if (requested === "CREATE_ACCOUNT" && (discoveryStatus !== "success" || accounts.length !== 0)) return;
    if (!["CREATE_ACCOUNT", "FUND", "FUND_USDC", "REVOKE"].includes(requested)) return;
    if (requested !== "CREATE_ACCOUNT" && (!state?.accountId || discoveryStatus !== "success" ||
        !accounts.some(a => a.accountId === state.accountId))) return;
    if (requested === "REVOKE" && !state?.delegateAddress) return;
    const atomic = /^(FUND|FUND_USDC)$/.test(requested) ? dollarsToAtomicAmount(String(extra.amountHuman ?? fundingAmount), 6) : null;
    if (/^(FUND|FUND_USDC)$/.test(requested) && !atomic) { setPageError("Enter a positive funding amount."); return; }
    const walletUsdEnough = !!atomic && !!fundingInfo?.walletUsdAtomic &&
      /^\d+$/.test(fundingInfo.walletUsdAtomic) && BigInt(fundingInfo.walletUsdAtomic) >= BigInt(atomic);
    const action = requested === "FUND" && !walletUsdEnough && fundingInfo?.nativeUsdcSupported ? "FUND_USDC" : requested;
    const payload = { action, ...(requested !== "CREATE_ACCOUNT" ? { accountId: state!.accountId } : {}),
      ...(atomic ? { amountAtomic: atomic } : {}), ...(requested === "REVOKE" ? { delegateAddress: state!.delegateAddress } : {}) };
    quickActionActive.current = true;
    setBusy("simulate"); setPageError(""); setNotice("");
    try {
      const simulation = await request<{ success: boolean; checksEnabled: boolean; network: string }>("/owner-simulation", "POST", payload, identity);
      if (!identityStillCurrent(identity, identityRef.current)) return;
      if (!simulation.success || !simulation.checksEnabled || simulation.network !== "mainnet") throw new Error("Wallet checks did not pass");
      const transaction = await request<OwnerTransaction>("/owner-transaction", "POST", payload, identity);
      if (!identityStillCurrent(identity, identityRef.current)) return;
      pendingGeneration.current = identity.generation;
      setPendingAction(action); setPendingOwner(identity.address);
      await approvePreparedOwnerTransaction({ transaction, action, passed: true, generation: identity.generation });
    } catch (error) {
      if (identityStillCurrent(identity, identityRef.current)) setPageError(`We couldn’t prepare this wallet request. No transaction was submitted. ${asErrorMessage(error)}`);
    } finally {
      quickActionActive.current = false;
      if (identityStillCurrent(identity, identityRef.current)) setBusy("");
    }
  };
  const cap = capabilities;
  const desiredFundingAtomic = dollarsToAtomicAmount(fundingAmount, 6);
  const useUsdcFunding = fundingInfo?.nativeUsdcSupported && !(desiredFundingAtomic && fundingInfo.walletUsdAtomic &&
    /^\d+$/.test(fundingInfo.walletUsdAtomic) && BigInt(fundingInfo.walletUsdAtomic) >= BigInt(desiredFundingAtomic));
  const status = state?.status ?? "NOT LOADED";
  const accountId = state?.accountId;
  const simulationPassed = !!simulation?.success && simulation.checksEnabled && simulation.network === "mainnet";
  const technicalBlockers = Array.from(new Set([...(cap?.blockers ?? []), ...(state?.blockers ?? [])]));
  const capabilitySummary = [
    `Development only: ${cap ? String(cap.developmentOnly) : "not reported"}`,
    `Mainnet execution enabled: ${cap ? String(cap.mainnetEnabled) : "not reported"}`,
    `Global execution disabled: ${cap ? String(cap.globalExecutionDisabled) : "not reported"}`,
    `Account / prediction permissions: ${cap ? `${cap.permissions.account} / ${cap.permissions.prediction}` : "not reported"}`,
    `Configuration: ${cap?.config.status ?? "not reported"}${cap?.config.reason ? ` — ${cap.config.reason}` : ""}`,
    `Owner setup signing: ${cap?.ownerSetupSigning === true ? "reported enabled" : "not verified"}`,
    `Live readiness: ${cap?.readiness?.released === true ? "released by capability report" : "not released"}`,
  ];
  const retryCapabilities = () => {
    setBusy("capabilities");
    const seq = ++capabilitySeq.current;
    request<Capabilities>("/capabilities").then(data => {
      if (seq !== capabilitySeq.current) return;
      setCapabilities(data);
      if (!dirtyPolicyRef.current) setPolicyDraft(completePolicy(data.defaultPolicy));
      setPageError("");
    }).catch(error => { if (seq === capabilitySeq.current) setPageError(asErrorMessage(error, "Agent capabilities are unavailable.")); }).finally(() => { if (seq === capabilitySeq.current) setBusy(""); });
  };

  const checkMainnetPilot = async () => {
    if(!isAuthorized||!state?.accountId||!!busy)return;
    const identity=identityRef.current,account=state.accountId,version=state.policyVersion;
    setBusy("pilot-preflight");setPilotPreflight(null);
    try{
      const result=await request<MainnetPreflight>("/mainnet-preflight","POST",{},identity);
      if(!identityStillCurrent(identity,identityRef.current)||stateRef.current?.accountId!==account||
         stateRef.current?.policyVersion!==version)return;
      setPilotPreflight(result);
      setPageError("");
    }catch(error){
      if(identityStillCurrent(identity,identityRef.current))
        setPageError(asErrorMessage(error,"Owner mainnet readiness could not be verified."));
    }finally{if(identityStillCurrent(identity,identityRef.current))setBusy("");}
  };
  return <div className="page agent-page">
    <header className="agent-mast">
      <div><div className="eyebrow">BLUEWATERAI / AGENT</div><h1>Your wallet.<em> Your agent.</em></h1><p>Connect, fund and choose your strategy. You stay in control.</p></div>
      <div className="agent-mast-badge"><span className="agent-pulse" />SUI MAINNET</div>
    </header>
    <div className="ao-public-unavailable" role="status"><strong>Live agent temporarily unavailable</strong><span>Secure mainnet trading is not ready yet. No trading permission is activated. You can try shadow mode without connecting or funding.</span></div>
    {isAuthorized&&state?.accountId&&<section className="agent-card" aria-label="Live mainnet pilot readiness">
      <div className="agent-card-heading"><div><span className="agent-kicker">LIVE MAINNET PILOT</span><h2>Check the last blockers</h2></div></div>
      <p>This check verifies your selected WaterX account credit and the remaining execution prerequisites. It never signs or submits a trade.</p>
      <button type="button" className="ao-button ao-button-secondary" disabled={!!busy} onClick={()=>void checkMainnetPilot()}>
        {busy==="pilot-preflight"?"Checking mainnet account…":"Check mainnet readiness"}
      </button>
      {pilotPreflight&&<div role="status" className="ao-tech">
        <p><strong>Ready to trade: {pilotPreflight.ready?"YES":"NO"}</strong> · Stored WaterX USD credit: {pilotPreflight.observedAvailableCents==null?"unverified":`${(pilotPreflight.observedAvailableCents/100).toFixed(2)}`} · Illustrative policy order: {pilotPreflight.plannedStakeCents==null?"unverified":`${(pilotPreflight.plannedStakeCents/100).toFixed(2)}`}</p>
        <ul>{pilotPreflight.checks.filter(check=>check.status!=="PASS").map(check=>
          <li key={check.id}><strong>{check.id.replaceAll("-"," ").toUpperCase()}</strong> — {check.detail} ({check.status.toLowerCase()})</li>
        )}</ul>
        <p>No delegation or execution permission is granted by this check.</p>
      </div>}
    </section>}
    {isAuthorized && state?.status === "SHADOW" && <button className="ao-button ao-button-primary ao-run-pause" disabled={!!busy} onClick={() => void control("PAUSE")}>PAUSE AGENT</button>}

    <details className="agent-card ao-system-diagnostics"><summary>System diagnostics</summary><section className="agent-safety-strip">
      <ShieldCheck size={19} /><div><strong>IDENTITY IS NOT AUTHORITY</strong><span>Wallet connection authenticates the owner only. This console never starts trading or signs or funds automatically. An explicitly reviewed setup transaction remains a separate owner choice; balances, fills, and profit appear only if the service reports them.</span></div>
    </section>

    <div className="agent-overview">
      <section className="agent-status-panel">
        <div className="agent-section-top"><span className="agent-kicker">CONTROL STATE</span><span className={`agent-status ${status.toLowerCase()}`}><i />{status.replace("_", " ")}</span></div>
        <div className="agent-status-main"><strong>{isAuthorized ? "OWNER SESSION · MAINNET IDENTITY" : "Owner session not connected"}</strong><p>{isAuthorized ? `Authenticated owner ${shortAddress(address)} · session expires ${agentDate(lastSessionExpiryMs)}. Identity does not create an execution permission.` : "The public console and current capabilities remain available. Connect to view owner-specific agent state."}</p></div>
        <div className="agent-actions">
          {isAuthorized ? <>{status === "SHADOW" && <button className="agent-pause" disabled={!!busy} onClick={() => void control("PAUSE")}>Stop</button>}<button className="agent-logout" disabled={!!busy} onClick={() => void logout()}><X size={15} /> Disconnect</button></> : <span className="agent-connect-hint">Connect in the guided setup below.</span>}
        </div>
        <div className="agent-wallet-authority"><label>Wallet authority <small>identity session only · no order signer</small></label><div className="agent-locked-control"><LockKeyhole size={14} /> No trading permission granted</div></div>
        <div className="agent-auth-note"><LockKeyhole size={13} /> Mainnet-bound short-lived login challenge. No transaction signature requested on connect.</div>
        {!isAuthorized && <div className="agent-wallet-setup"><b>Wallet setup</b><ol><li>Install or unlock a Sui wallet that registers wallet-standard connect and personal-message signing.</li><li>Select a wallet account enabled for Sui mainnet.</li><li>Approve connection and the personal-message login challenge; neither is a transaction.</li></ol><p>Mobile wallet-standard handoff has not been verified. No mobile deep link is provided.</p></div>}
        {walletRecovery && <div className="agent-wallet-recovery" role="status"><b>Recovery guidance</b><p>{walletRecovery}</p></div>}
      </section>

      <section className="agent-equity-panel">
        <div className="agent-section-top"><span className="agent-kicker">WALLET / SETTLEMENT STATUS</span><button className="agent-icon-button" aria-label="Refresh private state" disabled={!isAuthorized || !!busy} onClick={() => void loadState()}><RefreshCw size={14} /></button></div>
        <div className="agent-equity">{state?.balances == null ? "NO BALANCE REPORTED" : "SERVICE DATA REPORTED"}</div><div className="agent-equity-caption">{state?.balances == null ? "No balance is present in the current state response. No wallet balance or quote is inferred." : "The authenticated state response includes a balance field; values are not converted or inferred here."}</div>
        <div className="agent-mini-stats"><div><span>AGENT STATUS</span><b>{status.replace(/_/g, " ")}</b></div><div><span>FILLS</span><b>Not exposed by this state view</b></div><div><span>DELEGATE</span><b>{state?.delegateAddress ? shortAddress(state.delegateAddress) : "Not reported"}</b></div></div>
        <small className="agent-unverified-copy">Settlement coin type, network, and decimals are shown only after the owner requests the accounts endpoint.</small>
        <small className="agent-update-label">{lastUpdated ? `LAST STATE CHECK · ${new Date(lastUpdated).toLocaleTimeString()}` : "STATE NOT LOADED"} · refresh every 5 sec while authenticated</small>
      </section>
    </div>

    <AgentCurrentRound agentStatus={state?.status ?? null} /></details>

    {(pageError || notice) && <div role={pageError ? "alert" : "status"} className={pageError ? "agent-message error" : "agent-message"}>{pageError ? <AlertTriangle size={16} /> : <Check size={16} />}{pageError || notice}<button aria-label="Dismiss message" onClick={() => { setPageError(""); setNotice(""); }}><X size={14} /></button></div>}

    {shadowPreview ? <AgentRunningView policy={policy} onPause={() => { setShadowPreview(false); setNotice("Shadow preview paused. No trades were submitted."); }} /> : <div className="agent-columns">
      <main className="agent-main-column">
        <section className="agent-card agent-policy-card">
          <div className="agent-card-heading"><div><span className="agent-kicker">YOUR AGENT</span><h2>Simple setup. You’re in control.</h2></div><span className={dirtyPolicy ? "agent-dirty" : "agent-saved"}>{dirtyPolicy ? "UNSAVED" : isAuthorized ? "SAVED" : "PREVIEW"}</span></div>
          <GuidedAgentSetup
            policy={policy}
            onPolicyChange={changePolicy}
            authorized={isAuthorized}
            ownerAddress={address}
            network={accountIsMainnet(selectedAccount) ? "Sui mainnet" : "Not verified"}
            accountAddress={selectedAccount?.address ?? ""}
            walletName={wallet?.name ?? ""}
            wallets={wallets}
            onConnect={index => { const candidate = wallets[index]; if (candidate) void connectWallet(candidate); }}
            accounts={accounts}
            accountId={discoveryStatus === "success" && accounts.some(a => a.accountId === accountId) ? accountId : null}
            onSelectAccount={id => void setAccount(id)}
            supportedAsset={settlementInfo ? `${settlementInfo.coinType} · ${settlementInfo.network}${settlementInfo.decimals == null ? "" : ` · ${settlementInfo.decimals} decimals`}${settlementInfo.collateral ? ` · collateral ${settlementInfo.collateral}` : ""}${settlementInfo.conversionAvailable === false ? " · wallet conversion unavailable" : ""}` : null}
            onRefreshAsset={() => void accountOptions()}
            settlementDecimals={settlementInfo?.decimals}
            busy={busy}
            dirty={dirtyPolicy}
            onSave={() => void updatePolicy()}
            fundingAmount={fundingAmount}
            onFundingAmountChange={setFundingAmount}
            usdcFundingAmount={usdcFundingAmount}
            onUsdcFundingAmountChange={setUsdcFundingAmount}
            coinObjectIds={coinIds}
            onCoinObjectIdsChange={setCoinIds}
            onOwnerAction={(action, extra) => void beginOwnerAction(action, extra)}
            simulationPassed={simulationPassed}
            pendingAction={pendingAction}
            pendingDescription={pendingTx?.description ?? ""}
            pendingTransaction={pendingTx?.transaction ?? ""}
            ownerChoice={ownerChoice}
            onOwnerChoiceChange={setOwnerChoice}
            onPrepare={() => void prepareOwnerTransaction()}
            onApprove={() => void approvePreparedOwnerTransaction()}
            uncertainDigest={uncertainDigest}
            ownerSubmissionPending={ownerSubmissionPending}
            onRetryConfirmation={() => void retryOwnerConfirmation()}
            ownerSetupSigning={cap?.ownerSetupSigning === true}
            readiness={cap?.readiness ?? null}
            onRetryCapabilities={retryCapabilities}
            discoveryStatus={discoveryStatus}
            discoveryError={discoveryError}
            availableBalanceUsd={fundingInfo?.availableBalanceUsd ?? null}
            fundingAssetLabel={useUsdcFunding ? "Native USDC → WaterX USD" : "WaterX USD"}
            fundingAvailable={discoveryStatus === "success" && !!accountId && !!fundingInfo}
            delegateStatus={state?.delegateExpiresAtMs != null && state.delegateExpiresAtMs <= Date.now() ? "expired" : "unavailable"}
            onTryShadow={() => setShadowPreview(true)}
            onQuickOwnerAction={(action, extra) => void quickOwnerAction(action, extra)}
            experimentalConfirmed={experimentalConfirmed}
            onExperimentalConfirmedChange={setExperimentalConfirmed}
            compoundingConfirmed={compoundingConfirmed}
            onCompoundingConfirmedChange={setCompoundingConfirmed}
            capabilitiesAvailable={!!cap}
            technicalBlockers={technicalBlockers}
            capabilitySummary={capabilitySummary}
            notice={notice}
          />
          <details className="guided-advanced policy-technical-controls">
            <summary>Advanced · legacy technical policy controls</summary>
            <div className="guided-advanced-content">
          <div className="agent-card-heading"><div><span className="agent-kicker">OWNER-APPROVED POLICY</span><h2>Technical policy controls</h2><p>Saved policy intent is shown as-is. Changes here require explicit review and saving; no previously approved broader settings are silently reset.</p></div><span className={dirtyPolicy ? "agent-dirty" : "agent-saved"}>{dirtyPolicy ? "UNSAVED PREVIEW" : isAuthorized ? `SAVED · V${state?.policyVersion ?? "—"}` : "PUBLIC PREVIEW"}</span></div>
          <fieldset className="agent-fields">
            <div className="agent-control-grid">
              <Field label="Policy network" help={`Capabilities report ${cap?.network ?? "network not loaded"}. Policy network is not an execution grant.`}><select value={policy.network} disabled><option value="mainnet">Sui mainnet · policy configuration</option><option value="testnet">Sui testnet · policy configuration</option></select></Field>
              <Field label="Eligible round intervals"><div className="agent-choice-row">{([5, 15] as const).map(n => <button type="button" key={n} className={policy.intervals.includes(n) ? "chosen" : ""} aria-pressed={policy.intervals.includes(n)} onClick={() => changePolicy(p => ({ ...p, intervals: p.intervals.includes(n) ? p.intervals.filter(v => v !== n) as AgentPolicy["intervals"] : [...p.intervals, n].sort() as AgentPolicy["intervals"] }))}>{n} minutes</button>)}</div></Field>
              <Field label="Signal source" help="Experimental qualification gates are uncalibrated research, not a profitability claim."><select value={policy.signalSource} onChange={e => changePolicy(p => ({ ...p, signalSource: e.target.value as AgentPolicy["signalSource"] }))}><option value="BLUEWATER_CHAMPION">Bluewater champion</option><option value="EXPERIMENTAL_QUALIFICATION_GATES">Experimental qualification gates</option></select></Field>
              <Field label="Frequency"><select value={policy.frequency} onChange={e => changePolicy(p => ({ ...p, frequency: e.target.value as AgentPolicy["frequency"] }))}><option value="SELECTIVE">Selective</option><option value="EVERY_ELIGIBLE_ROUND">Every eligible round</option></select></Field>
              {policy.frequency === "SELECTIVE" && <Field label="Selective minimum probability" help="Fraction from 0.50 to 1.00."><div className="agent-input-wrap"><input type="number" min=".5" max="1" step=".01" value={policy.selectiveMinProbability} onChange={e => changePolicy(p => ({ ...p, selectiveMinProbability: Number(e.target.value) }))} /><span>fraction</span></div></Field>}
              <Field label="Verified edge filter"><Toggle checked={policy.edgeEnabled} onChange={edgeEnabled => changePolicy(p => ({ ...p, edgeEnabled }))} label={policy.edgeEnabled ? "On" : "Off"} /></Field>
              {policy.edgeEnabled && <Field label="Minimum edge" help="Percentage points after verified costs."><div className="agent-input-wrap"><input type="number" min="0" max="100" step=".1" value={policy.minimumEdgePp} onChange={e => changePolicy(p => ({ ...p, minimumEdgePp: Number(e.target.value) }))} /><span>pp</span></div></Field>}
              <Field label="Sizing mode"><select value={policy.sizingMode} onChange={e => changePolicy(p => ({ ...p, sizingMode: e.target.value as AgentPolicy["sizingMode"] }))}><option value="FIXED">Fixed amount</option><option value="AVAILABLE_PERCENT">Available balance percent</option><option value="ALLOCATION_PERCENT">Allocation percent</option></select></Field>
              {policy.sizingMode === "FIXED" ? <MoneyField label="Fixed order size" cents={policy.fixedCents} onChange={v => changePolicy(p => ({ ...p, fixedCents: v ?? 1 }))} help="Owner-defined policy input; not an executable quote." /> : <Field label="Sizing percentage"><div className="agent-input-wrap"><input type="number" min=".01" max="100" step=".1" value={policy.sizingPercent} onChange={e => changePolicy(p => ({ ...p, sizingPercent: Number(e.target.value) }))} /><span>%</span></div></Field>}
              <MoneyField label="Allocation amount" cents={policy.allocationCents} onChange={v => changePolicy(p => ({ ...p, allocationCents: v ?? 1 }))} />
              <Field label="Compounding" help="Off by default. Turning it on requires separate explicit consent when saving."><Toggle checked={policy.compound} onChange={compound => changePolicy(p => ({ ...p, compound }))} label={policy.compound ? "On · owner confirmation required" : "Off"} /></Field>
              <MoneyField label="Daily turnover limit" cents={policy.dailyTurnoverCents} nullable onChange={v => changePolicy(p => ({ ...p, dailyTurnoverCents: v }))} help="No limit is represented as unlimited; this is not silently capped." />
              <Field label="Daily loss guard"><div className="agent-pair-fields"><select aria-label="Daily loss mode" value={policy.dailyLoss?.mode ?? "AMOUNT"} onChange={e => changePolicy(p => { const mode = e.target.value as "AMOUNT" | "PERCENT"; const from = p.dailyLoss?.mode ?? mode; return { ...p, dailyLoss: { mode, value: p.dailyLoss ? changePolicyLimitMode(from, mode, p.dailyLoss.value) : mode === "AMOUNT" ? 100 : 1 } }; })}><option value="AMOUNT">Amount</option><option value="PERCENT">Percent</option></select><div className="agent-input-wrap"><input aria-label="Daily loss value" type="number" min=".01" max={policy.dailyLoss?.mode === "PERCENT" ? 100 : 1000000} step={policy.dailyLoss?.mode === "PERCENT" ? ".1" : ".01"} value={policy.dailyLoss ? policyAmountInputValue(policy.dailyLoss.mode, policy.dailyLoss.value) : ""} placeholder="Disabled" onChange={e => changePolicy(p => ({ ...p, dailyLoss: e.target.value === "" ? null : { mode: p.dailyLoss?.mode ?? "AMOUNT", value: policyValueFromInput(p.dailyLoss?.mode ?? "AMOUNT", e.target.value) } }))} /><span>{policy.dailyLoss?.mode === "PERCENT" ? "%" : "$"}</span></div></div></Field>
              <Field label="Maximum drawdown"><div className="agent-input-wrap"><input type="number" min="0" max="100" step=".1" placeholder="Disabled" value={policy.maxDrawdownPercent ?? ""} onChange={e => changePolicy(p => ({ ...p, maxDrawdownPercent: e.target.value === "" ? null : Number(e.target.value) }))} /><span>%</span></div></Field>
              <Field label="Maximum consecutive losses"><input type="number" min="1" step="1" placeholder="Disabled" value={policy.maxConsecutiveLosses ?? ""} onChange={e => changePolicy(p => ({ ...p, maxConsecutiveLosses: e.target.value === "" ? null : Number(e.target.value) }))} /></Field>
              <MoneyField label="Reserve" cents={policy.reserveCents} onChange={v => changePolicy(p => ({ ...p, reserveCents: v ?? 0 }))} help="Reserve is a saved policy limit only; this release has no live session start." />
              <MoneyField label="Maximum order" cents={policy.maxOrderCents} nullable onChange={v => changePolicy(p => ({ ...p, maxOrderCents: v }))} />
              <Field label="Maximum unresolved exposure"><div className="agent-pair-fields"><select aria-label="Maximum unresolved exposure mode" value={policy.maxUnresolved.mode} onChange={e => changePolicy(p => ({ ...p, maxUnresolved: { ...p.maxUnresolved, mode: e.target.value as "AMOUNT" | "PERCENT" } }))}><option value="AMOUNT">Amount</option><option value="PERCENT">Percent</option></select><div className="agent-input-wrap"><input aria-label="Maximum unresolved exposure value" type="number" min=".01" max={policy.maxUnresolved.mode === "PERCENT" ? 100 : 1000000} step={policy.maxUnresolved.mode === "PERCENT" ? ".1" : ".01"} value={policy.maxUnresolved.mode === "AMOUNT" ? (policy.maxUnresolved.value / 100).toFixed(2) : policy.maxUnresolved.value} onChange={e => changePolicy(p => ({ ...p, maxUnresolved: { ...p.maxUnresolved, value: policy.maxUnresolved.mode === "AMOUNT" ? centsFrom(e.target.value) : Number(e.target.value) } }))} /><span>{policy.maxUnresolved.mode === "AMOUNT" ? "$" : "%"}</span></div></div></Field>
              <MoneyField label="Aggregate collateral per round" cents={policy.roundCollateralCents} onChange={v => changePolicy(p => ({ ...p, roundCollateralCents: v ?? 1 }))} help="Explicit aggregate round bound; fixed sizing must not exceed this limit." />
              <MoneyField label="Session turnover limit" cents={policy.sessionTurnoverCents} onChange={v => changePolicy(p => ({ ...p, sessionTurnoverCents: v ?? 1 }))} />
              <MoneyField label="Session loss limit" cents={policy.sessionLossCents} onChange={v => changePolicy(p => ({ ...p, sessionLossCents: v ?? 1 }))} />
              <Field label="Session duration"><div className="agent-input-wrap"><input type="number" min="60000" max="604800000" step="60000" value={policy.sessionDurationMs} onChange={e => changePolicy(p => ({ ...p, sessionDurationMs: Number(e.target.value) }))} /><span>ms</span></div></Field>
              <Field label="Session gas budget"><div className="agent-input-wrap"><input type="number" min="0" max="500000000" step="1000000" value={policy.sessionGasBudgetMist} onChange={e => changePolicy(p => ({ ...p, sessionGasBudgetMist: Number(e.target.value) }))} /><span>MIST</span></div></Field>
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
           <section className="agent-summary"><div><span className="agent-kicker">POLICY SUMMARY</span><span className="agent-summary-note">{dirtyPolicy ? "UNSAVED DRAFT" : "CURRENT VIEW"}</span></div><ul>{policySummaries.map((line, i) => <li key={i}>{line}</li>)}</ul><p className="agent-unverified-copy">Limits below are policy intent, not a balance, quote, fill, or promise of outcome. Review every limit before saving. Funding never changes saved risk authority or compounds automatically.</p></section>
           {(policy.signalSource === "EXPERIMENTAL_QUALIFICATION_GATES" || policy.compound) && <div className="agent-confirm-group">
             <span className="agent-kicker">EXPLICIT SAVE CONSENT</span>
             {policy.signalSource === "EXPERIMENTAL_QUALIFICATION_GATES" && <label><input type="checkbox" checked={experimentalConfirmed} onChange={e => setExperimentalConfirmed(e.target.checked)} /> I understand this qualification-gates strategy is uncalibrated and I explicitly choose it.</label>}
             {policy.compound && <label><input type="checkbox" checked={compoundingConfirmed} onChange={e => setCompoundingConfirmed(e.target.checked)} /> I explicitly confirm compounding. This grants no additional funding authority and does not make trades compound here.</label>}
           </div>}
          {isAuthorized && <>
             <div className="agent-policy-actions"><span>{dirtyPolicy ? "Review the complete draft; saving does not start execution." : "Authenticated policy is current."}</span><button className="agent-primary" disabled={!dirtyPolicy || !!busy || (policy.signalSource === "EXPERIMENTAL_QUALIFICATION_GATES" && !experimentalConfirmed) || (policy.compound && !compoundingConfirmed)} onClick={() => void updatePolicy()}>{busy === "policy" ? "Saving…" : "Save reviewed policy"}</button></div>
          </>}
            </div>
          </details>
        </section>

      </main>

      <aside className="agent-side-column" hidden>
        <section className="agent-card agent-copy-card"><span className="agent-kicker">RESEARCH IS NOT AUTHORITY</span><p>Frozen round predictions remain research records. They never imply an order, fill or realized trading result.</p><div><span>Prediction permission</span><b>{cap?.permissions.prediction ?? "Not reported"}</b></div><div><span>Account permission</span><b>{cap?.permissions.account ?? "Not reported"}</b></div></section>
      </aside>
    </div>}

    <details className="agent-card ao-settings"><summary>Settings</summary>
      <p>Your wallet owns the WaterX account. Funding does not grant trading permission.</p>
      {state?.delegateAddress ? <><p>{state.delegateExpiresAtMs && state.delegateExpiresAtMs <= Date.now() ? "The recorded permission has expired. On-chain revocation is a separate wallet action." : "A delegate is recorded. Effective on-chain permissions are not verified here."}</p>
        <button className="ao-button ao-button-secondary" disabled={!isAuthorized || !!busy || ownerSubmissionPending || cap?.ownerSetupSigning !== true} onClick={() => void quickOwnerAction("REVOKE")}>Revoke Agent in wallet</button></> : <p>No trading permission has been activated by this setup.</p>}
      {isAuthorized && <><button className="ao-button ao-button-secondary" disabled={!!busy} onClick={() => void control("PAUSE")}>Pause saved agent</button><button className="ao-button ao-button-secondary" disabled={!!busy} onClick={() => void logout()}>Disconnect wallet</button></>}
      {uncertainDigest && <div role="status"><p>Wallet confirmation is unresolved. Do not submit again.</p><button className="ao-button ao-button-secondary" disabled={!!busy || !isAuthorized} onClick={() => void retryOwnerConfirmation()}>Retry confirmation only</button></div>}
    </details>
    <footer className="agent-footer"><span>BLUEWATERAI AGENT</span><span>Your funds stay yours <i /> No hidden signing</span></footer>

  </div>;
}
export default AgentPage;