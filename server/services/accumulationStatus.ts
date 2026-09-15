import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { campaigns, ledgerEntries, positions, workerLeases } from "../../shared/schema";

export interface UnavailableValue {
  value: null;
  status: "unavailable";
  reason: string;
}

export type TruthfulValue<T> = { value: T; status: "available"; asOf: string } | UnavailableValue;

function unavailable(reason: string): UnavailableValue {
  return { value: null, status: "unavailable", reason };
}

async function fetchSuiUsdPrice(): Promise<TruthfulValue<number>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch("https://api.exchange.coinbase.com/products/SUI-USD/ticker", {
      headers: { accept: "application/json", "user-agent": "BlueWaterAccumulation/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) return unavailable(`SUI_PRICE_PROVIDER_HTTP_${response.status}`);
    const payload = await response.json() as { price?: unknown };
    const price = typeof payload.price === "string" ? Number(payload.price) : payload.price;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return unavailable("SUI_PRICE_PROVIDER_INVALID");
    return { value: price, status: "available", asOf: new Date().toISOString() };
  } catch (error) {
    return unavailable(error instanceof Error ? `SUI_PRICE_UNAVAILABLE: ${error.message}` : "SUI_PRICE_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
  }
}

function sumBaseUnits(values: readonly (string | null | undefined)[]): string {
  return values.reduce((total, value) => total + BigInt(value ?? "0"), BigInt(0)).toString();
}

async function currentCampaign() {
  try {
    const [campaign] = await db.select().from(campaigns).orderBy(desc(campaigns.updatedAt)).limit(1);
    return campaign ?? null;
  } catch {
    return null;
  }
}

export async function getAccumulationDashboard() {
  const [price, campaign] = await Promise.all([fetchSuiUsdPrice(), currentCampaign()]);
  let liquidMist: TruthfulValue<string> = unavailable("WALLET_BALANCE_UNAVAILABLE");
  let returnedMist: TruthfulValue<string> = unavailable("LEDGER_UNAVAILABLE");
  let liquidationMist: TruthfulValue<string> = unavailable("POSITION_MARKS_UNAVAILABLE");
  let positionRows: Awaited<ReturnType<typeof db.select>> extends never ? never[] : any[] = [];
  let ledgerRows: any[] = [];

  if (campaign) {
    try {
      const [ledger, openPositions] = await Promise.all([
        db.select().from(ledgerEntries).where(eq(ledgerEntries.campaignId, campaign.id)),
        db.select().from(positions).where(eq(positions.campaignId, campaign.id)),
      ]);
      ledgerRows = ledger;
      positionRows = openPositions;
      const returned = ledger.filter((entry) => entry.entryType === "OWNER_RETURN_CONFIRMED");
      // No quote is inferred for tokens. Positions are therefore explicitly
      // unavailable until a verified full-size exit quote exists.
      returnedMist = { value: sumBaseUnits(returned.map((entry) => entry.suiMist)), status: "available", asOf: new Date().toISOString() };
      liquidationMist = openPositions.filter(position => position.status === "OPEN").length === 0
        ? { value: "0", status: "available", asOf: new Date().toISOString() }
        : unavailable("NO_VERIFIED_FULL_SIZE_EXIT_QUOTES");
    } catch {
      // Keep explicit unavailable values rather than turning a DB failure into zero.
    }
  }

  const blockers = [
    "Suipump package lineage and executable functions are not verified.",
    "Agent wallet and isolated signer are not configured.",
    "No durable launch collector or replay cursor is running.",
    "No campaign deposit has been registered.",
  ];
  const mistToSui = (amount: TruthfulValue<string>): string | null => {
    if (amount.status !== "available") return null;
    const scalar = BigInt(1_000_000_000);
    const units = BigInt(amount.value);
    return `${units / scalar}.${(units % scalar).toString().padStart(9, "0")}`;
  };
  const liquidSui = mistToSui(liquidMist);
  const returnedSui = mistToSui(returnedMist);
  const estimatedLiquidationSui = mistToSui(liquidationMist);
  return {
    mode: campaign?.status === "paused" ? "PAUSED" : campaign?.mode ?? "OBSERVE",
    network: campaign?.network ?? "mainnet",
    campaignId: campaign?.id ?? null,
    updatedAt: new Date().toISOString(),
    suiPriceUsd: price,
    liquidSui,
    gasReserveSui: null,
    estimatedLiquidationSui,
    realizedNetProfitSui: null,
    returnedSui,
    campaignDepositSui: null,
    campaignTargetSui: "100.000000000",
    estimatedCampaignValueSui: null,
    positions: positionRows.map(position => ({
      id: position.id,
      assetId: position.assetId,
      unitsBase: position.unitsBase,
      costSui: mistToSui({ value: position.costMist, status: "available", asOf: position.updatedAt.toISOString() }),
      realizedSui: mistToSui({ value: position.realizedMist, status: "available", asOf: position.updatedAt.toISOString() }),
      status: position.status,
      updatedAt: position.updatedAt.toISOString(),
    })),
    recentTransactions: ledgerRows.slice(-20).reverse().map(entry => ({
      id: entry.id,
      type: entry.entryType,
      amount: mistToSui({ value: entry.suiMist, status: "available", asOf: entry.createdAt.toISOString() }),
      status: "RECORDED",
      createdAt: entry.createdAt.toISOString(),
    })),
    decisionStatus: "Holding SUI: no token has complete, verified entry and exit evidence.",
    blockers,
    liquidSuiMist: unavailable("CHAIN_BALANCE_RECONCILIATION_UNAVAILABLE"),
    estimatedTokenLiquidationMist: liquidationMist,
    realizedNetTradingProfitMist: unavailable("REALIZED_PROFIT_UNAVAILABLE"),
    suiReturnedMist: returnedMist,
    accounting: {
      definition: "liquid SUI + conservative liquidation value + confirmed returns - campaign deposits",
      amountsAreBaseUnitStrings: true,
    },
    wallet: {
      configured: Boolean(process.env.SUI_AGENT_ADDRESS),
      signerConfigured: false,
    },
    decision: {
      action: "HOLD_SUI",
      reason: "Observe mode is the default; no live trade is eligible from this service.",
    },
  };
}

export async function getAccumulationOperations() {
  let worker: TruthfulValue<{ workerName: string; expiresAt: string }> = unavailable("WORKER_HEARTBEAT_UNAVAILABLE");
  try {
    const [lease] = await db.select().from(workerLeases).orderBy(desc(workerLeases.renewedAt)).limit(1);
    if (lease && lease.expiresAt.getTime() > Date.now()) worker = {
      value: { workerName: lease.workerName, expiresAt: lease.expiresAt.toISOString() },
      status: "available",
      asOf: lease.renewedAt.toISOString(),
    };
  } catch {}
  return {
    mode: process.env.ACCUMULATION_MODE ?? "OBSERVE",
    chain: "Sui",
    network: "mainnet",
    collector: { status: "BLOCKED", reason: "No verified Suipump collector is running." },
    worker,
    replay: { status: "BLOCKED", reason: "Durable checkpoint replay is not implemented." },
    gasReserveMist: unavailable("GAS_RESERVE_UNAVAILABLE"),
    reconciliation: unavailable("RECONCILIATION_UNAVAILABLE"),
    policyVersion: unavailable("POLICY_VERSION_UNAVAILABLE"),
    intelligence: unavailable("RESEARCH_EXPIRY_UNAVAILABLE"),
    costs: unavailable("OPERATING_COSTS_UNAVAILABLE"),
    signer: { status: "BLOCKED", configured: false, reason: "Signer access is intentionally disabled in Observe/Paper MVP." },
    blockers: [
      "Always-on trading worker is not deployed.",
      "Suipump package and event lineage are not verified.",
      "Signer, wallet, and owner withdrawal proof are not configured.",
      "Fourteen days of launch and trade coverage have not been collected.",
    ],
  };
}