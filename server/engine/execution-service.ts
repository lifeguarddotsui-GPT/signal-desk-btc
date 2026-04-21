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
  alreadyClosed?: boolean;
  realPositionId?: string;
};

const adapter = new TypusAdapter();

export class ExecutionService {
  getAdapter(): TypusAdapter {
    return adapter;
  }

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

  /**
   * Close a position by stored positionId.
   * If the stored ID is not found on-chain, falls back to finding the best matching
   * live position by side + collateral — handles orderId/positionId confusion at open time.
   */
  async closeMarketPosition(
    agentRow: any,
    storedPositionId: string,
    hint?: { side?: TradeSide; collateralSui?: number },
  ): Promise<CloseOrderResult> {
    const priceTick = getLastPrice();
    const currentPrice = priceTick?.blended ?? priceTick?.pyth?.price;
    if (!currentPrice) {
      return { success: false, error: "no_price_available" };
    }

    // Guard: stored ID must not be a DB UUID
    const isDbUuid = storedPositionId && storedPositionId.includes("-");

    // Step 1: fetch live on-chain positions
    let livePositions: any[] = [];
    try {
      if (agentRow.walletAddress) {
        livePositions = await adapter.getPositions(agentRow.walletAddress);
        console.log(`[ExecutionService] Live positions for ${agentRow.walletAddress.slice(0, 10)}: ${livePositions.length} | storedId=${storedPositionId}`);
      }
    } catch (fetchErr: any) {
      console.log(`[ExecutionService] getPositions failed: ${fetchErr.message} — will attempt close by stored ID anyway`);
    }

    // Step 2: find the position to close
    let targetId = isDbUuid ? null : storedPositionId;
    let resolvedFromLive = false;

    if (livePositions.length > 0) {
      // Try to find by exact stored ID
      const exactMatch = livePositions.find((p: any) => String(p.positionId) === storedPositionId);
      if (exactMatch) {
        targetId = exactMatch.positionId;
        console.log(`[ExecutionService] Exact ID match: positionId=${targetId}`);
      } else {
        // ID mismatch — find best match by side/collateral
        const MIST = 1_000_000_000;
        const candidates = livePositions.filter((p: any) => {
          if (hint?.side && p.side !== hint.side) return false;
          return true;
        });

        if (candidates.length === 1) {
          targetId = candidates[0].positionId;
          resolvedFromLive = true;
          console.log(`[ExecutionService] ID mismatch — resolved to only live position: positionId=${targetId} side=${candidates[0].side} size=${candidates[0].size?.toFixed(4)}`);
        } else if (candidates.length > 1 && hint?.collateralSui) {
          // Pick closest collateral match
          const sorted = [...candidates].sort((a, b) => {
            const aDiff = Math.abs((a.collateral ?? 0) - hint.collateralSui!);
            const bDiff = Math.abs((b.collateral ?? 0) - hint.collateralSui!);
            return aDiff - bDiff;
          });
          targetId = sorted[0].positionId;
          resolvedFromLive = true;
          console.log(`[ExecutionService] ID mismatch — resolved by collateral match: positionId=${targetId} side=${sorted[0].side}`);
        } else if (livePositions.length === 1) {
          // Only one position on-chain at all — must be it
          targetId = livePositions[0].positionId;
          resolvedFromLive = true;
          console.log(`[ExecutionService] ID mismatch — single on-chain position resolved: positionId=${targetId} side=${livePositions[0].side}`);
        } else {
          console.log(`[ExecutionService] ID mismatch and no clear match — ${livePositions.length} live positions, stored=${storedPositionId} (isDbUuid=${isDbUuid})`);
          if (!targetId) {
            return { success: false, error: `position_id_mismatch: stored=${storedPositionId} not found on-chain, ${livePositions.length} live positions — use Force Close All to recover` };
          }
        }
      }
    } else if (!targetId) {
      // No live positions and no valid stored ID
      console.log(`[ExecutionService] No live positions and no valid ID — position already closed`);
      return { success: true, exitPrice: currentPrice, alreadyClosed: true };
    }

    if (!targetId) {
      return { success: false, error: `no_valid_position_id: stored=${storedPositionId} (isDbUuid=${isDbUuid}) and no live match found` };
    }

    console.log(`[ExecutionService] Closing positionId=${targetId} (resolvedFromLive=${resolvedFromLive}, storedId=${storedPositionId})`);

    const result = await adapter.closePosition({
      agent: agentRow,
      positionId: targetId,
      price: currentPrice,
      isFirstAttempt: true,
    });

    if (!result.success) {
      return { success: false, error: result.error, realPositionId: targetId };
    }
    return {
      success: true,
      exitPrice: currentPrice,
      txDigest: result.txDigest,
      realPositionId: targetId,
    };
  }

  /**
   * Force-close ALL live on-chain positions for the agent wallet.
   * Returns list of close results per position.
   */
  async forceCloseAllPositions(agentRow: any): Promise<Array<{
    positionId: string; side: string; success: boolean; txDigest?: string; error?: string;
  }>> {
    if (!agentRow.walletAddress) return [];

    const priceTick = getLastPrice();
    const currentPrice = priceTick?.blended ?? priceTick?.pyth?.price;

    const livePositions = await adapter.getPositions(agentRow.walletAddress);
    console.log(`[ExecutionService] forceCloseAll: ${livePositions.length} live positions for ${agentRow.walletAddress.slice(0, 10)}`);

    const results: Array<{ positionId: string; side: string; success: boolean; txDigest?: string; error?: string }> = [];

    for (const pos of livePositions) {
      try {
        const price = currentPrice ?? pos.markPrice ?? 0;
        const closeResult = await adapter.closePosition({
          agent: agentRow,
          positionId: pos.positionId,
          price,
          isFirstAttempt: true,
        });
        results.push({
          positionId: pos.positionId,
          side: pos.side,
          success: closeResult.success,
          txDigest: closeResult.txDigest,
          error: closeResult.error,
        });
        console.log(`[ExecutionService] forceClose pos=${pos.positionId} side=${pos.side} → ${closeResult.success ? "OK tx=" + closeResult.txDigest : "FAIL " + closeResult.error}`);
      } catch (err: any) {
        results.push({ positionId: pos.positionId, side: pos.side, success: false, error: err.message });
      }
    }

    return results;
  }
}
