import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

type FundingPreview = {
  status: string;
  asOfMs: number;
  backingCoinType: string;
  creditCoinType: string;
  configuredFees: {
    mintFeeScaled: string | number;
    burnFeeScaled: string | number;
    minimumBurnAmountAtomic: string | number;
    scale: string;
    provenance: string;
  };
  intendedFunding: {
    backingAmount: string;
    availableGas: string;
    authorizedGasMIST: string | number | null;
    aggregateRoundCollateralLimitAtomic: string | number;
    entryFeesIncluded: boolean;
  };
  fundingPath: string[];
  withdrawalPath: string[];
  winningsPath: string[];
  sdkValuation: string;
  executablePreview: false;
  readyForOwnerApproval: false;
  blockers: string[];
  semantics: string;
  network?: string;
  source?: string;
  backingDecimals?: number;
  creditDecimals?: number;
  vault?: string;
  withdrawalQueue?: string;
  registeredKeeperCount?: number;
};

type FundingState = { preview: FundingPreview | null; loading: boolean; error: string };
const present = (value: unknown) => value == null || value === "" ? "Not reported" : String(value);
const amount = (value: number | string | null | undefined) => value == null ? "Not reported" : String(value);
const stamp = (value: number) => Number.isFinite(value) ? new Date(value).toLocaleString() : "Timestamp unavailable";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export function AgentFundingPreviewView({ preview, loading, error, retry }: {
  preview: FundingPreview | null; loading: boolean; error: string; retry: () => void;
}) {
  if (!preview && loading) return <section className="agent-funding-preview" aria-label="USDC funding preview" aria-busy="true">
    <div className="agent-funding-skeleton"><i /><i /></div><span>Loading read-only funding registration…</span>
  </section>;
  if (!preview) return <section className="agent-funding-preview" aria-label="USDC funding preview">
    <div className="agent-funding-preview-head"><div><span className="agent-kicker">READ-ONLY · NO SIGNING</span><h3>USDC funding &amp; withdrawal preview</h3></div>
      <button type="button" className="agent-funding-refresh" onClick={retry} aria-label="Retry funding preview"><RefreshCw size={13} /> Retry</button></div>
    <p className="agent-funding-error" role="status">{error || "Funding preview unavailable; account and research data are unaffected."}</p>
  </section>;

  const funding = preview.intendedFunding;
  const fees = preview.configuredFees;
  const capAtomic = amount(funding.aggregateRoundCollateralLimitAtomic);
  const capAmount = capAtomic === "5000000" && (!preview.creditDecimals || preview.creditDecimals === 6)
    ? "≤ $5 USD credit / round" : `${capAtomic} atomic USD credit / round`;
  const authGas = funding.authorizedGasMIST == null ? "None · separate explicit gas approval required" : `${funding.authorizedGasMIST} MIST`;
  const fullPaths = [
    ["Funding path", preview.fundingPath],
    ["Withdrawal path", preview.withdrawalPath],
    ["Winnings path", preview.winningsPath],
  ] as const;

  return <section className="agent-funding-preview" aria-label="Read-only USDC funding and withdrawal preview">
    <div className="agent-funding-preview-head">
      <div><span className="agent-kicker">CAPITAL PATH · CONFIGURATION PREVIEW</span><h3>USDC funding &amp; withdrawal</h3></div>
      <div className="agent-funding-preview-status">{preview.executablePreview ? "Executable" : "Read-only · not executable"}</div>
      <button type="button" className="agent-funding-refresh" onClick={retry} aria-label="Refresh funding preview"><RefreshCw size={13} /> Refresh</button>
    </div>
    {error && <p className="agent-funding-stale" role="status">Refresh unavailable · showing the last returned funding preview.</p>}
    <div className="agent-funding-quickfacts">
      <div><span>REFERENCE FUNDING INTENTION</span><b>{present(funding.backingAmount)}</b><small>USDC · not a wallet balance or deposit · {funding.entryFeesIncluded ? "entry fees included" : "entry fees excluded"}</small></div>
      <div><span>AGGREGATE ROUND COLLATERAL LIMIT</span><b>{capAmount}</b><small>Round cap, not additional funding authority</small></div>
      <div><span>GAS</span><b>{present(funding.availableGas)}</b><small>{authGas}</small></div>
    </div>
    <div className="agent-funding-asset-note">
      <b>USDC ≠ USD credit.</b> They are distinct assets. SDK 1:1 backing scaling is documentation, not a guaranteed conversion or executable valuation.
      {!funding.entryFeesIncluded && <span> Entry fees are not included in the funding intention.</span>}
    </div>
    <div className="agent-funding-path-summary">
      <div><span>FUND</span><b>Owner USDC → WaterX USD credit</b></div>
      <div><span>WITHDRAW</span><b>Queued request → registered keeper → wallet USDC</b></div>
      <div><span>WINNINGS</span><b>Verified settlement → claim → credit withdrawal</b></div>
    </div>
    <p className="agent-funding-queue-note">Withdrawals depend on queued processing and a registered keeper. Timing is not promised.</p>
    <details className="agent-funding-audit">
      <summary>Fetched registration, raw configured fees &amp; full path</summary>
      <div className="agent-funding-audit-facts">
        <span>Registration status<b>{present(preview.status)}</b></span>
        <span>Fetched at<b>{stamp(preview.asOfMs)}</b></span>
        <span>Source / network<b>{present(preview.source)} · {present(preview.network)}</b></span>
        <span>Backing coin type · decimals<b>{preview.backingCoinType} · {present(preview.backingDecimals)}</b></span>
        <span>Credit coin type · decimals<b>{preview.creditCoinType} · {present(preview.creditDecimals)}</b></span>
        <span>Vault / withdrawal queue<b>{present(preview.vault)} · {present(preview.withdrawalQueue)}</b></span>
        <span>Registered keepers<b>{present(preview.registeredKeeperCount)}</b></span>
        <span>Raw mint fee (scaled)<b>{amount(fees.mintFeeScaled)}</b></span>
        <span>Raw burn fee (scaled)<b>{amount(fees.burnFeeScaled)}</b></span>
        <span>Minimum burn · atomic<b>{amount(fees.minimumBurnAmountAtomic)}</b></span>
        <span>Fee scale<b>{fees.scale}</b></span>
        <span>Fee provenance<b>{fees.provenance}</b></span>
        <span>Authorized gas MIST<b>{authGas}</b></span>
        <span>Owner approval ready<b>{preview.readyForOwnerApproval ? "Yes" : "No"}</b></span>
      </div>
      <p className="agent-funding-semantics">{preview.sdkValuation} {preview.semantics}</p>
      {fullPaths.map(([label, path]) => <div className="agent-funding-full-path" key={label}>
        <b>{label}</b><ol>{path.map((step, index) => <li key={`${label}:${index}`}>{step}</li>)}</ol>
      </div>)}
      {preview.blockers.length > 0 && <details className="agent-funding-blockers">
        <summary>Unresolved verification checks · {preview.blockers.length}</summary>
        <ul>{preview.blockers.map((blocker, index) => <li key={`${index}:${blocker}`}>{blocker}</li>)}</ul>
      </details>}
    </details>
  </section>;
}

