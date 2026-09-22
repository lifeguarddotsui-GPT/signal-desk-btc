import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { campaigns, collectorCheckpoints, ledgerEntries, marketEvents, positions, workerLeases } from "../../shared/schema";

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

async function currentCampaign(ownerAddress: string) {
  try {
    const [campaign] = await db.select().from(campaigns)
      .where(eq(campaigns.ownerAddress, ownerAddress.toLowerCase()))
      .orderBy(desc(campaigns.updatedAt)).limit(1);
    return campaign ?? null;
  } catch {
    return null;
  }
}

export async function getAccumulationDashboard(ownerAddress: string) {
  const [price, campaign] = await Promise.all([fetchSuiUsdPrice(), currentCampaign(ownerAddress)]);
  let liquidMist: TruthfulValue<string> = unavailable("WALLET_BALANCE_UNAVAILABLE");
  let returnedMist: TruthfulValue<string> = unavailable("LEDGER_UNAVAILABLE");
  let liquidationMist: TruthfulValue<string> = unavailable("POSITION_MARKS_UNAVAILABLE");
  let positionRows: Awaited<ReturnType<typeof db.select>> extends never ? never[] : any[] = [];
  let ledgerRows: any[] = [];
  let walletAccountingAvailable = false;
  let paperMarkedMist: bigint | null = null;
  const marks = new Map<string, { mist: bigint; digest: string | null; checkpoint: string; asOf: Date }>();

  if (campaign) {
    try {
      const [ledger, openPositions, chainEvents] = await Promise.all([
        db.select().from(ledgerEntries).where(eq(ledgerEntries.campaignId, campaign.id)),
        db.select().from(positions).where(eq(positions.campaignId, campaign.id)),
        db.select().from(marketEvents).orderBy(desc(marketEvents.occurredAt)),
      ]);
      ledgerRows = ledger;
      positionRows = openPositions;
      walletAccountingAvailable = true;
      const returned = ledger.filter((entry) => entry.entryType === "OWNER_RETURN_CONFIRMED");
      // No quote is inferred for tokens. Positions are therefore explicitly
      // unavailable until a verified full-size exit quote exists.
      returnedMist = { value: sumBaseUnits(returned.map((entry) => entry.suiMist)), status: "available", asOf: new Date().toISOString() };
      liquidationMist = openPositions.filter(position => position.status === "OPEN").length === 0
        ? { value: "0", status: "available", asOf: new Date().toISOString() }
        : unavailable("NO_VERIFIED_FULL_SIZE_EXIT_QUOTES");
      let totalMarks = BigInt(0);
      let allMarked = true;
      for (const position of openPositions.filter((item) => item.status === "OPEN")) {
        const event = chainEvents.find((item) => item.assetId === position.assetId);
        const data = event?.payload as Record<string, unknown> | undefined;
        const sourceSui = typeof data?.sui_out === "string" ? data.sui_out
          : typeof data?.sui_in === "string" ? data.sui_in : null;
        const sourceTokens = typeof data?.tokens_in === "string" ? data.tokens_in
          : typeof data?.tokens_out === "string" ? data.tokens_out : null;
        if (!event || !sourceSui || !sourceTokens || !/^\d+$/.test(sourceSui) || !/^\d+$/.test(sourceTokens) || BigInt(sourceTokens) === BigInt(0)) {
          allMarked = false;
          continue;
        }
        const markMist = BigInt(position.unitsBase) * BigInt(sourceSui) / BigInt(sourceTokens);
        marks.set(position.assetId, { mist: markMist, digest: event.txDigest, checkpoint: event.checkpoint, asOf: event.occurredAt });
        totalMarks += markMist;
      }
      paperMarkedMist = allMarked ? totalMarks : null;
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
  const paperCashMist = ledgerRows.reduce((total, entry) => {
    if (entry.entryType === "PAPER_INITIAL_BALANCE" || entry.entryType === "PAPER_SELL_FILL") return total + BigInt(entry.suiMist);
    if (entry.entryType === "PAPER_BUY_FILL") return total - BigInt(entry.suiMist);
    return total;
  }, BigInt(0)).toString();
  const paperCashSui = walletAccountingAvailable
    ? mistToSui({ value: paperCashMist, status: "available", asOf: new Date().toISOString() })
    : null;
  const hasOpenPaperPositions = positionRows.some((position) => position.status === "OPEN");
  const paperEquitySui = walletAccountingAvailable && (!hasOpenPaperPositions || paperMarkedMist !== null)
    ? mistToSui({
        value: (BigInt(paperCashMist) + (paperMarkedMist ?? BigInt(0))).toString(),
        status: "available",
        asOf: new Date().toISOString(),
      })
    : null;
  return {
    mode: campaign?.status === "paused" ? "PAUSED" : campaign?.mode ?? "OBSERVE",
    network: campaign?.network ?? "mainnet",
    campaignId: campaign?.id ?? null,
    updatedAt: new Date().toISOString(),
    suiPriceUsd: price,
    liquidSui,
    paperEquitySui,
    paperCashSui,
    mainnetLiquidSui: null,
    mainnetLiquidationSui: null,
    mainnetRealizedPnlSui: null,
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
      shadowMarkSui: marks.has(position.assetId)
        ? mistToSui({ value: marks.get(position.assetId)!.mist.toString(), status: "available", asOf: marks.get(position.assetId)!.asOf.toISOString() })
        : null,
      markEvidence: marks.has(position.assetId) ? {
        referenceDigest: marks.get(position.assetId)!.digest,
        checkpoint: marks.get(position.assetId)!.checkpoint,
        executableQuote: false,
      } : null,
      updatedAt: position.updatedAt.toISOString(),
    })),
    recentTransactions: ledgerRows.slice(-20).reverse().map(entry => ({
      id: entry.id,
      type: entry.entryType,
      amount: mistToSui({ value: entry.suiMist, status: "available", asOf: entry.createdAt.toISOString() }),
      status: "RECORDED",
      assetId: entry.assetId,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
      createdAt: entry.createdAt.toISOString(),
    })),
    decisionStatus: hasOpenPaperPositions
      ? "Paper shadow positions are tracking real SUI Pump trade events. Marks are hypothetical and are not executable quotes."
      : "Holding virtual SUI while the forward event replay waits for a qualifying second trade.",
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
      connectedAddress: ownerAddress,
      configured: false,
      signerConfigured: false,
    },
    decision: {
      action: hasOpenPaperPositions ? "TRACK_PAPER_POSITIONS" : "HOLD_SUI",
      reason: hasOpenPaperPositions
        ? "Open Paper positions are marked from the latest real SUI Pump transaction evidence."
        : "No forward-ordered Paper entry is available yet.",
    },
  };
}

