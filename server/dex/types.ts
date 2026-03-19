import type { Agent, Order, Position } from "../../shared/schema";

export interface DexOrderParams {
  agent: Agent;
  symbol: string;
  side: "long" | "short";
  leverage: number;
  quantity: number;
  price: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  slippage?: number;
  openPositionCount?: number;
  prefetchedBalance?: number;
}

export interface DexCloseParams {
  agent: Agent;
  positionId: string;
  side?: "long" | "short";
  quantity?: number;
  price: number;
  skipDryRun?: boolean;
  /** True on the very first close attempt — skips expensive linked-order cancel scan
   *  since no prior close orders exist yet for this position. */
  isFirstAttempt?: boolean;
}

export interface DexOrderResult {
  success: boolean;
  txDigest?: string;
  orderId?: string;
  error?: string;
  venue: string;
  positionId?: string;
  filled?: boolean;
}

export interface DexPositionInfo {
  positionId: string;
  symbol: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  liquidationPrice?: number;
  leverage: number;
  collateral?: number;
}

export interface DexBalanceInfo {
  available: number;
  locked: number;
  total: number;
}

export interface DexFeeEstimate {
  tradingFee: number;
  gasFee: number;
  total: number;
}

export interface DexAdapter {
  readonly venue: string;
  readonly supported: boolean;
  readonly description: string;

  isReady(): boolean;
  openPosition(params: DexOrderParams): Promise<DexOrderResult>;
  closePosition(params: DexCloseParams): Promise<DexOrderResult>;
  getPositions(walletAddress: string): Promise<DexPositionInfo[]>;
  getBalance(walletAddress: string): Promise<DexBalanceInfo>;
  estimateFees(params: DexOrderParams): Promise<DexFeeEstimate>;
  validateOrder(params: DexOrderParams): Promise<{ valid: boolean; reason?: string }>;
}

export interface AgentWallet {
  address: string;
  publicKey: string;
  encryptedPrivateKey: string;
}

export const VENUE_CONFIG: Record<string, { name: string; type: "perp" | "spot"; contractPackage?: string }> = {
  typus: {
    name: "Typus Perps",
    type: "perp",
    contractPackage: "0x9003219180252ae6b81d2893b41d430488669027219537236675c0c2924c94d9",
  },
};