function isFundingPreview(value: unknown): value is FundingPreview {
  if (!isRecord(value)) return false;
  const fees = value.configuredFees, funding = value.intendedFunding;
  return typeof value.status === "string" && typeof value.asOfMs === "number" &&
    typeof value.backingCoinType === "string" && typeof value.creditCoinType === "string" &&
    isRecord(fees) && isRecord(funding) && Array.isArray(value.fundingPath) &&
    Array.isArray(value.withdrawalPath) && Array.isArray(value.winningsPath) &&
    typeof value.sdkValuation === "string" && value.executablePreview === false &&
    value.readyForOwnerApproval === false && Array.isArray(value.blockers) && typeof value.semantics === "string";
}

export default function AgentFundingPreview() {
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<FundingState>({ preview: null, loading: true, error: "" });
  useEffect(() => {
    const controller = new AbortController();
    setState(previous => ({ ...previous, loading: true, error: "" }));
    fetch("/api/waterx/funding-preview", {
      credentials: "include", signal: controller.signal, headers: { Accept: "application/json" },
    }).then(async response => {
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok || !isFundingPreview(result)) {
        const message = isRecord(result) && typeof result.error === "string" ? result.error : "";
        throw new Error(message || `Funding registration preview unavailable (${response.status}).`);
      }
      if (!controller.signal.aborted) setState({ preview: result, loading: false, error: "" });
    }).catch(reason => {
      if (!controller.signal.aborted) setState(previous => ({
        preview: previous.preview, loading: false,
        error: reason instanceof Error ? reason.message : "Funding registration preview unavailable.",
      }));
    });
    return () => controller.abort();
  }, [reload]);
  return <AgentFundingPreviewView preview={state.preview} loading={state.loading} error={state.error}
    retry={() => setReload(value => value + 1)} />;
}
