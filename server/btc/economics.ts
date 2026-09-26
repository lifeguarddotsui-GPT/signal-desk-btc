import {
  expiryMarketMoveCalls,
  pricingMoveCalls,
  POS_INF_TICK,
  rawToPrice,
  rawToProbability,
  rawToUsdc,
  U64_MAX,
  usdcToRaw,
} from "@mysten/deepbook-v3/predict";
import { Transaction } from "@mysten/sui/transactions";
import { MANUAL_TIME_BUDGET_MS } from "./advisor";
import { readContext } from "./source";

export const DEFAULT_PAYOUT_QUANTITY_USD = 5;
export const MAX_QUOTE_AGE_MS = 15_000;
const POSITION_LOT_RAW = BigInt(readContext.predictConfig.units.positionLotSize);
const IDENTITY = /^0x[0-9a-f]{64}$/i;

export type QuoteStatus =
  | "AVAILABLE" | "PARTIAL" | "TOO_LATE" | "EXPIRED" | "ROUND_MISMATCH"
  | "PAUSED_MARKET" | "MISSING_REFERENCE" | "STALE_QUOTE"
  | "PROVIDER_ERROR" | "ONCHAIN_REJECTED";

export type OutcomeEconomics = {
  status: "AVAILABLE" | "UNAVAILABLE";
  side: "UP" | "DOWN";
  source: "DeepBook expiry_market::quote_mint (anonymous read-only devInspect)";
  sizeMode: "PAYOUT_QUANTITY";
  requestedPayoutQuantity: number;
  quantity: number;
  entryProbability: number;
  premium: number;
  fees: { trading: number; builder: number; penalty: number; inventoryImpact: number };
  feeIncentiveSubsidy: number;
  netTradingFee: number;
  allInCost: number;
  grossWinningPayout: number;
  winningNetBeforeNetworkCosts: number;
  losingNetBeforeNetworkCosts: number;
  breakEvenProbability: number;
  networkCostsIncluded: false;
  reason: string | null;
};

export type RoundEconomics = {
  status: QuoteStatus;
  marketId: string;
  expiryMs: number;
  asOf: string;
  ageMs: number;
  sizing: {
    mode: "PAYOUT_QUANTITY";
    requestedPayoutQuantity: number;
    totalSpendBudget: null;
    note: string;
  };
  referencePrice: number | null;
  referenceAsOf: string | null;
  oracleSourceTimes: {
    pythSpot: string | null;
    blockScholesSpot: string;
    blockScholesForward: string;
    blockScholesSvi: string;
  } | null;
  assumptions: string[];
  up: OutcomeEconomics | null;
  down: OutcomeEconomics | null;
  reason: string | null;
};

type RawQuote = {
  quantity: bigint;
  entry_probability: bigint;
  premium: bigint;
  trading_fee: bigint;
  fee_incentive_subsidy: bigint;
  builder_fee: bigint;
  penalty_fee: bigint;
  inventory_impact_charge: bigint;
  all_in_cost: bigint;
};

function unavailable(
  input: { marketId: string; expiryMs: number; payoutQuantity: number },
  status: QuoteStatus,
  reason: string,
  now = Date.now(),
): RoundEconomics {
  return {
    status, marketId: input.marketId, expiryMs: input.expiryMs,
    asOf: new Date(now).toISOString(), ageMs: 0,
    sizing: { mode: "PAYOUT_QUANTITY", requestedPayoutQuantity: input.payoutQuantity,
      totalSpendBudget: null,
      note: "Quantity is the gross winning payout target, not a spend budget. All-in cost is quoted separately." },
    referencePrice: null, referenceAsOf: null, oracleSourceTimes: null,
    assumptions: ["No quote is executable or account-specific.", "Network/gas costs are not included."],
    up: null, down: null, reason,
  };
}

