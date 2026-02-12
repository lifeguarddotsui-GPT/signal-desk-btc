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
  sudo: {
    name: "Sudo Perps",
    type: "perp",
    contractPackage: "0x48aeb75a87153adb3e0f1f0d3e0b4b88b67c2a0e6b5c0c2a0e6b5c0c2a0e6b5c",
  },
  typus: {
    name: "Typus Finance",
    type: "perp",
    contractPackage: "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1",
  },
  flowx: {
    name: "FlowX Finance",
    type: "spot",
  },
  zofai: {
    name: "ZoFAI",
    type: "perp",
  },
};
