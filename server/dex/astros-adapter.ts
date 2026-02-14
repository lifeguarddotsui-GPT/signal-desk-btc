import type { DexAdapter, DexOrderParams, DexCloseParams, DexOrderResult, DexPositionInfo, DexBalanceInfo, DexFeeEstimate } from "./types";
import { decryptKeypair } from "./wallet-manager";

const ASTROS_API_BASE = "https://api.astros.ag";

async function astrosPublicRequest(
  method: "GET" | "POST",
  path: string,
  params: Record<string, string | number>,
): Promise<any> {
  const url = new URL(path, ASTROS_API_BASE);

  if (method === "GET") {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  }

  const response = await fetch(url.toString(), {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(params) : undefined,
  });

  if (!response.ok) {
    throw new Error(`Astros API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (data.code && data.code !== 200) {
    throw new Error(`Astros API error: ${data.msg || "Unknown error"}`);
  }
  return data;
}

export class AstrosAdapter implements DexAdapter {
  readonly venue = "astros";
  readonly supported = true;
  readonly description = "Astros Perps - Perpetual DEX on SUI powered by NAVI Protocol with up to 25x leverage";

  isReady(): boolean {
    return true;
  }

  async openPosition(params: DexOrderParams): Promise<DexOrderResult> {
    try {
      const validation = await this.validateOrder(params);
      if (!validation.valid) {
        return { success: false, error: validation.reason, venue: this.venue };
      }

      if (!params.agent.agentWallet) {
        return { success: false, error: "Agent wallet not configured", venue: this.venue };
      }

      const keypair = decryptKeypair(params.agent.agentWallet);
      const address = keypair.getPublicKey().toSuiAddress();

      const timestamp = Date.now();
      const side = params.side === "long" ? "BUY" : "SELL";

      const message = `Place Order\nSymbol: SUI-USD\nSide: ${side}\nQuantity: ${params.quantity}\nLeverage: ${params.leverage}\nTimestamp: ${timestamp}`;
      const { signature } = await keypair.signPersonalMessage(new TextEncoder().encode(message));

      const orderPayload: Record<string, string | number> = {
        symbol: "SUI-USD",
        side,
        type: "MARKET",
        quantity: params.quantity,
        leverage: params.leverage,
        address,
        timestamp,
        signature,
      };

      if (params.stopLossPrice) {
        orderPayload.stopLossPrice = params.stopLossPrice;
      }
      if (params.takeProfitPrice) {
        orderPayload.takeProfitPrice = params.takeProfitPrice;
      }

      const result = await astrosPublicRequest(
        "POST",
        "/api/contract-sub-provider/order/place",
        orderPayload,
      );

      if (result.data?.orderId) {
        return {
          success: true,
          txDigest: String(result.data.orderId),
          orderId: String(result.data.orderId),
          venue: this.venue,
        };
      }

      return {
        success: false,
        error: result.msg || "Order placement failed",
        venue: this.venue,
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Astros execution error: ${error.message}`,
        venue: this.venue,
      };
    }
  }

  async closePosition(params: DexCloseParams): Promise<DexOrderResult> {
    try {
      if (!params.agent.agentWallet) {
        return { success: false, error: "Agent wallet not configured", venue: this.venue };
      }

      const keypair = decryptKeypair(params.agent.agentWallet);
      const address = keypair.getPublicKey().toSuiAddress();

      const timestamp = Date.now();
      const message = `Close Position\nPosition: ${params.positionId}\nTimestamp: ${timestamp}`;
      const { signature } = await keypair.signPersonalMessage(new TextEncoder().encode(message));

      const result = await astrosPublicRequest(
        "POST",
        "/api/contract-sub-provider/order/close",
        {
          symbol: "SUI-USD",
          positionId: params.positionId,
          quantity: params.quantity || 0,
          address,
          timestamp,
          signature,
        },
      );

      if (result.data?.orderId) {
        return {
          success: true,
          txDigest: String(result.data.orderId),
          venue: this.venue,
        };
      }

      return {
        success: false,
        error: result.msg || "Close position failed",
        venue: this.venue,
      };
    } catch (error: any) {
      return { success: false, error: `Astros close error: ${error.message}`, venue: this.venue };
    }
  }

  async getPositions(walletAddress: string): Promise<DexPositionInfo[]> {
    try {
      const result = await astrosPublicRequest(
        "GET",
        "/api/contract-sub-provider/position/list",
        { address: walletAddress, symbol: "SUI-USD" },
      );

      if (!result.data || !Array.isArray(result.data)) return [];

      return result.data.map((pos: any) => ({
        positionId: String(pos.positionId || pos.id),
        symbol: "SUI-PERP",
        side: pos.side === "BUY" ? "long" as const : "short" as const,
        size: Number(pos.size || pos.quantity || 0),
        entryPrice: Number(pos.entryPrice || 0),
        markPrice: Number(pos.markPrice || 0),
        unrealizedPnl: Number(pos.unrealizedPnl || pos.pnl || 0),
        liquidationPrice: Number(pos.liquidationPrice || 0),
        leverage: Number(pos.leverage || 1),
      }));
    } catch (error: any) {
      console.error(`Astros getPositions error: ${error.message}`);
      return [];
    }
  }

  async getBalance(walletAddress: string): Promise<DexBalanceInfo> {
    try {
      const result = await astrosPublicRequest(
        "GET",
        "/api/contract-sub-provider/account/balance",
        { address: walletAddress },
      );

      if (result.data) {
        const available = Number(result.data.available || result.data.balance || 0);
        const locked = Number(result.data.locked || result.data.margin || 0);
        return { available, locked, total: available + locked };
      }
      return { available: 0, locked: 0, total: 0 };
    } catch {
      return { available: 0, locked: 0, total: 0 };
    }
  }

  async estimateFees(params: DexOrderParams): Promise<DexFeeEstimate> {
    const notionalValue = params.quantity * params.price;
    const tradingFee = notionalValue * 0.0005;
    const gasFee = 0.003;
    return { tradingFee, gasFee, total: tradingFee + gasFee };
  }

  async validateOrder(params: DexOrderParams): Promise<{ valid: boolean; reason?: string }> {
    if (params.leverage < 1 || params.leverage > 25) {
      return { valid: false, reason: "Leverage must be between 1x and 25x for Astros Perps" };
    }
    if (params.quantity <= 0) {
      return { valid: false, reason: "Quantity must be positive" };
    }
    const requiredCollateral = (params.quantity * params.price) / params.leverage;
    if (params.agent.balance < requiredCollateral) {
      return { valid: false, reason: `Insufficient balance: need ${requiredCollateral.toFixed(4)} SUI, have ${params.agent.balance.toFixed(4)} SUI` };
    }
    return { valid: true };
  }
}
