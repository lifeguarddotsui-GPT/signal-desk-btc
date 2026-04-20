import { TypusAdapter } from "../dex/typus-adapter";
import { getLastPrice } from "../price-service";
import type { TradeSide } from "./types";

export type OpenOrderInput = {
  agentRow: any;
  side: TradeSide;
  collateralSui: number;
  leverage: number;
};

export type OpenOrderResult = {
  success: boolean;
  positionId?: string;
  entryPrice?: number;
  txDigest?: string;
  error?: string;
};

export type CloseOrderResult = {
  success: boolean;
  exitPrice?: number;
  txDigest?: string;
  error?: string;
};

const adapter = new TypusAdapter();

export class ExecutionService {
  async openMarketPosition(input: OpenOrderInput): Promise<OpenOrderResult> {
    const priceTick = getLastPrice();
    const currentPrice = priceTick?.blended ?? priceTick?.pyth?.price;
    if (!currentPrice) {
      return { success: false, error: "no_price_available" };
    }
    const { agentRow, side, collateralSui, leverage } = input;
    const quantity = collateralSui * leverage;
    const result = await adapter.openPosition({
      agent: agentRow,
      symbol: "SUI-USDC",
      side,
      leverage,
      quantity,
      price: currentPrice,
      openPositionCount: 0,
    });
    if (!result.success) {
      return { success: false, error: result.error };
    }
    return {
      success: true,
      positionId: result.positionId,
      entryPrice: currentPrice,
      txDigest: result.txDigest,
    };
  }

  async closeMarketPosition(agentRow: any, positionId: string): Promise<CloseOrderResult> {
    const priceTick = getLastPrice();
    const currentPrice = priceTick?.blended ?? priceTick?.pyth?.price;
    if (!currentPrice) {
      return { success: false, error: "no_price_available" };
    }
    const result = await adapter.closePosition({
      agent: agentRow,
      positionId,
      price: currentPrice,
      isFirstAttempt: true,
    });
    if (!result.success) {
      return { success: false, error: result.error };
    }
    return {
      success: true,
      exitPrice: currentPrice,
      txDigest: result.txDigest,
    };
  }
}