export function economicsFromMintQuote(quote: RawQuote, side: "UP" | "DOWN",
  requestedPayoutQuantity: number): OutcomeEconomics {
  const fields = [quote.quantity, quote.entry_probability, quote.premium, quote.trading_fee,
    quote.fee_incentive_subsidy, quote.builder_fee, quote.penalty_fee,
    quote.inventory_impact_charge, quote.all_in_cost];
  if (fields.some(value => typeof value !== "bigint" || value < BigInt(0)))
    throw new Error("The chain quote contains an invalid negative or non-integer amount.");
  if (quote.quantity === BigInt(0) || quote.all_in_cost === BigInt(0) ||
      quote.fee_incentive_subsidy > quote.trading_fee)
    throw new Error("The chain quote contains an invalid quantity, cost, or fee subsidy.");
  const netTradingFee = quote.trading_fee - quote.fee_incentive_subsidy;
  const sum = quote.premium + netTradingFee + quote.builder_fee +
    quote.penalty_fee + quote.inventory_impact_charge;
  if (sum !== quote.all_in_cost)
    throw new Error("The quote's fee decomposition does not equal its on-chain all-in cost.");
  const quantity = rawToUsdc(quote.quantity);
  const allInCost = rawToUsdc(quote.all_in_cost);
  const requestedRaw = usdcToRaw(requestedPayoutQuantity);
  if (quote.quantity !== requestedRaw)
    throw new Error("The exact-quantity quote returned a different payout quantity.");
  const breakEvenProbability = Number(quote.all_in_cost) / Number(quote.quantity);
  const entryProbability = rawToProbability(quote.entry_probability);
  if (!Number.isFinite(entryProbability) || entryProbability < 0 || entryProbability > 1 ||
      !Number.isFinite(breakEvenProbability) || breakEvenProbability <= 0 ||
      breakEvenProbability > 1 || quote.all_in_cost > quote.quantity)
    throw new Error("The chain quote has an invalid probability or exceeds its gross payout.");
  return {
    status: "AVAILABLE", side,
    source: "DeepBook expiry_market::quote_mint (anonymous read-only devInspect)",
    sizeMode: "PAYOUT_QUANTITY",
    requestedPayoutQuantity, quantity, entryProbability,
    premium: rawToUsdc(quote.premium),
    fees: {
      trading: rawToUsdc(quote.trading_fee), builder: rawToUsdc(quote.builder_fee),
      penalty: rawToUsdc(quote.penalty_fee), inventoryImpact: rawToUsdc(quote.inventory_impact_charge),
    },
    feeIncentiveSubsidy: rawToUsdc(quote.fee_incentive_subsidy),
    netTradingFee: rawToUsdc(netTradingFee), allInCost,
    grossWinningPayout: quantity,
    winningNetBeforeNetworkCosts: quantity - allInCost,
    losingNetBeforeNetworkCosts: -allInCost,
    breakEvenProbability,
    networkCostsIncluded: false,
    reason: null,
  };
}

function u64(bytes: Uint8Array | undefined, field: string): bigint {
  if (!bytes || bytes.length !== 8) throw new Error(`Read-only quote is missing the ${field} u64 result.`);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
}

function optionalU64(bytes: Uint8Array | undefined, field: string): bigint | null {
  if (!bytes) throw new Error(`Read-only quote is missing the ${field} result.`);
  if (bytes.length === 1 && bytes[0] === 0) return null;
  if (bytes.length === 9 && bytes[0] === 1)
    return new DataView(bytes.buffer, bytes.byteOffset + 1, 8).getBigUint64(0, true);
  throw new Error(`Read-only quote returned malformed BCS Option<u64> for ${field}.`);
}

function safeTimestamp(ms: bigint, field: string): string {
  const value = Number(ms);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`Read-only quote has no valid ${field} source timestamp.`);
  return new Date(value).toISOString();
}

function quoteFailure(error: unknown): { status: QuoteStatus; reason: string } {
  const text = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|aborted/i.test(text))
    return { status: "PROVIDER_ERROR", reason: "DeepBook quote simulation timed out; no economics are reported." };
  if (/network|fetch failed|connection|unavailable|429|too many requests/i.test(text))
    return { status: "PROVIDER_ERROR", reason: "DeepBook quote provider is unavailable; no economics are reported." };
  if (/stale|oracle|pricer|source timestamp/i.test(text))
    return { status: "STALE_QUOTE", reason: `DeepBook rejected the quote because a pricing input was stale or unavailable (${text.slice(0, 120)}).` };
  if (/pause|mint_paused|market_paused/i.test(text))
    return { status: "PAUSED_MARKET", reason: "The market is paused for new mints; no quote is reported." };
  if (/expired|expiry|no.?trade|entry window|trade window/i.test(text))
    return { status: "TOO_LATE", reason: `DeepBook's entry window is closed (${text.slice(0, 120)}).` };
  return { status: "ONCHAIN_REJECTED",
    reason: `DeepBook rejected the anonymous read-only quote (${text.slice(0, 160)}). No costs or payout are inferred.` };
}

/**
 * Request an anonymous, non-mutating mainnet quote for the specified live BTC
 * expiry. The amount is a gross payout quantity (default $5.00), never a spend
 * budget. Both sides use the market's on-chain reference tick and one fresh
 * PTB-local pricer. No account, signer, transaction submission, or wallet is used.
 */
