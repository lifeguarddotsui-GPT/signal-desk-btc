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
}

export interface DexCloseParams {
  agent: Agent;
  positionId: string;
  quantity?: number;
  price: number;
}

export interface DexOrderResult {
  success: boolean;
  txDigest?: string;
  orderId?: string;
  error?: string;
  venue: string;
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
  astros: {
    name: "Astros Perps",
    type: "perp",
  },
};
