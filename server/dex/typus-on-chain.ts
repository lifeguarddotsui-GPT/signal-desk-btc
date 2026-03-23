/**
 * Direct on-chain position and order reading using the official Typus Perp SDK.
 *
 * Uses the SDK's getUserOrders / getUserPositions which call devInspectTransactionBlock
 * and BCS-decode results using the SDK's own generated type schemas.
 *
 * This replaces the unreliable event-scanning approach:
 *  - One RPC call instead of 30+ pages of event queries
 *  - Returns LIVE state, not historical events
 *  - Trigger prices come directly from on-chain order state
 *  - Position side comes from on-chain is_long field (ground truth)
 */

import type { DexPositionInfo } from "./types";

export const PERP_PACKAGE = "0xf60e3542f1c65a77d9bcdffd5d8a712a46b935ec51b9052e5ad98888e0392d09";
export const PERP_TRADING_PACKAGE_LEGACY = "0x9003219180252ae6b81d2893b41d430488669027219537236675c0c2924c94d9";
export const PERP_VERSION_OBJ = "0x7c30204bd3f4dc37918281907308e0d7d09a75a6826473aec0caa1712ee149e5";
export const MARKET_REGISTRY_OBJ = "0x327c8a176055400e9aacde8553a897898b5da969d6dcdb55eee268bb501a2c3a";

const SUI_MARKET_INDEX = 0;
const MIST_PER_SUI = 1_000_000_000;

let _sdkFetch: any = null;
async function getSdkFetch() {
  if (!_sdkFetch) {
    _sdkFetch = await import("@typus/typus-perp-sdk/dist/src/fetch.js");
  }
  return _sdkFetch;
}

export interface OnChainOrder {
  order_id: string;
  linked_position_id: string | null;
  trigger_price: bigint;
  is_long: boolean;
  reduce_only: boolean;
  is_stop_order: boolean;
  size: bigint;
  size_decimal: bigint;
  marketIndex: number;
  collateral_token: string;
  oracle_price_when_placing: bigint;
}

export interface OnChainPosition {
  position_id: string;
  is_long: boolean;
  size: bigint;
  size_decimal: bigint;
  collateral_amount: bigint;
  average_price: bigint;
  linked_order_ids: string[];
  linked_order_prices: bigint[];
  marketIndex: number;
  collateral_token: string;
  user: string;
}

function normalizeTypeName(typeName: any): string {
  if (!typeName) return "";
  if (typeof typeName === "string") return typeName;
  if (typeName.name) return String(typeName.name);
  return String(typeName);
}

function normalizeBigInt(v: any): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v === "bigint") return v;
  return BigInt(String(v));
}

export async function getOnChainOrders(suiClient: any, walletAddress: string): Promise<OnChainOrder[]> {
  try {
    const sdk = await getSdkFetch();
    const rawOrders = await sdk.getUserOrders(suiClient, {
      indexes: [SUI_MARKET_INDEX],
      user: walletAddress,
    });

    const result: OnChainOrder[] = rawOrders.map((o: any) => ({
      order_id: String(o.order_id),
      linked_position_id: o.linked_position_id !== null && o.linked_position_id !== undefined
        ? String(o.linked_position_id)
        : null,
      trigger_price: normalizeBigInt(o.trigger_price),
      is_long: Boolean(o.is_long),
      reduce_only: Boolean(o.reduce_only),
      is_stop_order: Boolean(o.is_stop_order),
      size: normalizeBigInt(o.size),
      size_decimal: normalizeBigInt(o.size_decimal ?? 9),
      marketIndex: SUI_MARKET_INDEX,
      collateral_token: normalizeTypeName(o.collateral_token),
      oracle_price_when_placing: normalizeBigInt(o.oracle_price_when_placing),
    }));

    console.log(`[OnChain] getOnChainOrders(${walletAddress.slice(0, 10)}): ${result.length} order(s)`);
    return result;
  } catch (err: any) {
    console.log(`[OnChain] getOnChainOrders failed for ${walletAddress.slice(0, 10)}: ${err.message}`);
    return [];
  }
}

export async function getOnChainPositions(suiClient: any, walletAddress: string): Promise<OnChainPosition[]> {
  try {
    const sdk = await getSdkFetch();
    const rawPositions = await sdk.getUserPositions(suiClient, {
      indexes: [SUI_MARKET_INDEX],
      user: walletAddress,
    });

    const result: OnChainPosition[] = rawPositions.map((p: any) => ({
      position_id: String(p.position_id),
      is_long: Boolean(p.is_long),
      size: normalizeBigInt(p.size),
      size_decimal: normalizeBigInt(p.size_decimal ?? 9),
      collateral_amount: normalizeBigInt(p.collateral_amount),
      average_price: normalizeBigInt(p.average_price),
      linked_order_ids: (p.linked_order_ids || []).map((id: any) => String(id)),
      linked_order_prices: (p.linked_order_prices || []).map((pr: any) => normalizeBigInt(pr)),
      marketIndex: SUI_MARKET_INDEX,
      collateral_token: normalizeTypeName(p.collateral_token),
      user: p.user || walletAddress,
    }));

    console.log(`[OnChain] getOnChainPositions(${walletAddress.slice(0, 10)}): ${result.length} position(s)`);
    return result;
  } catch (err: any) {
    console.log(`[OnChain] getOnChainPositions failed for ${walletAddress.slice(0, 10)}: ${err.message}`);
    return [];
  }
}

export function onChainPositionToDexInfo(p: OnChainPosition): DexPositionInfo {
  const decimalFactor = Number(BigInt(10) ** p.size_decimal);
  const sizeInSui = Number(p.size) / decimalFactor;
  const collateralSui = Number(p.collateral_amount) / MIST_PER_SUI;
  const entryPriceUsd = Number(p.average_price) / 1e8;
  const leverage = collateralSui > 0 ? Math.max(1, Math.round(sizeInSui / collateralSui)) : 30;
  return {
    positionId: p.position_id,
    symbol: "SUI-PERP",
    side: p.is_long ? "long" : "short",
    size: sizeInSui,
    entryPrice: entryPriceUsd,
    markPrice: entryPriceUsd,
    unrealizedPnl: 0,
    leverage,
    collateral: collateralSui > 0 ? collateralSui : undefined,
  };
}