export async function quoteRoundEconomics(
  input: { marketId: string; expiryMs: number; payoutQuantity?: number },
  options: { now?: () => number } = {},
): Promise<RoundEconomics> {
  const now = options.now ?? Date.now;
  const payoutQuantity = input.payoutQuantity ?? DEFAULT_PAYOUT_QUANTITY_USD;
  const request = { ...input, payoutQuantity };
  if (!IDENTITY.test(input.marketId) || !Number.isSafeInteger(input.expiryMs))
    return unavailable(request, "ROUND_MISMATCH", "Invalid market ID or expiry supplied.");
  let requestedRaw: bigint;
  try {
    requestedRaw = usdcToRaw(payoutQuantity);
  } catch {
    return unavailable(request, "ONCHAIN_REJECTED", "Payout quantity is not a valid USDC amount.");
  }
  if (requestedRaw <= BigInt(0) || requestedRaw % POSITION_LOT_RAW !== BigInt(0))
    return unavailable(request, "ONCHAIN_REJECTED",
      `Payout quantity must be positive and align to the ${rawToUsdc(POSITION_LOT_RAW)} USDC position lot.`);
  const before = now();
  if (input.expiryMs <= before)
    return unavailable(request, "EXPIRED", "This round has expired; quotes are never carried into another round.", before);
  if (input.expiryMs - before <= MANUAL_TIME_BUDGET_MS)
    return unavailable(request, "TOO_LATE", "Entry window is closed by the 18-second manual safety budget.", before);

  const { client, config, predictConfig } = readContext;
  const callConfig = {
    predictPackageId: predictConfig.packages.predict,
    protocolConfig: predictConfig.objects.protocolConfig,
    oracleRegistry: predictConfig.objects.oracleRegistry,
  };
  const marketArgs = { market: input.marketId };
  try {
    const stateTx = new Transaction();
    stateTx.add(expiryMarketMoveCalls.expiry({ config: callConfig, arguments: marketArgs }));
    stateTx.add(expiryMarketMoveCalls.tickSize({ config: callConfig, arguments: marketArgs }));
    stateTx.add(expiryMarketMoveCalls.mintPaused({ config: callConfig, arguments: marketArgs }));
    stateTx.add(expiryMarketMoveCalls.referenceTick({ config: callConfig, arguments: marketArgs }));
    stateTx.add(expiryMarketMoveCalls.referenceTickSourceTimestampMs({
      config: callConfig, arguments: marketArgs,
    }));
    stateTx.setSender("0x0");
    const stateResult = await client.core.simulateTransaction({
      transaction: stateTx, checksEnabled: false, include: { commandResults: true },
    });
    if (stateResult.$kind === "FailedTransaction") {
      const message = JSON.stringify(stateResult.FailedTransaction?.status?.error ?? "failed transaction");
      const failure = quoteFailure(new Error(message));
      return unavailable(request, failure.status, failure.reason, now());
    }
    const stateCommands = stateResult.commandResults;
    if (!stateCommands || stateCommands.length < 5)
      throw new Error("Market-state read returned an incomplete command result.");
    const chainExpiry = u64(stateCommands[0].returnValues?.[0]?.bcs, "expiry");
    const tickSizeRaw = u64(stateCommands[1].returnValues?.[0]?.bcs, "tick size");
    const pausedBytes = stateCommands[2].returnValues?.[0]?.bcs;
    if (!pausedBytes || pausedBytes.length !== 1)
      throw new Error("Market-state read returned a malformed mint-pause flag.");
    const isPaused = pausedBytes[0] !== 0;
    const referenceTick = optionalU64(stateCommands[3].returnValues?.[0]?.bcs, "reference tick");
    const referenceTimestamp = u64(stateCommands[4].returnValues?.[0]?.bcs, "reference timestamp");
    const stateReadAt = now();
    if (chainExpiry !== BigInt(input.expiryMs))
      return unavailable(request, "ROUND_MISMATCH", "Market ID and expiry do not identify the same on-chain round.", stateReadAt);
    if (isPaused)
      return unavailable(request, "PAUSED_MARKET", "The on-chain market is paused for new mints.", stateReadAt);
    if (tickSizeRaw <= BigInt(0) || referenceTick === null || referenceTick <= BigInt(0) ||
        referenceTick >= POS_INF_TICK || referenceTimestamp === BigInt(0))
      return unavailable(request, "MISSING_REFERENCE", "The active market has no valid on-chain reference tick yet.", stateReadAt);
    if (input.expiryMs - stateReadAt <= MANUAL_TIME_BUDGET_MS)
      return unavailable(request, "TOO_LATE", "Entry window closed while validating on-chain market state.", stateReadAt);

    const btc = predictConfig.underlyings.BTC;
    if (!btc) throw new Error("Installed mainnet SDK has no configured BTC oracle feeds.");
    const tx = new Transaction();
    const pricer = tx.add(expiryMarketMoveCalls.loadLivePricer({
      config: callConfig,
      arguments: {
        market: input.marketId, pyth: btc.pythFeed,
        bsValues: btc.blockScholesValueStore, bsSvi: btc.blockScholesSviStore,
      },
    }));
    const makeQuote = (side: "UP" | "DOWN") => {
      const up = side === "UP";
      return expiryMarketMoveCalls.quoteMint({
        config: callConfig,
        arguments: {
          market: input.marketId, pricer,
          lowerTick: up ? referenceTick! : BigInt(0),
          higherTick: up ? POS_INF_TICK : referenceTick!,
          maxPremium: U64_MAX,
          minQuantity: requestedRaw,
          exactQuantity: true,
        },
      });
    };
    tx.add(makeQuote("UP"));
    tx.add(makeQuote("DOWN"));
    tx.setSender("0x0");
    const result = await client.core.simulateTransaction({
      transaction: tx, checksEnabled: false, include: { commandResults: true },
    });
    const completedAt = now();
    if (result.$kind === "FailedTransaction") {
      const message = JSON.stringify(result.FailedTransaction?.status?.error ?? "failed transaction");
      const failure = quoteFailure(new Error(message));
      return unavailable(request, failure.status, failure.reason, completedAt);
    }
    if (completedAt >= input.expiryMs)
      return unavailable(request, "EXPIRED", "Round expired before both anonymous quotes completed.", completedAt);
    const commands = result.commandResults;
    if (!commands || commands.length < 3)
      throw new Error("Quote simulation returned incomplete command results.");
    const pricerBytes = commands[0].returnValues?.[0]?.bcs;
    const upBytes = commands[1].returnValues?.[0]?.bcs;
    const downBytes = commands[2].returnValues?.[0]?.bcs;
    if (!pricerBytes || !upBytes || !downBytes)
      throw new Error("Quote simulation omitted a pricer or MintQuote BCS return value.");
    const livePricer = pricingMoveCalls.Pricer.parse(pricerBytes);
    const pythSpotMs = Number(livePricer.pyth_spot_source_timestamp_ms);
    const oracleTimes = {
      pythSpot: pythSpotMs > 0 ? safeTimestamp(livePricer.pyth_spot_source_timestamp_ms, "Pyth spot") : null,
      blockScholesSpot: safeTimestamp(livePricer.block_scholes_spot_source_timestamp_ms, "Block Scholes spot"),
      blockScholesForward: safeTimestamp(livePricer.block_scholes_forward_source_timestamp_ms, "Block Scholes forward"),
      blockScholesSvi: safeTimestamp(livePricer.block_scholes_svi_source_timestamp_ms, "Block Scholes SVI"),
    };
    const upQuote = expiryMarketMoveCalls.MintQuote.parse(upBytes) as RawQuote;
    const downQuote = expiryMarketMoveCalls.MintQuote.parse(downBytes) as RawQuote;
    const up = economicsFromMintQuote(upQuote, "UP", payoutQuantity);
    const down = economicsFromMintQuote(downQuote, "DOWN", payoutQuantity);
    const quoteAge = Math.max(0, now() - completedAt);
    if (quoteAge > MAX_QUOTE_AGE_MS)
      return unavailable(request, "STALE_QUOTE", `Anonymous quotes are ${Math.ceil(quoteAge / 1_000)}s old; refresh before use.`, now());
    const referencePrice = rawToPrice(referenceTick * tickSizeRaw);
    const referenceAsOf = safeTimestamp(referenceTimestamp, "round reference");
    if (!Number.isFinite(referencePrice) || referencePrice <= 0)
      throw new Error("On-chain reference tick decoded to an invalid price.");
    return {
      status: "AVAILABLE", marketId: input.marketId, expiryMs: input.expiryMs,
      asOf: new Date(completedAt).toISOString(), ageMs: quoteAge,
      sizing: {
        mode: "PAYOUT_QUANTITY", requestedPayoutQuantity: payoutQuantity, totalSpendBudget: null,
        note: "Each side targets $5.00 of gross winning payout, not $5.00 total spend. Compare the quoted all-in costs below.",
      },
      referencePrice, referenceAsOf, oracleSourceTimes: oracleTimes,
      assumptions: [
        "Anonymous no-builder quote; it does not check a personal balance, account capacity, or account slippage settings.",
        "Quote is read-only and is not an executable fill or promise of execution.",
        "Winning/losing net results are before network gas and any other external costs.",
        "Subsidy reduces the trading fee once; the referral split is not an additional trader cost.",
      ],
      up, down, reason: null,
    };
  } catch (error) {
    const failedAt = now();
    const failure = quoteFailure(error);
    return unavailable(request, failure.status, failure.reason, failedAt);
  }
}