export async function getAccumulationOperations() {
  let worker: TruthfulValue<{ workerName: string; expiresAt: string }> = unavailable("WORKER_HEARTBEAT_UNAVAILABLE");
  let collector: Record<string, unknown> = { status: "BLOCKED", reason: "No verified Suipump collector is running." };
  let persistedMode = process.env.ACCUMULATION_MODE ?? "OBSERVE";
  try {
    const [lease] = await db.select().from(workerLeases).orderBy(desc(workerLeases.renewedAt)).limit(1);
    if (lease && lease.expiresAt.getTime() > Date.now()) worker = {
      value: { workerName: lease.workerName, expiresAt: lease.expiresAt.toISOString() },
      status: "available",
      asOf: lease.renewedAt.toISOString(),
    };
  } catch {}
  try {
    const [campaign] = await db.select().from(campaigns).orderBy(desc(campaigns.updatedAt)).limit(1);
    if (campaign) persistedMode = campaign.status === "paused" ? "PAUSED" : campaign.mode;
  } catch {}
  try {
    const [state] = await db.select().from(collectorCheckpoints)
      .orderBy(desc(collectorCheckpoints.updatedAt)).limit(1);
    if (state?.lastSuccessAt) {
      const fresh = Date.now() - state.lastSuccessAt.getTime() < 2 * 60_000;
      collector = {
        status: fresh && state.status === "RUNNING" ? "HEALTHY" : "DEGRADED",
        source: state.source,
        lastCheckpoint: state.lastCheckpoint,
        providerEventCount: state.providerEventCount,
        collectedObservationCount: state.collectedObservationCount,
        verifiedAssetCount: state.verifiedAssetCount,
        uptimeSeconds: Math.max(0, Math.floor((Date.now() - state.startedAt.getTime()) / 1000)),
        lastSuccessAt: state.lastSuccessAt.toISOString(),
        reason: fresh && state.status === "RUNNING" ? null : (state.lastError || "Collector is degraded or stale."),
      };
    }
  } catch {}
  return {
    mode: persistedMode,
    chain: "Sui",
    network: "mainnet",
    collector,
    worker,
    replay: { status: "BLOCKED", reason: "Durable checkpoint replay is not implemented." },
    gasReserveMist: unavailable("GAS_RESERVE_UNAVAILABLE"),
    reconciliation: unavailable("RECONCILIATION_UNAVAILABLE"),
    policyVersion: unavailable("POLICY_VERSION_UNAVAILABLE"),
    intelligence: unavailable("RESEARCH_EXPIRY_UNAVAILABLE"),
    costs: unavailable("OPERATING_COSTS_UNAVAILABLE"),
    signer: { status: "BLOCKED", configured: false, reason: "Signer access is intentionally disabled in Observe/Paper MVP." },
    blockers: [
      "The currently published deployment remains Autoscale until the pending VM configuration is republished.",
      "Suipump defining-package lineage, raw event types, and executable routes are not fully verified.",
      "Signer, wallet, and owner withdrawal proof are not configured.",
      "Fourteen days of launch and trade coverage have not been collected.",
    ],
  };
}