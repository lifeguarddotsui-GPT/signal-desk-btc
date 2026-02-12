import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import type { DexAdapter, DexOrderParams, DexCloseParams, DexOrderResult, DexPositionInfo, DexBalanceInfo, DexFeeEstimate } from "./types";

const SUI_RPC = "https://fullnode.mainnet.sui.io:443";

export class ZoFAIAdapter implements DexAdapter {
  readonly venue = "zofai";
  readonly supported = false;
  readonly description = "ZoFAI - Intelligent perpetual trading on SUI (SDK pending release)";
  private client: SuiJsonRpcClient;

  constructor() {
    this.client = new SuiJsonRpcClient({ url: SUI_RPC, network: "mainnet" });
  }

  async openPosition(params: DexOrderParams): Promise<DexOrderResult> {
    return {
      success: false,
      error: "ZoFAI SDK is not yet available for SUI mainnet. Trade execution will be enabled once the official SDK is published. Your signal agent continues to generate signals for manual execution on zofai.io",
      venue: this.venue,
    };
  }

  async closePosition(params: DexCloseParams): Promise<DexOrderResult> {
    return {
      success: false,
      error: "ZoFAI SDK not yet available - close positions manually at zofai.io",
      venue: this.venue,
    };
  }

  async getPositions(_walletAddress: string): Promise<DexPositionInfo[]> {
    return [];
  }

  async getBalance(walletAddress: string): Promise<DexBalanceInfo> {
    try {
      const balance = await this.client.getBalance({ owner: walletAddress });
      const total = Number(balance.totalBalance) / 1e9;
      return { available: total, locked: 0, total };
    } catch {
      return { available: 0, locked: 0, total: 0 };
    }
  }

  async estimateFees(params: DexOrderParams): Promise<DexFeeEstimate> {
    const notionalValue = params.quantity * params.price;
    const tradingFee = notionalValue * 0.001;
    const gasFee = 0.005;
    return { tradingFee, gasFee, total: tradingFee + gasFee };
  }

  async validateOrder(params: DexOrderParams): Promise<{ valid: boolean; reason?: string }> {
    return { valid: false, reason: "ZoFAI SDK not yet available for SUI mainnet. Automated execution pending SDK release." };
  }
}
