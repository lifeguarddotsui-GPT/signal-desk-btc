/**
 * Launchpad integrations are deliberately separated from signing. An adapter
 * may discover and quote, but no interface here accepts a private key.
 */
export type SuiNetwork = "mainnet" | "testnet" | "devnet" | "localnet";

export interface AssetId {
  network: SuiNetwork;
  coinType: string;
  packageId?: string;
  curveId?: string;
}

export interface EventBatch {
  network: SuiNetwork;
  events: readonly MarketEvent[];
  nextCursor?: string;
  checkpoint?: string;
  coverage: "COMPLETE" | "PARTIAL" | "UNKNOWN";
}

export interface MarketEvent {
  eventId: string;
  type: "LAUNCH" | "TRADE" | "MIGRATION" | "UNKNOWN";
  asset: AssetId;
  checkpoint: string;
  digest?: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface VerifiedMarketState {
  network: SuiNetwork;
  asset: AssetId;
  packageLineage: string;
  checkpoint: string;
  verified: boolean;
  coverage: "COMPLETE" | "PARTIAL" | "UNKNOWN";
  state: Record<string, unknown>;
}

export interface ExecutableQuote {
  network: SuiNetwork;
  asset: AssetId;
  side: "BUY" | "SELL";
  inputBaseUnits: string;
  expectedOutputBaseUnits: string;
  minimumOutputBaseUnits: string;
  feeBaseUnits: string;
  priceImpactBps: number | null;
  checkpoint: string;
  expiresAt: string;
}

export interface ValidatedIntent {
  network: SuiNetwork;
  asset: AssetId;
  side: "BUY" | "SELL";
  inputBaseUnits: string;
  minimumOutputBaseUnits: string;
  policyVersion: string;
  idempotencyKey: string;
}

export interface UnsignedTransaction {
  network: SuiNetwork;
  bytes: string;
  intentKey: string;
  expiresAt: string;
}

export interface ExecutionResult {
  network: SuiNetwork;
  digest: string;
  status: "CONFIRMED" | "FAILED" | "UNKNOWN";
  effects?: Record<string, unknown>;
  error?: string;
}

export interface LaunchpadAdapter {
  discover(cursor?: string): Promise<EventBatch>;
  getMarket(asset: AssetId): Promise<VerifiedMarketState>;
  quoteBuy(asset: AssetId, suiMist: bigint): Promise<ExecutableQuote>;
  quoteSell(asset: AssetId, units: bigint): Promise<ExecutableQuote>;
  build(intent: ValidatedIntent): Promise<UnsignedTransaction>;
  reconcile(digest: string): Promise<ExecutionResult>;
}

/** Safe default until a verified Suipump contract lineage is configured. */
export class UnconfiguredSuipumpAdapter implements LaunchpadAdapter {
  private unavailable(): never {
    throw new Error("SUIPUMP_ADAPTER_UNAVAILABLE: no verified mainnet adapter is configured");
  }

  discover(): Promise<EventBatch> { return Promise.reject(this.unavailable()); }
  getMarket(): Promise<VerifiedMarketState> { return Promise.reject(this.unavailable()); }
  quoteBuy(): Promise<ExecutableQuote> { return Promise.reject(this.unavailable()); }
  quoteSell(): Promise<ExecutableQuote> { return Promise.reject(this.unavailable()); }
  build(): Promise<UnsignedTransaction> { return Promise.reject(this.unavailable()); }
  reconcile(): Promise<ExecutionResult> { return Promise.reject(this.unavailable()); }
}