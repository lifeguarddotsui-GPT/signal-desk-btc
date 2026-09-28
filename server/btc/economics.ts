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
export const MAX_SOURCE_TIMESTAMP_AGE_MS = 20_000;
const MAX_SOURCE_CLOCK_SKEW_MS = 2_000;
const POSITION_LOT_RAW = BigInt(readContext.predictConfig.units.positionLotSize);
const IDENTITY = /^0x[0-9a-f]{64}$/i;
const QUOTE_SOURCE = "DeepBook expiry_market::quote_mint (anonymous read-only devInspect; @mysten/deepbook-v3 2.6.3)";

export type QuoteStatus =
  | "AVAILABLE" | "PARTIAL" | "TOO_LATE" | "EXPIRED" | "ROUND_MISMATCH"
  | "PAUSED_MARKET" | "MISSING_REFERENCE" | "STALE_QUOTE"
  | "PROVIDER_ERROR" | "ONCHAIN_REJECTED" | "INVALID_REQUEST" | "ADAPTER_ERROR";

export type OutcomeEconomics = {
  status: "AVAILABLE" | "UNAVAILABLE";
  side: "UP" | "DOWN";
  source: string;
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
  technicalDetail: string | null;
};

export type QuoteErrorDetail = {
  status: QuoteStatus;
  reason: string;
  technicalDetail: string;
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
  upError: QuoteErrorDetail | null;
  downError: QuoteErrorDetail | null;
  reason: string | null;
  technicalDetail: string | null;
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
  technicalDetail: string | null = null,
): RoundEconomics {
  return {
    status, marketId: input.marketId, expiryMs: input.expiryMs,
    asOf: new Date(now).toISOString(), ageMs: 0,
    sizing: { mode: "PAYOUT_QUANTITY", requestedPayoutQuantity: input.payoutQuantity,
      totalSpendBudget: null,
      note: "Quantity is the gross winning payout target, not a spend budget. All-in cost is quoted separately." },
    referencePrice: null, referenceAsOf: null, oracleSourceTimes: null,
    assumptions: ["No quote is executable or account-specific.", "Network/gas costs are not included."],
    up: null, down: null, upError: null, downError: null, reason, technicalDetail,
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
    source: QUOTE_SOURCE,
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
    reason: null, technicalDetail: null,
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
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Read-only quote has an out-of-range ${field} source timestamp.`);
  return date.toISOString();
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

export function classifyQuoteFailure(error: unknown, onChainFailure = false): {
  status: QuoteStatus; reason: string; technicalDetail: string;
} {
  const text = errorText(error);
  const lower = text.toLowerCase();
  const technicalDetail = text.slice(0, 500) || "Unknown quote failure.";
  if (/pause|mint_paused|market_paused/i.test(lower))
    return { status: "PAUSED_MARKET", reason: "This market is paused for new entries.", technicalDetail };
  if (/expired|expiry.{0,20}(window|closed)|no.?trade|entry window|trade window|too late/i.test(lower))
    return { status: "TOO_LATE", reason: "The entry window has closed for this round.", technicalDetail };
  if (/stale|source timestamp|oracle.{0,24}(unavailable|outdated)|pricing input.{0,24}unavailable/i.test(lower))
    return {
      status: "STALE_QUOTE",
      reason: /source timestamp|freshness/i.test(lower)
        ? "Source freshness could not be verified; no quote is shown."
        : "A pricing input is stale or unavailable; no quote is shown.",
      technicalDetail,
    };
  if (/timeout|timed out|aborted|network|fetch failed|connection|429|too many requests|provider unavailable|service unavailable/i.test(lower))
    return { status: "PROVIDER_ERROR", reason: "Quote service is temporarily unavailable; try again shortly.", technicalDetail };
  if (onChainFailure)
    return { status: "ONCHAIN_REJECTED", reason: "The market could not admit this quote right now.", technicalDetail };
  return { status: "ADAPTER_ERROR", reason: "Quote data could not be verified; no economics are shown.", technicalDetail };
}

export type SourceFreshness = {
  fresh: boolean;
  reason: string | null;
  technicalDetail: string | null;
};

/**
 * The BTC feed treats 20-second-old source observations as stale and allows
 * at most 2 seconds of future clock skew. Apply the same conservative limits
 * to every timestamp that backs a displayed quote, not merely devInspect age.
 */
export function validateQuoteSourceFreshness(
  oracleTimes: RoundEconomics["oracleSourceTimes"],
  referenceAsOf: string | null,
  atMs: number,
): SourceFreshness {
  const fail = (message: string, technicalDetail: string): SourceFreshness => ({
    fresh: false, reason: message, technicalDetail,
  });
  const check = (label: string, value: string | null, required: boolean): SourceFreshness | null => {
    if (value === null && !required) return null;
    if (typeof value !== "string" || value.length === 0)
      return fail("Source freshness could not be verified; no quote is shown.", `${label} source timestamp is missing.`);
    const sourceMs = Date.parse(value);
    if (!Number.isFinite(sourceMs))
      return fail("Source freshness could not be verified; no quote is shown.", `${label} source timestamp is malformed.`);
    const ageMs = atMs - sourceMs;
    if (ageMs < -MAX_SOURCE_CLOCK_SKEW_MS)
      return fail("Source freshness could not be verified; no quote is shown.",
        `${label} source timestamp is ${Math.abs(ageMs)}ms in the future.`);
    if (ageMs > MAX_SOURCE_TIMESTAMP_AGE_MS)
      return fail("A required pricing source is stale; no quote is shown.",
        `${label} source timestamp is ${ageMs}ms old (maximum ${MAX_SOURCE_TIMESTAMP_AGE_MS}ms).`);
    return null;
  };
  if (!Number.isFinite(atMs))
    return fail("Source freshness could not be verified; no quote is shown.", "Quote verification time is invalid.");
  if (!oracleTimes)
    return fail("Source freshness could not be verified; no quote is shown.", "Oracle source timestamps are missing.");
  const timestamps: Array<[string, string | null, boolean]> = [
    ["reference", referenceAsOf, true],
    ["Pyth spot", oracleTimes.pythSpot, false],
    ["Block Scholes spot", oracleTimes.blockScholesSpot, true],
    ["Block Scholes forward", oracleTimes.blockScholesForward, true],
    ["Block Scholes SVI", oracleTimes.blockScholesSvi, true],
  ];
  for (const [label, timestamp, required] of timestamps) {
    const failure = check(label, timestamp, required);
    if (failure) return failure;
  }
  return { fresh: true, reason: null, technicalDetail: null };
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
  if (typeof input.marketId !== "string" || !IDENTITY.test(input.marketId) ||
      !Number.isSafeInteger(input.expiryMs) || input.expiryMs <= 0 ||
      !Number.isFinite(new Date(input.expiryMs).getTime()))
    return unavailable(request, "INVALID_REQUEST", "The market ID or round expiry is invalid.");
  if (typeof payoutQuantity !== "number" || !Number.isFinite(payoutQuantity) || payoutQuantity <= 0)
    return unavailable(request, "INVALID_REQUEST", "Enter a positive, valid payout quantity.");
  let requestedRaw: bigint;
  try {
    requestedRaw = usdcToRaw(payoutQuantity);
  } catch {
    return unavailable(request, "INVALID_REQUEST", "Payout quantity must be a valid USDC amount.");
  }
  if (requestedRaw <= BigInt(0) || requestedRaw % POSITION_LOT_RAW !== BigInt(0))
    return unavailable(request, "INVALID_REQUEST",
      `Payout quantity must align to the ${rawToUsdc(POSITION_LOT_RAW)} USDC position lot.`);
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
      const failure = classifyQuoteFailure(stateResult.FailedTransaction?.status?.error ?? "Market state read failed.", true);
      return unavailable(request, failure.status, failure.reason, now(), failure.technicalDetail);
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
        referenceTick >= POS_INF_TICK)
      return unavailable(request, "MISSING_REFERENCE", "The active market has no valid on-chain reference tick yet.", stateReadAt);
    if (referenceTimestamp === BigInt(0))
      return unavailable(request, "STALE_QUOTE", "Source freshness could not be verified; no quote is shown.",
        stateReadAt, "Round reference source timestamp is missing.");
    const referenceAsOf = safeTimestamp(referenceTimestamp, "round reference");
    if (input.expiryMs - stateReadAt <= MANUAL_TIME_BUDGET_MS)
      return unavailable(request, "TOO_LATE", "Entry window closed while validating on-chain market state.", stateReadAt);

    const btc = predictConfig.underlyings.BTC;
    if (!btc) throw new Error("Installed mainnet SDK has no configured BTC oracle feeds.");
    type SideRead = { side: "UP" | "DOWN"; quote: OutcomeEconomics | null; failed: QuoteErrorDetail | null; completedAt: number; oracleTimes: RoundEconomics["oracleSourceTimes"] };
    const readSide = async (side: "UP" | "DOWN"): Promise<SideRead> => {
      const sideNow = now;
      try {
        const tx = new Transaction();
        const pricer = tx.add(expiryMarketMoveCalls.loadLivePricer({
          config: callConfig,
          arguments: {
            market: input.marketId, pyth: btc.pythFeed,
            bsValues: btc.blockScholesValueStore, bsSvi: btc.blockScholesSviStore,
          },
        }));
        const upSide = side === "UP";
        tx.add(expiryMarketMoveCalls.quoteMint({
          config: callConfig,
          arguments: {
            market: input.marketId, pricer,
            lowerTick: upSide ? referenceTick! : BigInt(0),
            higherTick: upSide ? POS_INF_TICK : referenceTick!,
            maxPremium: U64_MAX,
            minQuantity: requestedRaw,
            exactQuantity: true,
          },
        }));
        tx.setSender("0x0");
        const result = await client.core.simulateTransaction({
          transaction: tx, checksEnabled: false, include: { commandResults: true },
        });
        const completedAt = sideNow();
        if (result.$kind === "FailedTransaction") {
          const failure = classifyQuoteFailure(result.FailedTransaction?.status?.error ?? "Mint quote was rejected.", true);
          return { side, quote: null, failed: failure, completedAt, oracleTimes: null };
        }
        const commands = result.commandResults;
        if (!commands || commands.length < 2)
          throw new Error("Quote simulation returned incomplete command results.");
        const pricerBytes = commands[0].returnValues?.[0]?.bcs;
        const quoteBytes = commands[1].returnValues?.[0]?.bcs;
        if (!pricerBytes || !quoteBytes)
          throw new Error("Quote simulation omitted a pricer or MintQuote BCS return value.");
        const livePricer = pricingMoveCalls.Pricer.parse(pricerBytes);
        const pythSpotMs = Number(livePricer.pyth_spot_source_timestamp_ms);
        const oracleTimes = {
          pythSpot: pythSpotMs > 0 ? safeTimestamp(livePricer.pyth_spot_source_timestamp_ms, "Pyth spot") : null,
          blockScholesSpot: safeTimestamp(livePricer.block_scholes_spot_source_timestamp_ms, "Block Scholes spot"),
          blockScholesForward: safeTimestamp(livePricer.block_scholes_forward_source_timestamp_ms, "Block Scholes forward"),
          blockScholesSvi: safeTimestamp(livePricer.block_scholes_svi_source_timestamp_ms, "Block Scholes SVI"),
        };
        const sourceFreshness = validateQuoteSourceFreshness(oracleTimes, referenceAsOf, completedAt);
        if (!sourceFreshness.fresh)
          return {
            side, quote: null,
            failed: {
              status: "STALE_QUOTE",
              reason: sourceFreshness.reason!,
              technicalDetail: sourceFreshness.technicalDetail!,
            },
            completedAt, oracleTimes,
          };
        const parsed = expiryMarketMoveCalls.MintQuote.parse(quoteBytes) as RawQuote;
        if (completedAt - stateReadAt > MAX_QUOTE_AGE_MS)
          return {
            side, quote: null,
            failed: { status: "STALE_QUOTE", reason: "The quote took too long to complete; refresh before use.",
              technicalDetail: `Side simulation completed ${completedAt - stateReadAt}ms after market state was read.` },
            completedAt, oracleTimes,
          };
        return { side, quote: economicsFromMintQuote(parsed, side, payoutQuantity), failed: null, completedAt, oracleTimes };
      } catch (error) {
        const failure = classifyQuoteFailure(error);
        return { side, quote: null, failed: failure, completedAt: now(), oracleTimes: null };
      }
    };
    const [upRead, downRead] = await Promise.all([readSide("UP"), readSide("DOWN")]);
    const completedAt = Math.max(upRead.completedAt, downRead.completedAt);
    if (completedAt >= input.expiryMs)
      return unavailable(request, "EXPIRED", "Round expired before the anonymous quotes completed.", completedAt);
    const reads = [upRead, downRead];
    const quoteCheckedAt = now();
    for (const read of reads) {
      const sideAge = quoteCheckedAt - read.completedAt;
      if (read.quote && sideAge > MAX_QUOTE_AGE_MS) {
        read.quote = null;
        read.failed = { status: "STALE_QUOTE", reason: "This quote has aged out; refresh before use.",
          technicalDetail: `Quote age ${Math.max(0, sideAge)}ms exceeds ${MAX_QUOTE_AGE_MS}ms.` };
      } else if (read.quote) {
        const freshness = validateQuoteSourceFreshness(read.oracleTimes, referenceAsOf, quoteCheckedAt);
        if (!freshness.fresh) {
          read.quote = null;
          read.failed = {
            status: "STALE_QUOTE",
            reason: freshness.reason!,
            technicalDetail: freshness.technicalDetail!,
          };
        }
      }
    }
    const currentSuccessful = reads.filter((read): read is SideRead & { quote: OutcomeEconomics } => read.quote !== null);
    const currentFailed = reads.filter((read): read is SideRead & { failed: QuoteErrorDetail } => read.failed !== null);
    const up = upRead.quote;
    const down = downRead.quote;
    const upError = upRead.failed;
    const downError = downRead.failed;
    const oldestQuoteAt = currentSuccessful.length
      ? Math.min(...currentSuccessful.map(read => read.completedAt)) : completedAt;
    const currentAge = currentSuccessful.length
      ? Math.max(0, now() - Math.min(...currentSuccessful.map(read => read.completedAt))) : 0;
    const referencePrice = rawToPrice(referenceTick * tickSizeRaw);
    if (!Number.isFinite(referencePrice) || referencePrice <= 0)
      throw new Error("On-chain reference tick decoded to an invalid price.");
    const oracleTimes = (currentSuccessful[0] ?? reads.find(read => read.oracleTimes !== null))?.oracleTimes ?? null;
    const bothAvailable = up !== null && down !== null;
    const anyAvailable = up !== null || down !== null;
    const aggregateReason = bothAvailable ? null : anyAvailable
      ? `${up ? "DOWN" : "UP"} quote unavailable; the other side is independently available.`
      : "Quotes are currently unavailable for both sides.";
    const aggregateStatus: QuoteStatus = bothAvailable ? "AVAILABLE" : anyAvailable ? "PARTIAL"
      : currentFailed.some(read => read.failed.status === "ADAPTER_ERROR") ? "ADAPTER_ERROR"
      : currentFailed.some(read => read.failed.status === "PROVIDER_ERROR") ? "PROVIDER_ERROR"
      : currentFailed.some(read => read.failed.status === "STALE_QUOTE") ? "STALE_QUOTE"
      : currentFailed.some(read => read.failed.status === "TOO_LATE") ? "TOO_LATE"
      : currentFailed.some(read => read.failed.status === "PAUSED_MARKET") ? "PAUSED_MARKET"
      : "ONCHAIN_REJECTED";
    const technicalDetail = currentFailed.length
      ? currentFailed.map(read => `${read.side}: ${read.failed.technicalDetail}`).join(" | ").slice(0, 1_000)
      : null;
    return {
      status: aggregateStatus, marketId: input.marketId, expiryMs: input.expiryMs,
      asOf: new Date(oldestQuoteAt).toISOString(), ageMs: currentAge,
      sizing: {
        mode: "PAYOUT_QUANTITY", requestedPayoutQuantity: payoutQuantity, totalSpendBudget: null,
        note: `Each side targets $${payoutQuantity.toFixed(2)} of gross winning payout, not the same amount of total spend. Compare quoted all-in costs.`,
      },
      referencePrice, referenceAsOf, oracleSourceTimes: oracleTimes,
      assumptions: [
        "Anonymous no-builder quote; it does not check a personal balance, account capacity, or account slippage settings.",
        "Quote is read-only and is not an executable fill or promise of execution.",
        "Winning/losing net results are before network gas and any other external costs.",
        "Subsidy reduces the trading fee once; the referral split is not an additional trader cost.",
      ],
      up, down, upError, downError, reason: aggregateReason, technicalDetail,
    };
  } catch (error) {
    const failedAt = now();
    const failure = classifyQuoteFailure(error);
    return unavailable(request, failure.status, failure.reason, failedAt, failure.technicalDetail);
  }
}
