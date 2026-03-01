import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import type { DexAdapter, DexOrderParams, DexCloseParams, DexOrderResult, DexPositionInfo, DexBalanceInfo, DexFeeEstimate } from "./types";
import { decryptKeypair } from "./wallet-manager";
import { withWalletLock } from "./tx-queue";
import { signAndExecuteSafe } from "./safe-execute";
import { SuiPythClient, SuiPriceServiceConnection } from "@pythnetwork/pyth-sui-js";

const SUI_RPC = "https://fullnode.mainnet.sui.io:443";

const PYTH_HERMES_URL = "https://hermes.pyth.network";
const PYTH_SUI_FEED_ID = "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744";

const PERP_TRADING_PACKAGE = "0x9003219180252ae6b81d2893b41d430488669027219537236675c0c2924c94d9";
const PERP_MATCH_PACKAGE = "0xf60e3542f1c65a77d9bcdffd5d8a712a46b935ec51b9052e5ad98888e0392d09";
const PERP_VERSION = "0x7c30204bd3f4dc37918281907308e0d7d09a75a6826473aec0caa1712ee149e5";
const MARKET_REGISTRY = "0x327c8a176055400e9aacde8553a897898b5da969d6dcdb55eee268bb501a2c3a";
const LP_POOL_REGISTRY = "0x46ef530d3ad13037ac54b77be324e5ab063124af8a119e86f1f59be8a16a22a2";
const TYPUS_PERP_CONFIG = "0xd24222307ba17ee1a08fe46ac587b1106e585e53f314ffffb525a4d4158b64c3";
const SUI_COIN_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

const TYPUS_ORACLE_PACKAGE = "0xfc9b05223195de2f134c84c2299c5ff3f2b51725b8ba821f46975da1264ace73";
const TYPUS_ORACLE_SUI = "0x0a318f26fcf35922a8671a2d843872a7a25ac10b678bdee52f10fbc77140c0d0";
const CLOCK_ID = "0x6";

const PYTH_STATE_ID = "0x1f9310238ee9298fb703c3419030b35b22bb1cc37113e3bb5007c99aec79e5b8";
const WORMHOLE_STATE_ID = "0xaeab97f96cf9877fee2883315d459552b2b921edc16d7ceac6eab944dd88919c";
const PYTH_SUI_USD_PRICE_INFO_OBJECT = "0x801dbc2f0053d34734814b2d6df491ce7807a725fe9a01ad74a07e9c51396c37";

const SUI_LP_VAULTS = [
  "0xd2882b992e986250b3304b59530700bc3850939f9a77e9e9dfa9cf1656f84b3d",
  "0xb1b16eb4845b5ee1a29432b1f2bcfe8cbb33c234492baf31a706d82e28e18bce",
  "0xc515a3e7fd12ba902f7f1ebe52c676136e1b34cb614ae9c79a46b257ca7d5534",
  "0xeca3e88577dc3f45df8b7bace51f26b126271ce4c5fa33b3739fd7b69fc16559",
  "0xe896530a778adedc1b38e4fc31059a6557146caa7b1da56950b671a433de5f08",
];

const SUI_MARKET_INDEX = 0;
const SUI_POOL_INDEX = 0;

const MIST_PER_SUI = 1_000_000_000;
const TYPUS_ORACLE_DECIMALS = 8;
const GAS_BUDGET_MIST = 30_000_000;
const MATCH_GAS_BUDGET_MIST = 50_000_000;
const COMBINED_CREATE_MATCH_GAS_MIST = 50_000_000;
const BASE_GAS_RESERVE_SUI = 0.03;
const GAS_PER_CLOSE_SUI = 0.015;
const SLIPPAGE_BPS_LONG = BigInt(500);
const SLIPPAGE_BPS_SHORT = BigInt(1000);
const BPS_BASE = BigInt(10000);

const SUI_PERP_MIN_SIZE_UNITS = BigInt("10000000000");

function suiToMist(sui: number): bigint {
  return BigInt(Math.floor(sui * MIST_PER_SUI));
}

function toSizeUnits(quantity: number): bigint {
  return BigInt(Math.floor(quantity * Math.pow(10, 9)));
}

function toOraclePriceUnits(price: number): bigint {
  return BigInt(Math.round(price * Math.pow(10, TYPUS_ORACLE_DECIMALS)));
}

function applySlippage(price: bigint, isLong: boolean): bigint {
  const bps = isLong ? SLIPPAGE_BPS_LONG : SLIPPAGE_BPS_SHORT;
  return isLong
    ? (price * (BPS_BASE + bps)) / BPS_BASE
    : (price * (BPS_BASE - bps)) / BPS_BASE;
}

interface PythOraclePrice {
  price: number;
  conf: number;
  expo: number;
  publishTime: number;
}

let pythClientInstance: any = null;
let priceConnectionInstance: any = null;

function getPythClient(): any {
  if (!pythClientInstance) {
    const { SuiClient: PythSuiClient } = require("@pythnetwork/pyth-sui-js/node_modules/@mysten/sui/client");
    const suiClient = new PythSuiClient({ url: SUI_RPC });
    pythClientInstance = new SuiPythClient(suiClient as any, PYTH_STATE_ID, WORMHOLE_STATE_ID);
  }
  return pythClientInstance;
}

function getPriceConnection(): SuiPriceServiceConnection {
  if (!priceConnectionInstance) {
    priceConnectionInstance = new SuiPriceServiceConnection(PYTH_HERMES_URL);
  }
  return priceConnectionInstance;
}

export class TypusAdapter implements DexAdapter {
  readonly venue = "typus";
  readonly supported = true;
  readonly description = "Typus Perps - On-chain perpetual trading on SUI with Pyth oracle pricing and up to 50x leverage";
  private client: SuiJsonRpcClient;

  private consecutiveFailures = new Map<string, { count: number; lastError: string; trippedAt: number | null }>();
  private static readonly CIRCUIT_BREAKER_THRESHOLD = 3;
  private static readonly CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

  isReady(): boolean {
    return true;
  }

  constructor() {
    this.client = new SuiJsonRpcClient({ url: SUI_RPC, network: "mainnet" });
  }

  private async fetchPythOraclePrice(): Promise<PythOraclePrice> {
    const url = `${PYTH_HERMES_URL}/v2/updates/price/latest?ids[]=${encodeURIComponent(PYTH_SUI_FEED_ID)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      throw new Error(`Pyth Hermes API returned ${response.status}: ${response.statusText}`);
    }
    const json = await response.json();
    const parsed = json?.parsed?.[0]?.price;
    if (!parsed) {
      throw new Error("Pyth oracle returned no price data for SUI/USD");
    }
    const price = Number(parsed.price) * Math.pow(10, Number(parsed.expo));
    if (!price || price <= 0) {
      throw new Error(`Pyth oracle returned invalid price: ${price}`);
    }
    return {
      price,
      conf: parsed.conf ? Number(parsed.conf) * Math.pow(10, Number(parsed.expo)) : 0,
      expo: Number(parsed.expo),
      publishTime: Number(parsed.publish_time),
    };
  }

  private async addSuiOracleUpdateToTx(tx: Transaction): Promise<void> {
    const connection = getPriceConnection();
    const pythClient = getPythClient();

    const updateData = await connection.getPriceFeedsUpdateData([PYTH_SUI_FEED_ID]);
    if (!updateData || updateData.length === 0) {
      throw new Error("Failed to fetch Pyth price update data for SUI from Hermes");
    }

    await pythClient.updatePriceFeeds(tx as any, updateData, [PYTH_SUI_FEED_ID]);

    tx.moveCall({
      target: `${TYPUS_ORACLE_PACKAGE}::oracle::update_with_pyth_usd`,
      typeArguments: [],
      arguments: [
        tx.object(TYPUS_ORACLE_SUI),
        tx.object(PYTH_STATE_ID),
        tx.object(PYTH_SUI_USD_PRICE_INFO_OBJECT),
        tx.object(CLOCK_ID),
      ],
    });

    console.log(`[TypusAdapter] SUI oracle updated via Pyth`);
  }

  getCircuitBreakerStatus(agentId: string): { tripped: boolean; count: number; lastError: string; cooldownRemaining: number } {
    const record = this.consecutiveFailures.get(agentId);
    if (!record) return { tripped: false, count: 0, lastError: "", cooldownRemaining: 0 };
    const tripped = record.count >= TypusAdapter.CIRCUIT_BREAKER_THRESHOLD;
    let cooldownRemaining = 0;
    if (tripped && record.trippedAt) {
      const elapsed = Date.now() - record.trippedAt;
      cooldownRemaining = Math.max(0, Math.ceil((TypusAdapter.CIRCUIT_BREAKER_COOLDOWN_MS - elapsed) / 1000));
    }
    return { tripped, count: record.count, lastError: record.lastError, cooldownRemaining };
  }

  resetCircuitBreaker(agentId: string): void {
    this.consecutiveFailures.delete(agentId);
  }

  private recordFailure(agentId: string, error: string): void {
    const record = this.consecutiveFailures.get(agentId) || { count: 0, lastError: "", trippedAt: null };
    record.count += 1;
    record.lastError = error;
    if (record.count >= TypusAdapter.CIRCUIT_BREAKER_THRESHOLD && !record.trippedAt) {
      record.trippedAt = Date.now();
    }
    this.consecutiveFailures.set(agentId, record);
  }

  private recordSuccess(agentId: string): void {
    this.consecutiveFailures.delete(agentId);
  }

  private checkCircuitBreaker(agentId: string): string | null {
    const record = this.consecutiveFailures.get(agentId);
    if (!record || record.count < TypusAdapter.CIRCUIT_BREAKER_THRESHOLD) return null;

    if (record.trippedAt) {
      const elapsed = Date.now() - record.trippedAt;
      if (elapsed >= TypusAdapter.CIRCUIT_BREAKER_COOLDOWN_MS) {
        console.log(`[TypusAdapter] Circuit breaker auto-reset for agent ${agentId} after ${Math.round(elapsed / 1000)}s cooldown`);
        this.consecutiveFailures.delete(agentId);
        return null;
      }
      const remaining = Math.ceil((TypusAdapter.CIRCUIT_BREAKER_COOLDOWN_MS - elapsed) / 1000);
      return `Circuit breaker active (${record.count} consecutive failures). Auto-retry in ${remaining}s. Last error: ${record.lastError}`;
    }

    return `Circuit breaker tripped after ${record.count} consecutive failures. Last error: ${record.lastError}`;
  }

  async matchTradingOrder(keypair: any, walletAddress: string, triggerPrice: bigint): Promise<{ matched: boolean; matchedOrderIds?: string[]; positionId?: string; orderId?: string; txDigest?: string; error?: string }> {
    try {
      console.log(`[TypusAdapter] Calling match_trading_order for wallet ${walletAddress.slice(0, 10)}... trigger=${triggerPrice}`);

      const self = this;
      const result = await withWalletLock(walletAddress, async () => {
        return await signAndExecuteSafe({
          client: self.client,
          signer: keypair,
          owner: walletAddress,
          gasBudget: MATCH_GAS_BUDGET_MIST,
          buildTx: async (tx) => {
            await self.addSuiOracleUpdateToTx(tx);

            tx.moveCall({
              target: `${PERP_MATCH_PACKAGE}::trading::match_trading_order`,
              typeArguments: [SUI_COIN_TYPE, SUI_COIN_TYPE],
              arguments: [
                tx.object(PERP_VERSION),
                tx.object(MARKET_REGISTRY),
                tx.object(LP_POOL_REGISTRY),
                tx.object(TYPUS_PERP_CONFIG),
                tx.object(TYPUS_ORACLE_SUI),
                tx.object(TYPUS_ORACLE_SUI),
                tx.object(CLOCK_ID),
                tx.pure.u64(SUI_MARKET_INDEX),
                tx.pure.u64(SUI_POOL_INDEX),
                ...SUI_LP_VAULTS.map(v => tx.object(v)),
                tx.pure.u8(2),
                tx.pure.u64(triggerPrice),
                tx.pure.u64(100),
              ],
            });
          },
          dryRun: false,
        });
      });

      if (result.effects?.status?.status !== "success") {
        const err = result.effects?.status?.error || "match TX failed";
        console.log(`[TypusAdapter] match_trading_order FAILED: ${err}`);
        return { matched: false, error: err };
      }

      console.log(`[TypusAdapter] match_trading_order SUCCESS: ${result.digest}`);

      let matchedOrderIds: string[] = [];
      let positionId: string | undefined;

      const events = (result as any).events || [];
      for (const evt of events) {
        const parsed = (evt as any).parsedJson;
        if (!parsed) continue;
        const evtType = (evt as any).type || "";

        if (evtType.includes("MatchTradingOrderEvent")) {
          matchedOrderIds = (parsed.matched_order_ids || []).map((id: any) => String(id));
          console.log(`[TypusAdapter] Matched orders: ${matchedOrderIds.join(", ")}`);
        }

        if (evtType.includes("OrderFilledEvent")) {
          console.log(`[TypusAdapter] OrderFilledEvent: order_id=${parsed.order_id}, new_position_id=${parsed.new_position_id}, linked_position_id=${parsed.linked_position_id}, filled_price=${parsed.filled_price}`);
          if (parsed.new_position_id !== undefined && parsed.new_position_id !== null) {
            positionId = String(parsed.new_position_id);
          }
        }
      }

      return {
        matched: matchedOrderIds.length > 0,
        matchedOrderIds,
        positionId,
        orderId: matchedOrderIds[0],
        txDigest: result.digest,
      };
    } catch (err: any) {
      console.log(`[TypusAdapter] matchTradingOrder error: ${err.message}`);
      return { matched: false, error: err.message };
    }
  }

  async openPosition(params: DexOrderParams): Promise<DexOrderResult> {
    try {
      const cbError = this.checkCircuitBreaker(params.agent.id);
      if (cbError) {
        return { success: false, error: cbError, venue: this.venue };
      }

      const validation = await this.validateOrder(params);
      if (!validation.valid) {
        return { success: false, error: validation.reason, venue: this.venue };
      }

      if (!params.agent.agentWallet) {
        return { success: false, error: "Agent wallet not configured", venue: this.venue };
      }

      let pythPrice: PythOraclePrice;
      try {
        pythPrice = await this.fetchPythOraclePrice();
      } catch (oracleErr: any) {
        const errMsg = `Pyth oracle price fetch failed: ${oracleErr.message}`;
        this.recordFailure(params.agent.id, errMsg);
        return { success: false, error: errMsg, venue: this.venue };
      }

      const oracleAge = Math.floor(Date.now() / 1000) - pythPrice.publishTime;
      if (oracleAge > 30) {
        const errMsg = `Pyth oracle price too stale (${oracleAge}s old). Skipping trade.`;
        this.recordFailure(params.agent.id, errMsg);
        return { success: false, error: errMsg, venue: this.venue };
      }

      const keypair = decryptKeypair(params.agent.agentWallet);
      const walletAddress = keypair.toSuiAddress();
      const isLong = params.side === "long";

      const freshPrice = pythPrice.price;
      const collateralSui = params.quantity / params.leverage;
      const posCount = (params.openPositionCount || 0) + 1;
      const dynamicReserve = BASE_GAS_RESERVE_SUI + (posCount * GAS_PER_CLOSE_SUI);
      const totalNeeded = collateralSui + dynamicReserve;

      let onChainBalance: number;
      try {
        const onChainBal = await this.client.getBalance({ owner: walletAddress, coinType: SUI_COIN_TYPE });
        onChainBalance = Number(onChainBal.totalBalance) / MIST_PER_SUI;
        if (Math.abs(onChainBalance - params.agent.balance) > 0.1) {
          console.log(`[TypusAdapter] BALANCE MISMATCH: DB=${params.agent.balance.toFixed(4)} vs on-chain=${onChainBalance.toFixed(4)} SUI — using on-chain value`);
          const { storage } = await import("../storage");
          const allPosForSync = await storage.getPositions(params.agent.id);
          const openPosForSync = allPosForSync.filter((p: any) => p.status === "open");
          const lockedColl = openPosForSync.reduce((s: number, p: any) => s + (p.collateral || p.sizeSui / params.leverage), 0);
          storage.updateAgent(params.agent.id, { balance: onChainBalance + lockedColl }).catch(() => {});
        }
      } catch (balErr: any) {
        const errMsg = `SAFETY: RPC balance check failed — blocking trade to prevent sizing errors. ${balErr.message}`;
        console.log(`[TypusAdapter] ${errMsg}`);
        this.recordFailure(params.agent.id, errMsg);
        return { success: false, error: errMsg, venue: this.venue };
      }

      if (totalNeeded > onChainBalance) {
        return {
          success: false,
          error: `Collateral (${collateralSui.toFixed(4)}) + gas reserve (${dynamicReserve.toFixed(4)}) = ${totalNeeded.toFixed(4)} SUI exceeds on-chain balance ${onChainBalance.toFixed(4)} SUI — reduce position size`,
          venue: this.venue,
        };
      }
      const collateralMist = suiToMist(collateralSui);
      const sizeUnits = toSizeUnits(params.quantity);
      const preOrderBalance = onChainBalance;

      const oraclePriceBigInt = toOraclePriceUnits(freshPrice);
      const triggerPrice = applySlippage(oraclePriceBigInt, isLong);

      if (sizeUnits < SUI_PERP_MIN_SIZE_UNITS) {
        return {
          success: false,
          error: `Position size ${params.quantity.toFixed(4)} SUI below minimum 10 SUI (lot_size=1 SUI)`,
          venue: this.venue,
        };
      }

      const diffBps = ((triggerPrice - oraclePriceBigInt) * BigInt(10000)) / oraclePriceBigInt;
      const effectiveLev = params.quantity / collateralSui;

      const triggerRatio = Number(triggerPrice) / Number(oraclePriceBigInt);
      const isStopOrder = isLong ? triggerRatio < 1.02 : triggerRatio > 0.98;
      if (isStopOrder) {
        return {
          success: false,
          error: `BLOCKED: trigger/oracle ratio ${triggerRatio.toFixed(4)} would create a STOP order (${isLong ? "LONG needs >1.02" : "SHORT needs <0.98"}). This prevents collateral from being locked in pending orders. Slippage: ${isLong ? "LONG" : "SHORT"}=${isLong ? SLIPPAGE_BPS_LONG : SLIPPAGE_BPS_SHORT}bps`,
          venue: this.venue,
        };
      }

      console.log(`[TypusAdapter] OPEN ${isLong ? "LONG" : "SHORT"} | Pyth: $${freshPrice.toFixed(6)} | oracle(8dec): ${oraclePriceBigInt} | trigger: ${triggerPrice} | diff: ${diffBps}bps | ratio: ${triggerRatio.toFixed(4)} (MARKET) | age: ${oracleAge}s | qty: ${params.quantity.toFixed(4)} SUI | collateral: ${collateralSui.toFixed(4)} SUI | configured_lev: ${params.leverage}x | effective_lev: ${effectiveLev.toFixed(2)}x | pkg: ${PERP_TRADING_PACKAGE.slice(0,10)} | oracle: SUI×2`);

      const self = this;
      const result = await withWalletLock(walletAddress, async () => {
        const res = await signAndExecuteSafe({
          client: self.client,
          signer: keypair,
          owner: walletAddress,
          gasBudget: GAS_BUDGET_MIST,
          buildTx: async (tx) => {
            await self.addSuiOracleUpdateToTx(tx);

            const [collateralCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(collateralMist)]);

            tx.moveCall({
              target: `${PERP_TRADING_PACKAGE}::trading::create_trading_order`,
              typeArguments: [SUI_COIN_TYPE, SUI_COIN_TYPE],
              arguments: [
                tx.object(PERP_VERSION),
                tx.object(MARKET_REGISTRY),
                tx.object(LP_POOL_REGISTRY),
                tx.object(TYPUS_ORACLE_SUI),
                tx.object(TYPUS_ORACLE_SUI),
                tx.object(CLOCK_ID),
                tx.pure.u64(SUI_MARKET_INDEX),
                tx.pure.u64(SUI_POOL_INDEX),
                tx.pure.option("u64", null),
                collateralCoin,
                tx.pure.bool(false),
                tx.pure.bool(isLong),
                tx.pure.bool(!isLong),
                tx.pure.u64(sizeUnits),
                tx.pure.u64(triggerPrice),
              ],
            });
          },
          dryRun: false,
        });
        return res;
      });

      if (result.effects?.status?.status === "success") {
        this.recordSuccess(params.agent.id);
        console.log(`[TypusAdapter] Trade SUCCESS: ${result.digest}`);

        let onChainPositionId: string | undefined;
        let orderId: string | undefined;
        if (result.events) {
          for (const evt of result.events) {
            const parsed = evt.parsedJson as any;
            if (!parsed) continue;
            
            if (evt.type.includes("CreateTradingOrderEvent")) {
              console.log(`[TypusAdapter] CreateTradingOrderEvent: order_id=${parsed.order_id}, linked_position_id=${parsed.linked_position_id}, filled=${parsed.filled}`);
              orderId = parsed.order_id !== undefined ? String(parsed.order_id) : undefined;
              if (parsed.linked_position_id) {
                onChainPositionId = String(parsed.linked_position_id);
              }
            }
            
            if (evt.type.includes("OrderFilledEvent")) {
              console.log(`[TypusAdapter] OrderFilledEvent: new_position_id=${parsed.new_position_id}, order_id=${parsed.order_id}`);
              if (parsed.new_position_id !== undefined) {
                onChainPositionId = String(parsed.new_position_id);
              }
            }
            
            if (evt.type.includes("FillTradingOrderEvent") || evt.type.includes("PositionChangeEvent")) {
              console.log(`[TypusAdapter] ${evt.type.split("::").pop()}: position_id=${parsed.position_id}, order_id=${parsed.order_id}`);
              if (parsed.position_id && !onChainPositionId) {
                onChainPositionId = String(parsed.position_id);
              }
            }
          }
        }

        let orderFilled = !!onChainPositionId;

        if (!onChainPositionId && orderId) {
          console.log(`[TypusAdapter] Order ${orderId} created — waiting for keeper fill (15s)...`);
          const fillPositionId = await this.pollForFillPositionId(walletAddress, orderId, 15000);
          if (fillPositionId) {
            onChainPositionId = fillPositionId;
            orderFilled = true;
            console.log(`[TypusAdapter] Resolved position ID from keeper fill: ${onChainPositionId}`);
          }

          if (!orderFilled) {
            console.log(`[TypusAdapter] Order ${orderId} NOT FILLED after 15s poll. Attempting cancel to recover collateral...`);
            let cancelSucceeded = false;
            let cancelOrderNotFound = false;
            try {
              const cancelResult = await this.cancelUnfilledOrder(params.agent.agentWallet!, orderId);
              if (cancelResult.cancelled) {
                console.log(`[TypusAdapter] Unfilled order ${orderId} cancelled — collateral recovered: ${cancelResult.collateralReturned}`);
                cancelSucceeded = true;
              } else {
                console.log(`[TypusAdapter] Cancel failed for order ${orderId}: ${cancelResult.error}`);
                cancelOrderNotFound = (cancelResult.error || "").includes("order_not_found");
              }
            } catch (cancelErr: any) {
              console.log(`[TypusAdapter] Cancel error for order ${orderId}: ${cancelErr.message}`);
              cancelOrderNotFound = cancelErr.message.includes("order_not_found");
            }

            if (cancelSucceeded) {
              await new Promise(r => setTimeout(r, 1500));
              try {
                const postCancelBal = await this.client.getBalance({ owner: walletAddress, coinType: SUI_COIN_TYPE });
                const postCancelSui = Number(postCancelBal.totalBalance) / MIST_PER_SUI;
                console.log(`[TypusAdapter] Post-cancel balance verification: ${postCancelSui.toFixed(4)} SUI (collateral ${collateralSui.toFixed(4)} should be returned)`);
                const { storage: st } = await import("../storage");
                const allPos = await st.getPositions(params.agent.id);
                const openP = allPos.filter((p: any) => p.status === "open");
                const locked = openP.reduce((s: number, p: any) => s + (p.collateral || p.sizeSui / params.leverage), 0);
                await st.updateAgent(params.agent.id, { balance: postCancelSui + locked });
              } catch {}
              return {
                success: false,
                error: `Order ${orderId} cancelled (not filled in 15s) — collateral recovered`,
                venue: this.venue,
              };
            }

            if (cancelOrderNotFound) {
              console.log(`[TypusAdapter] Order ${orderId} not found on cancel — likely filled by keeper. Using balance-confirmed detection...`);

              let postBalance = preOrderBalance;
              try {
                const postBal = await this.client.getBalance({ owner: walletAddress, coinType: SUI_COIN_TYPE });
                postBalance = Number(postBal.totalBalance) / MIST_PER_SUI;
              } catch {}

              const balanceDrop = preOrderBalance - postBalance;
              const balanceConfirmsFill = balanceDrop >= collateralSui * 0.8;

              console.log(`[TypusAdapter] Balance check: pre=${preOrderBalance.toFixed(4)}, post=${postBalance.toFixed(4)}, drop=${balanceDrop.toFixed(4)}, expectedCollateral=${collateralSui.toFixed(4)}, confirmsFill=${balanceConfirmsFill}`);

              if (balanceConfirmsFill) {
                console.log(`[TypusAdapter] Balance confirms order ${orderId} was FILLED (${balanceDrop.toFixed(4)} SUI consumed). Waiting 10s for event indexer then resolving position_id...`);
                await new Promise(r => setTimeout(r, 10000));
              }

              const resolvedPos = await TypusAdapter.resolvePositionIdFromOrderId(this.client, walletAddress, orderId);
              if (resolvedPos) {
                console.log(`[TypusAdapter] Order ${orderId} WAS filled by keeper! position_id=${resolvedPos}`);
                onChainPositionId = resolvedPos;
                orderFilled = true;
              } else if (balanceConfirmsFill) {
                console.log(`[TypusAdapter] Order ${orderId} balance-confirmed filled but position_id not yet indexed. Returning as filled so position is tracked.`);
                onChainPositionId = undefined;
                orderFilled = true;
              } else {
                console.log(`[TypusAdapter] Order ${orderId} not found and balance shows no collateral consumed. Syncing balance.`);
                try {
                  const { storage } = await import("../storage");
                  const allPositions = await storage.getPositions(params.agent.id);
                  const openPos = allPositions.filter((p: any) => p.status === "open");
                  const currentLocked = openPos.reduce((s: number, p: any) => s + (p.collateral || p.sizeSui / params.leverage), 0);
                  await storage.updateAgent(params.agent.id, {
                    balance: postBalance + currentLocked,
                  });
                  console.log(`[TypusAdapter] Balance synced: on-chain=${postBalance.toFixed(4)}+locked=${currentLocked.toFixed(4)} SUI`);
                } catch (syncErr: any) {
                  console.log(`[TypusAdapter] Balance sync failed: ${syncErr.message}`);
                }
                return {
                  success: false,
                  error: `Order ${orderId} vanished without consuming collateral — balance recovered`,
                  venue: this.venue,
                };
              }
            }

            if (!orderFilled) {
              try {
                const { storage } = await import("../storage");
                const onChainBal = await this.client.getBalance({ owner: walletAddress, coinType: SUI_COIN_TYPE });
                const realBalance = Number(onChainBal.totalBalance) / MIST_PER_SUI;
                const allPos2 = await storage.getPositions(params.agent.id);
                const openPos2 = allPos2.filter((p: any) => p.status === "open");
                const lockedColl2 = openPos2.reduce((s: number, p: any) => s + (p.collateral || p.sizeSui / params.leverage), 0);
                await storage.updateAgent(params.agent.id, {
                  balance: realBalance + lockedColl2,
                });
                console.log(`[TypusAdapter] Balance synced after order failure: on-chain=${realBalance.toFixed(4)}+locked=${lockedColl2.toFixed(4)} SUI`);
              } catch (syncErr: any) {
                console.log(`[TypusAdapter] Post-failure balance sync error: ${syncErr.message}`);
              }

              return {
                success: false,
                error: `Order ${orderId} not matched — ${cancelSucceeded ? "cancelled to recover collateral" : "cancel also failed"}`,
                txDigest: result.digest,
                venue: this.venue,
              };
            }
          }
        }
          
        if (!onChainPositionId) {
          console.log(`[TypusAdapter] WARNING: No position ID found in events or fill TX.`);
        }

        return { 
          success: true, 
          txDigest: result.digest, 
          venue: this.venue,
          positionId: onChainPositionId,
          orderId,
        };
      } else {
        const errMsg = result.effects?.status?.error || "Transaction failed";
        this.recordFailure(params.agent.id, errMsg);
        console.log(`[TypusAdapter] Trade FAILED: ${errMsg}`);
        return { success: false, error: errMsg, venue: this.venue };
      }
    } catch (error: any) {
      this.recordFailure(params.agent.id, error.message);
      return { success: false, error: error.message, venue: this.venue };
    }
  }

  async checkPriorCloseFilled(walletAddress: string, positionId: string): Promise<{ filled: boolean; txDigest?: string }> {
    try {
      let cursor: any = null;
      for (let page = 0; page < 15; page++) {
        const query: any = {
          query: { MoveEventType: `${PERP_TRADING_PACKAGE}::position::OrderFilledEvent` },
          limit: 50,
          order: "descending",
        };
        if (cursor) query.cursor = cursor;
        const evtResult = await this.client.queryEvents(query);
        if (!evtResult?.data?.length) break;

        for (const evt of evtResult.data) {
          const p = (evt as any).parsedJson;
          if (!p) continue;
          if (p.user && String(p.user) !== walletAddress) continue;

          if (p.linked_position_id === null || p.linked_position_id === undefined) continue;
          if (String(p.linked_position_id) !== positionId) continue;

          const isClose = p.reduce_only === true ||
            (p.new_position_id === undefined || p.new_position_id === null || String(p.new_position_id) === "0");

          if (!isClose) continue;

          const txDigest = (evt as any).id?.txDigest || undefined;
          console.log(`[TypusAdapter] Found prior close fill for position ${positionId} via event query (tx=${txDigest}, reduce_only=${p.reduce_only}, linked=${p.linked_position_id})`);
          return { filled: true, txDigest };
        }

        if (!evtResult.hasNextPage || !evtResult.nextCursor) break;
        cursor = evtResult.nextCursor;
      }

      let liqCursor: any = null;
      for (let page = 0; page < 5; page++) {
        const query: any = {
          query: { MoveEventType: `${PERP_TRADING_PACKAGE}::position::LiquidateEvent` },
          limit: 50,
          order: "descending",
        };
        if (liqCursor) query.cursor = liqCursor;
        const evtResult = await this.client.queryEvents(query);
        if (!evtResult?.data?.length) break;

        for (const evt of evtResult.data) {
          const p = (evt as any).parsedJson;
          if (!p) continue;
          if (p.user && String(p.user) !== walletAddress) continue;
          if (String(p.position_id) !== positionId) continue;

          const txDigest = (evt as any).id?.txDigest || undefined;
          console.log(`[TypusAdapter] Found LIQUIDATION for position ${positionId} via event query (tx=${txDigest})`);
          return { filled: true, txDigest };
        }

        if (!evtResult.hasNextPage || !evtResult.nextCursor) break;
        liqCursor = evtResult.nextCursor;
      }
    } catch (err: any) {
      console.log(`[TypusAdapter] checkPriorCloseFilled error: ${err.message}`);
    }
    return { filled: false };
  }

  private async paginatedTxScan(walletAddress: string, direction: "from" | "to"): Promise<any[]> {
    const allTxs: any[] = [];
    let cursor: string | null = null;
    const filter = direction === "from" ? { FromAddress: walletAddress } : { ToAddress: walletAddress };

    for (let page = 0; page < 5; page++) {
      const query: any = {
        filter,
        options: { showEvents: true },
        limit: 50,
      };
      if (cursor) query.cursor = cursor;
      const result = await this.client.queryTransactionBlocks(query);
      if (!result?.data?.length) break;
      allTxs.push(...result.data);
      if (!result.hasNextPage || !result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return allTxs;
  }

  async findAllUnfilledOrderIds(walletAddress: string): Promise<{ created: Map<string, { isReduceOnly: boolean; collateral: number; linkedPositionId: string | null }>; unfilled: string[] }> {
    const [fromTxs, toTxs] = await Promise.all([
      this.paginatedTxScan(walletAddress, "from"),
      this.paginatedTxScan(walletAddress, "to"),
    ]);

    const created = new Map<string, { isReduceOnly: boolean; collateral: number; linkedPositionId: string | null }>();
    const filledIds = new Set<string>();
    const cancelledIds = new Set<string>();

    for (const tx of [...fromTxs, ...toTxs]) {
      for (const evt of (tx.events || [])) {
        const p = (evt as any).parsedJson;
        if (!p) continue;
        const t = (evt as any).type || "";
        if (t.includes("CreateTradingOrderEvent") && p.order_id !== undefined) {
          const oid = String(p.order_id);
          if (!created.has(oid)) {
            created.set(oid, {
              isReduceOnly: p.reduce_only === true,
              collateral: Number(p.collateral || 0) / MIST_PER_SUI,
              linkedPositionId: p.linked_position_id !== null && p.linked_position_id !== undefined ? String(p.linked_position_id) : null,
            });
          }
        }
        if (t.includes("OrderFilledEvent") && p.order_id !== undefined) filledIds.add(String(p.order_id));
        if (t.includes("CancelTradingOrderEvent") && p.order_id !== undefined) cancelledIds.add(String(p.order_id));
      }
    }

    if (created.size > 0) {
      try {
        let cursor: any = null;
        for (let page = 0; page < 15; page++) {
          const query: any = {
            query: { MoveEventType: `${PERP_TRADING_PACKAGE}::position::OrderFilledEvent` },
            limit: 50,
            order: "descending",
          };
          if (cursor) query.cursor = cursor;
          const evtResult = await this.client.queryEvents(query);
          if (!evtResult?.data?.length) break;

          for (const evt of evtResult.data) {
            const p = (evt as any).parsedJson;
            if (!p) continue;
            if (p.user && String(p.user) !== walletAddress) continue;
            if (p.order_id !== undefined) filledIds.add(String(p.order_id));
          }

          if (!evtResult.hasNextPage || !evtResult.nextCursor) break;
          cursor = evtResult.nextCursor;
        }
      } catch (evtErr: any) {
        console.log(`[TypusAdapter] findAllUnfilledOrderIds event query fallback error: ${evtErr.message}`);
      }
    }

    const hasCancelNotFoundErrors = fromTxs.some(tx => {
      const status = tx.effects?.status?.status;
      if (status !== "failure") return false;
      const errStr = tx.effects?.status?.error || "";
      return errStr.includes("order_not_found");
    });

    let unfilled = [...created.keys()].filter(oid => !filledIds.has(oid) && !cancelledIds.has(oid));

    if (unfilled.length > 0 && hasCancelNotFoundErrors) {
      console.log(`[TypusAdapter] findAllUnfilledOrderIds: ${unfilled.length} orders appear unfilled but cancel_trading_order fails with order_not_found — these orders were likely filled by keeper. Marking as filled.`);
      for (const oid of unfilled) {
        filledIds.add(oid);
      }
      unfilled = [];
    }

    console.log(`[TypusAdapter] findAllUnfilledOrderIds(${walletAddress.slice(0, 10)}): ${created.size} created, ${filledIds.size} filled, ${cancelledIds.size} cancelled, ${unfilled.length} unfilled`);
    return { created, unfilled };
  }

  async cancelPendingOrdersForPosition(agentWallet: any, positionId: string): Promise<{ cancelled: boolean; cancelledCount: number; error?: string }> {
    try {
      const keypair = decryptKeypair(agentWallet);
      const walletAddress = keypair.toSuiAddress();

      const { created, unfilled } = await this.findAllUnfilledOrderIds(walletAddress);

      const linkedOrderIds = unfilled.filter(oid => {
        const info = created.get(oid);
        return info && info.linkedPositionId === positionId;
      });

      if (linkedOrderIds.length === 0) {
        console.log(`[TypusAdapter] No unfilled orders found linked to position ${positionId} (scanned ${created.size} total orders)`);
        return { cancelled: true, cancelledCount: 0 };
      }

      console.log(`[TypusAdapter] Found ${linkedOrderIds.length} unfilled orders for position ${positionId}: ${linkedOrderIds.join(", ")}. Cancelling...`);

      let cancelledCount = 0;
      for (const orderId of linkedOrderIds) {
        const cancelResult = await this.cancelUnfilledOrder(agentWallet, orderId);
        if (cancelResult.cancelled) {
          cancelledCount++;
          console.log(`[TypusAdapter] Cancelled order ${orderId} for position ${positionId}`);
        } else {
          console.log(`[TypusAdapter] Cancel order ${orderId} failed: ${cancelResult.error}`);
        }
        await new Promise(r => setTimeout(r, 300));
      }

      return { cancelled: cancelledCount > 0, cancelledCount };
    } catch (err: any) {
      console.log(`[TypusAdapter] cancelPendingOrdersForPosition error: ${err.message}`);
      return { cancelled: false, cancelledCount: 0, error: err.message };
    }
  }

  async closePosition(params: DexCloseParams): Promise<DexOrderResult> {
    try {
      if (!params.agent.agentWallet) {
        return { success: false, error: "Agent wallet not configured", venue: this.venue };
      }

      let pythPrice: PythOraclePrice;
      try {
        pythPrice = await this.fetchPythOraclePrice();
      } catch (oracleErr: any) {
        const errMsg = `Pyth oracle price fetch failed: ${oracleErr.message}`;
        return { success: false, error: errMsg, venue: this.venue };
      }

      const oracleAge = Math.floor(Date.now() / 1000) - pythPrice.publishTime;
      if (oracleAge > 60) {
        const errMsg = `Pyth oracle price too stale (${oracleAge}s old). Skipping close.`;
        return { success: false, error: errMsg, venue: this.venue };
      }

      const keypair = decryptKeypair(params.agent.agentWallet);
      const walletAddress = keypair.toSuiAddress();
      const sizeUnits = toSizeUnits(params.quantity || 0);
      const isLong = params.side === "long";

      const oraclePriceBigInt = toOraclePriceUnits(pythPrice.price);
      const triggerPrice = applySlippage(oraclePriceBigInt, !isLong);

      const isOnChainId = params.positionId && !params.positionId.includes("-");
      const linkedPositionId = isOnChainId ? BigInt(params.positionId) : null;

      if (!linkedPositionId) {
        const errMsg = `Cannot close position: no on-chain positionId available (got UUID: ${params.positionId}). Position may need manual reconciliation.`;
        console.log(`[TypusAdapter] CLOSE REJECTED: ${errMsg}`);
        return { success: false, error: errMsg, venue: this.venue };
      }

      const closeRatio = Number(triggerPrice) / Number(oraclePriceBigInt);
      const isCloseStopOrder = !isLong ? closeRatio < 1.02 : closeRatio > 0.98;
      if (isCloseStopOrder) {
        return {
          success: false,
          error: `BLOCKED: close trigger/oracle ratio ${closeRatio.toFixed(4)} would create a STOP order. Close uses inverse slippage: ${!isLong ? "closing SHORT needs ratio >1.02" : "closing LONG needs ratio <0.98"}.`,
          venue: this.venue,
        };
      }

      console.log(`[TypusAdapter] CLOSE ${isLong ? "LONG" : "SHORT"} | posId: ${params.positionId} | linkedId: ${linkedPositionId} | Pyth: $${pythPrice.price.toFixed(6)} | oracle(8dec): ${oraclePriceBigInt} | trigger: ${triggerPrice} | ratio: ${closeRatio.toFixed(4)} (MARKET) | above: ${isLong} | age: ${oracleAge}s | COMBINED PTB`);

      try {
        const { unfilled, created } = await this.findAllUnfilledOrderIds(walletAddress);
        const linkedCloseOrders = unfilled.filter(oid => {
          const info = created.get(oid);
          return info && info.linkedPositionId === String(linkedPositionId);
        });
        if (linkedCloseOrders.length > 0) {
          console.log(`[TypusAdapter] CLOSE PRE-CLEANUP: ${linkedCloseOrders.length} stale unfilled close orders linked to position ${linkedPositionId} — cancelling before creating new close order: ${linkedCloseOrders.join(", ")}`);
          for (const oid of linkedCloseOrders) {
            const cr = await this.cancelUnfilledOrder(params.agent.agentWallet!, oid);
            console.log(`[TypusAdapter] Pre-close cancel order ${oid}: ${cr.cancelled ? "OK" : cr.error}`);
            await new Promise(r => setTimeout(r, 300));
          }
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch (cleanupErr: any) {
        console.log(`[TypusAdapter] Pre-close cleanup error (non-fatal): ${cleanupErr.message}`);
      }

      const self = this;
      const result = await withWalletLock(walletAddress, async () => {
        const res = await signAndExecuteSafe({
          client: self.client,
          signer: keypair,
          owner: walletAddress,
          gasBudget: GAS_BUDGET_MIST,
          buildTx: async (tx) => {
            await self.addSuiOracleUpdateToTx(tx);

            const zeroCoin = tx.moveCall({ target: "0x2::coin::zero", typeArguments: [SUI_COIN_TYPE] });

            tx.moveCall({
              target: `${PERP_TRADING_PACKAGE}::trading::create_trading_order`,
              typeArguments: [SUI_COIN_TYPE, SUI_COIN_TYPE],
              arguments: [
                tx.object(PERP_VERSION),
                tx.object(MARKET_REGISTRY),
                tx.object(LP_POOL_REGISTRY),
                tx.object(TYPUS_ORACLE_SUI),
                tx.object(TYPUS_ORACLE_SUI),
                tx.object(CLOCK_ID),
                tx.pure.u64(SUI_MARKET_INDEX),
                tx.pure.u64(SUI_POOL_INDEX),
                tx.pure.option("u64", linkedPositionId),
                zeroCoin,
                tx.pure.bool(true),
                tx.pure.bool(isLong),
                tx.pure.bool(isLong),
                tx.pure.u64(sizeUnits),
                tx.pure.u64(triggerPrice),
              ],
            });
          },
          dryRun: false,
        });
        return res;
      });

      if (result.effects?.status?.status === "success") {
        this.recordSuccess(params.agent.id);

        let closeOrderId: string | null = null;
        const events = (result as any).events || [];
        for (const evt of events) {
          const parsed = (evt as any).parsedJson;
          if (!parsed) continue;
          const evtType = (evt as any).type || "";
          if (evtType.includes("CreateTradingOrderEvent")) {
            closeOrderId = parsed.order_id ? String(parsed.order_id) : null;
            console.log(`[TypusAdapter] Close order created: order_id=${closeOrderId}, linked_position_id=${parsed.linked_position_id}`);
          }
        }

        let orderFilled = false;

        if (closeOrderId) {
          console.log(`[TypusAdapter] Close order ${closeOrderId} created — waiting for keeper fill (15s)...`);
          const fillConfirmed = await this.pollForCloseFill(walletAddress, closeOrderId, 15000);
          if (fillConfirmed) {
            console.log(`[TypusAdapter] Close fill confirmed via keeper for order ${closeOrderId}`);
            orderFilled = true;
          } else {
            console.log(`[TypusAdapter] Close order ${closeOrderId} not filled yet — will be handled by pending close tracker`);
          }
        }

        return { 
          success: true, 
          txDigest: result.digest, 
          venue: this.venue,
          positionId: params.positionId,
          orderId: closeOrderId || undefined,
          filled: orderFilled,
        };
      } else {
        const onChainError = result.effects?.status?.error || "Close TX failed on-chain (no error details)";
        console.log(`[TypusAdapter] Close TX executed but FAILED on-chain: ${onChainError}`);
        return { 
          success: false, 
          error: onChainError,
          txDigest: result.digest, 
          venue: this.venue,
          positionId: params.positionId
        };
      }
    } catch (error: any) {
      return { success: false, error: error.message, venue: this.venue };
    }
  }

  private async pollForCloseFill(walletAddress: string, orderId: string, maxWaitMs: number = 15000): Promise<boolean> {
    const pollInterval = 2000;
    const maxAttempts = Math.ceil(maxWaitMs / pollInterval);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));

      try {
        const found = await this.queryCloseFilledEvent(walletAddress, orderId);
        if (found) {
          console.log(`[TypusAdapter] Close fill confirmed for order_id=${orderId} (attempt ${attempt + 1})`);
          return true;
        }
      } catch (err: any) {
        console.log(`[TypusAdapter] Close fill poll attempt ${attempt + 1} failed: ${err.message}`);
      }
    }

    console.log(`[TypusAdapter] Close fill poll exhausted after ${maxAttempts} attempts for order_id=${orderId}`);
    return false;
  }

  private async queryCloseFilledEvent(walletAddress: string, orderId: string): Promise<boolean> {
    let cursor: any = null;
    for (let page = 0; page < 3; page++) {
      const query: any = {
        query: { MoveEventType: `${PERP_TRADING_PACKAGE}::position::OrderFilledEvent` },
        limit: 50,
        order: "descending",
      };
      if (cursor) query.cursor = cursor;
      const evtResult = await this.client.queryEvents(query);
      if (!evtResult?.data?.length) break;

      for (const evt of evtResult.data) {
        const parsed = (evt as any).parsedJson;
        if (!parsed) continue;
        if (String(parsed.order_id) !== orderId) continue;
        if (parsed.user && String(parsed.user) !== walletAddress) continue;
        if (parsed.linked_position_id !== null && parsed.linked_position_id !== undefined) {
          console.log(`[TypusAdapter] Close fill found via queryEvents for order_id=${orderId}: realized_amount=${parsed.realized_amount}, sign=${parsed.realized_amount_sign}`);
          return true;
        }
      }

      if (!evtResult.hasNextPage || !evtResult.nextCursor) break;
      cursor = evtResult.nextCursor;
    }

    const recentTxs = await this.client.queryTransactionBlocks({
      filter: { ToAddress: walletAddress },
      options: { showEvents: true },
      limit: 15,
      order: "descending" as any,
    });
    if (recentTxs?.data) {
      for (const txBlock of recentTxs.data) {
        const events = (txBlock as any).events;
        if (!events) continue;
        for (const evt of events) {
          const parsed = (evt as any).parsedJson;
          if (!parsed) continue;
          if (!(evt.type || "").includes("OrderFilledEvent")) continue;
          if (String(parsed.order_id) !== orderId) continue;
          if (parsed.linked_position_id !== null && parsed.linked_position_id !== undefined) return true;
        }
      }
    }

    return false;
  }

  async cancelUnfilledOrder(agentWallet: any, orderId: string): Promise<{ cancelled: boolean; collateralReturned: boolean; txDigest?: string; error?: string }> {
    try {
      const keypair = decryptKeypair(agentWallet);
      const walletAddress = keypair.toSuiAddress();

      console.log(`[TypusAdapter] Attempting to cancel unfilled order ${orderId} for wallet ${walletAddress.slice(0, 10)}...`);

      const self = this;
      const result = await withWalletLock(walletAddress, async () => {
        const res = await signAndExecuteSafe({
          client: self.client,
          signer: keypair,
          owner: walletAddress,
          gasBudget: GAS_BUDGET_MIST,
          buildTx: async (tx) => {
            const returnedCoin = tx.moveCall({
              target: `${PERP_TRADING_PACKAGE}::trading::cancel_trading_order`,
              typeArguments: [SUI_COIN_TYPE, SUI_COIN_TYPE],
              arguments: [
                tx.object(PERP_VERSION),
                tx.object(MARKET_REGISTRY),
                tx.pure.u64(SUI_MARKET_INDEX),
                tx.pure.u64(SUI_POOL_INDEX),
                tx.pure.u64(BigInt(orderId)),
                tx.pure.option("address", null),
              ],
            });
            tx.transferObjects([returnedCoin], walletAddress);
          },
          dryRun: false,
        });
        return res;
      });

      if (result.effects?.status?.status === "success") {
        const balChanges = (result as any).balanceChanges || [];
        const suiReturned = balChanges
          .filter((b: any) => (b.coinType || '').includes('sui::SUI') && b.owner?.AddressOwner === walletAddress)
          .reduce((sum: number, b: any) => sum + Number(b.amount || 0), 0);
        const collateralReturned = suiReturned > 0;
        console.log(`[TypusAdapter] Order ${orderId} cancel SUCCESS: tx=${result.digest}, SUI returned=${(suiReturned / 1e9).toFixed(4)}`);
        return { cancelled: true, collateralReturned, txDigest: result.digest };
      } else {
        const err = result.effects?.status?.error || "Cancel TX failed";
        console.log(`[TypusAdapter] Order ${orderId} cancel FAILED: ${err}`);
        return { cancelled: false, collateralReturned: false, error: err };
      }
    } catch (err: any) {
      console.log(`[TypusAdapter] cancelUnfilledOrder error: ${err.message}`);
      return { cancelled: false, collateralReturned: false, error: err.message };
    }
  }

  async scanAndRecoverOrphanedOrders(agentWallet: any, agentId: string): Promise<{
    scanned: number;
    cancelled: number;
    filled: number;
    recovered: number;
    details: Array<{ orderId: string; status: string; txDigest?: string; collateralSui?: number }>;
  }> {
    const keypair = decryptKeypair(agentWallet);
    const walletAddress = keypair.toSuiAddress();
    const result = { scanned: 0, cancelled: 0, filled: 0, recovered: 0, details: [] as any[] };

    try {
      const { created: createdOrders, unfilled: unfilledIds } = await this.findAllUnfilledOrderIds(walletAddress);

      const unfilledOrders = unfilledIds.map(oid => [oid, createdOrders.get(oid)!] as const);

      result.scanned = createdOrders.size;
      console.log(`[TypusAdapter] Orphan scan for ${walletAddress.slice(0, 10)}: ${createdOrders.size} orders total, ${unfilledOrders.length} orphaned`);

      for (const [orderId, orderInfo] of unfilledOrders) {
        console.log(`[TypusAdapter] Attempting cancel of orphaned order ${orderId} (reduce=${orderInfo.isReduceOnly}, collateral=${orderInfo.collateral.toFixed(4)} SUI)...`);

        const cancelResult = await this.cancelUnfilledOrder(agentWallet, orderId);

        if (cancelResult.cancelled) {
          result.cancelled++;
          if (cancelResult.collateralReturned && !orderInfo.isReduceOnly) {
            result.recovered++;
          }
          result.details.push({
            orderId,
            status: "cancelled",
            txDigest: cancelResult.txDigest,
            collateralSui: orderInfo.collateral,
          });
        } else {
          const isNotFound = (cancelResult.error || "").includes("order_not_found") || (cancelResult.error || "").includes("abort");
          if (isNotFound) {
            const fillCheck = await TypusAdapter.resolvePositionIdFromOrderId(this.client, walletAddress, orderId);
            if (fillCheck) {
              result.filled++;
              result.details.push({ orderId, status: "filled_by_keeper", collateralSui: orderInfo.collateral });
              console.log(`[TypusAdapter] Orphaned order ${orderId} was actually filled as position ${fillCheck}`);
            } else {
              result.details.push({ orderId, status: "not_found_no_fill", collateralSui: orderInfo.collateral });
              console.log(`[TypusAdapter] Orphaned order ${orderId}: order_not_found and no fill detected — collateral may be lost`);
            }
          } else {
            result.details.push({ orderId, status: `cancel_failed: ${cancelResult.error}`, collateralSui: orderInfo.collateral });
          }
        }

        await new Promise(r => setTimeout(r, 500));
      }

      if (result.cancelled > 0 || result.filled > 0) {
        try {
          const { storage } = await import("../storage");
          const onChainBal = await this.client.getBalance({ owner: walletAddress, coinType: SUI_COIN_TYPE });
          const realBalance = Number(onChainBal.totalBalance) / MIST_PER_SUI;
          const positions = await storage.getPositions(agentId);
          const openPos = positions.filter(p => p.status === "open");
          const lockedCollateral = openPos.reduce((s, p) => s + (p.collateral || p.sizeSui / 25), 0);
          await storage.updateAgent(agentId, {
            balance: realBalance + lockedCollateral,
            lastExecutionError: `Orphan recovery: cancelled ${result.cancelled} orders, recovered collateral. Balance synced: ${realBalance.toFixed(4)} SUI`,
          });
          console.log(`[TypusAdapter] Post-recovery balance sync: on-chain=${realBalance.toFixed(4)}+locked=${lockedCollateral.toFixed(4)}=${(realBalance + lockedCollateral).toFixed(4)} SUI`);
        } catch (err: any) {
          console.log(`[TypusAdapter] Post-recovery balance sync failed: ${err.message}`);
        }
      }

      return result;
    } catch (err: any) {
      console.log(`[TypusAdapter] scanAndRecoverOrphanedOrders error: ${err.message}`);
      return result;
    }
  }

  private async pollForFillPositionId(walletAddress: string, orderId: string, maxWaitMs: number = 15000): Promise<string | null> {
    const pollInterval = 1500;
    const maxAttempts = Math.ceil(maxWaitMs / pollInterval);
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
      
      try {
        const result = await this.queryOrderFilledEvent(walletAddress, orderId);
        if (result) {
          console.log(`[TypusAdapter] Found OrderFilledEvent for order_id=${orderId}: new_position_id=${result} (attempt ${attempt + 1})`);
          return result;
        }
      } catch (err: any) {
        console.log(`[TypusAdapter] Poll attempt ${attempt + 1} for fill failed: ${err.message}`);
      }
    }
    
    console.log(`[TypusAdapter] Fill poll exhausted after ${maxAttempts} attempts for order_id=${orderId}`);
    return null;
  }

  private async queryOrderFilledEvent(walletAddress: string, orderId: string): Promise<string | null> {
    let cursor: any = null;
    for (let page = 0; page < 10; page++) {
      const query: any = {
        query: { MoveEventType: `${PERP_TRADING_PACKAGE}::position::OrderFilledEvent` },
        limit: 50,
        order: "descending",
      };
      if (cursor) query.cursor = cursor;
      const evtResult = await this.client.queryEvents(query);
      if (!evtResult?.data?.length) break;

      for (const evt of evtResult.data) {
        const parsed = (evt as any).parsedJson;
        if (!parsed) continue;
        if (String(parsed.order_id) !== orderId) continue;
        if (parsed.user && String(parsed.user) !== walletAddress) continue;

        const posId = parsed.new_position_id !== undefined && parsed.new_position_id !== null
          ? String(parsed.new_position_id) : null;
        if (posId) return posId;
      }

      if (!evtResult.hasNextPage || !evtResult.nextCursor) break;
      cursor = evtResult.nextCursor;
    }

    const recentTxs = await this.client.queryTransactionBlocks({
      filter: { ToAddress: walletAddress },
      options: { showEvents: true },
      limit: 15,
      order: "descending" as any,
    });
    if (recentTxs?.data) {
      for (const txBlock of recentTxs.data) {
        const events = (txBlock as any).events;
        if (!events) continue;
        for (const evt of events) {
          const parsed = (evt as any).parsedJson;
          if (!parsed) continue;
          if (!(evt.type || "").includes("OrderFilledEvent")) continue;
          if (String(parsed.order_id) !== orderId) continue;
          const posId = parsed.new_position_id !== undefined ? String(parsed.new_position_id) : null;
          if (posId) return posId;
        }
      }
    }

    return null;
  }

  static async resolvePositionIdFromOrderId(client: SuiJsonRpcClient, walletAddress: string, orderId: string): Promise<string | null> {
    try {
      let cursor: any = null;
      for (let page = 0; page < 15; page++) {
        const query: any = {
          query: { MoveEventType: `${PERP_TRADING_PACKAGE}::position::OrderFilledEvent` },
          limit: 50,
          order: "descending",
        };
        if (cursor) query.cursor = cursor;
        const evtResult = await client.queryEvents(query);
        if (!evtResult?.data?.length) break;

        for (const evt of evtResult.data) {
          const parsed = (evt as any).parsedJson;
          if (!parsed) continue;
          if (String(parsed.order_id) !== orderId) continue;
          if (parsed.user && String(parsed.user) !== walletAddress) continue;

          if (parsed.new_position_id !== undefined && parsed.new_position_id !== null) {
            console.log(`[TypusAdapter] resolvePositionIdFromOrderId: found fill for order_id=${orderId} → position_id=${parsed.new_position_id}`);
            return String(parsed.new_position_id);
          }
        }

        if (!evtResult.hasNextPage || !evtResult.nextCursor) break;
        cursor = evtResult.nextCursor;
      }

      const queries = [
        client.queryTransactionBlocks({
          filter: { ToAddress: walletAddress },
          options: { showEvents: true },
          limit: 25,
          order: "descending" as any,
        }),
        client.queryTransactionBlocks({
          filter: { FromAddress: walletAddress },
          options: { showEvents: true },
          limit: 25,
          order: "descending" as any,
        }),
      ];

      const results = await Promise.all(queries);
      for (const recentTxs of results) {
        if (!recentTxs?.data) continue;
        for (const txBlock of recentTxs.data) {
          const events = (txBlock as any).events;
          if (!events) continue;
          for (const evt of events) {
            const parsed = (evt as any).parsedJson;
            if (!parsed) continue;
            const evtType = (evt as any).type || "";
            if (evtType.includes("OrderFilledEvent") && String(parsed.order_id) === orderId) {
              if (parsed.new_position_id !== undefined) {
                return String(parsed.new_position_id);
              }
            }
          }
        }
      }
    } catch (err: any) {
      console.log(`[TypusAdapter] resolvePositionIdFromOrderId failed for order_id=${orderId}: ${err.message}`);
    }
    return null;
  }

  async getPositions(walletAddress: string): Promise<DexPositionInfo[]> {
    if (!walletAddress || !walletAddress.startsWith("0x") || walletAddress.length < 20) {
      throw new Error(`getPositions called with invalid wallet address: ${walletAddress?.slice(0, 20)}... — expected 0x-prefixed address`);
    }
    try {
      const openPositions = new Map<string, { positionId: string; side: "long" | "short"; size: number; entryPrice: number; collateral: number; orderId: string }>();
      const closedPositionIds = new Set<string>();
      const filledOrderIds = new Set<string>();
      const cancelledOrderIds = new Set<string>();

      let fillCursor: any = null;
      for (let page = 0; page < 30; page++) {
        const query: any = {
          query: { MoveEventType: `${PERP_TRADING_PACKAGE}::position::OrderFilledEvent` },
          limit: 50,
          order: "descending",
        };
        if (fillCursor) query.cursor = fillCursor;
        const evtResult = await this.client.queryEvents(query);
        if (!evtResult?.data?.length) break;

        for (const evt of evtResult.data) {
          const p = (evt as any).parsedJson;
          if (!p) continue;
          if (p.user && String(p.user) !== walletAddress) continue;

          if (p.order_id !== undefined) filledOrderIds.add(String(p.order_id));

          const isCloseEvent = p.reduce_only === true || p.is_reduce_only === true ||
            (p.new_position_id === undefined || p.new_position_id === null || String(p.new_position_id) === "0");

          if (isCloseEvent && p.linked_position_id) {
            closedPositionIds.add(String(p.linked_position_id));
          } else if (p.new_position_id && String(p.new_position_id) !== "0") {
            const posId = String(p.new_position_id);
            if (!openPositions.has(posId)) {
              const isLong = p.is_long === true || p.direction === "long" || p.direction === 1 || p.direction === "1";
              openPositions.set(posId, {
                positionId: posId,
                side: isLong ? "long" : "short",
                size: Number(p.size || p.position_size || 0) / MIST_PER_SUI,
                entryPrice: Number(p.filled_price || 0) / 1e8,
                collateral: Number(p.collateral || 0) / MIST_PER_SUI,
                orderId: String(p.order_id || ""),
              });
            }
          }
        }

        if (!evtResult.hasNextPage || !evtResult.nextCursor) break;
        fillCursor = evtResult.nextCursor;
      }

      let liqCursor: any = null;
      for (let page = 0; page < 15; page++) {
        const query: any = {
          query: { MoveEventType: `${PERP_TRADING_PACKAGE}::position::LiquidateEvent` },
          limit: 50,
          order: "descending",
        };
        if (liqCursor) query.cursor = liqCursor;
        try {
          const evtResult = await this.client.queryEvents(query);
          if (!evtResult?.data?.length) break;

          for (const evt of evtResult.data) {
            const p = (evt as any).parsedJson;
            if (!p) continue;
            if (p.user && String(p.user) !== walletAddress) continue;
            if (p.position_id) {
              closedPositionIds.add(String(p.position_id));
            }
          }

          if (!evtResult.hasNextPage || !evtResult.nextCursor) break;
          liqCursor = evtResult.nextCursor;
        } catch {
          break;
        }
      }

      const [fromTxs, toTxs] = await Promise.all([
        this.paginatedTxScan(walletAddress, "from"),
        this.paginatedTxScan(walletAddress, "to"),
      ]);

      const createdOrders = new Map<string, { isLong: boolean; collateral: number; size: number; entryPrice: number; orderId: string }>();
      for (const tx of [...fromTxs, ...toTxs]) {
        for (const evt of (tx.events || [])) {
          const p = (evt as any).parsedJson;
          if (!p) continue;
          const t = (evt as any).type || "";
          if (t.includes("CreateTradingOrderEvent") && p.order_id !== undefined) {
            const oid = String(p.order_id);
            if (!p.reduce_only && !createdOrders.has(oid)) {
              createdOrders.set(oid, {
                isLong: p.is_long === true,
                collateral: Number(p.collateral_amount || p.collateral || 0) / MIST_PER_SUI,
                size: Number(p.size || 0) / MIST_PER_SUI,
                entryPrice: Number(p.trading_pair_oracle_price || 0) / 1e8,
                orderId: oid,
              });
            }
          }
          if (t.includes("OrderFilledEvent") && p.order_id !== undefined) filledOrderIds.add(String(p.order_id));
          if (t.includes("CancelTradingOrderEvent") && p.order_id !== undefined) cancelledOrderIds.add(String(p.order_id));
        }
      }

      let unresolvedCount = 0;
      for (const [oid, orderInfo] of createdOrders) {
        if (filledOrderIds.has(oid) || cancelledOrderIds.has(oid)) continue;

        const alreadyTracked = [...openPositions.values()].some(p => p.orderId === oid);
        if (alreadyTracked) continue;

        const hasCancelFailures = fromTxs.some(tx => {
          const status = tx.effects?.status?.status;
          if (status !== "failure") return false;
          const errStr = tx.effects?.status?.error || "";
          if (!errStr.includes("order_not_found")) return false;
          const inputData = JSON.stringify(tx.transaction?.data || "");
          return inputData.includes("cancel_trading_order");
        });

        if (hasCancelFailures) {
          console.log(`[TypusAdapter] getPositions FALLBACK: order ${oid} was filled by keeper (cancel fails with order_not_found) but fill event not found in global query. Order was ${orderInfo.isLong ? "LONG" : "SHORT"} with ${orderInfo.collateral.toFixed(4)} SUI collateral.`);
          unresolvedCount++;
        } else {
          console.log(`[TypusAdapter] getPositions: order ${oid} status unknown — not in fill/cancel events, no cancel failures detected. May be pending.`);
        }
      }

      for (const closedId of closedPositionIds) {
        openPositions.delete(closedId);
      }

      const result: DexPositionInfo[] = [];
      for (const [, pos] of openPositions) {
        result.push({
          positionId: pos.positionId,
          symbol: "SUI-PERP",
          side: pos.side,
          size: pos.size,
          entryPrice: pos.entryPrice,
          markPrice: pos.entryPrice,
          unrealizedPnl: 0,
          leverage: 30,
        });
      }

      console.log(`[TypusAdapter] getPositions(${walletAddress.slice(0, 10)}): ${result.length} open via event query (${openPositions.size} fills, ${closedPositionIds.size} closes/liqs, ${createdOrders.size} created orders, ${unresolvedCount} unresolved fills)`);
      return result;
    } catch (err: any) {
      console.log(`[TypusAdapter] getPositions failed: ${err.message}`);
      return [];
    }
  }

  async getBalance(walletAddress: string): Promise<DexBalanceInfo> {
    try {
      const balance = await this.client.getBalance({ owner: walletAddress, coinType: SUI_COIN_TYPE });
      const available = Number(balance.totalBalance) / MIST_PER_SUI;
      return { available, locked: 0, total: available };
    } catch {
      return { available: 0, locked: 0, total: 0 };
    }
  }

  async estimateFees(params: DexOrderParams): Promise<DexFeeEstimate> {
    return { tradingFee: 0, gasFee: 0.05, total: 0.05 };
  }

  async validateOrder(params: DexOrderParams): Promise<{ valid: boolean; reason?: string }> {
    if (params.leverage < 1 || params.leverage > 50) return { valid: false, reason: "Leverage must be 1-50x" };
    if (params.quantity < 10) return { valid: false, reason: `Position size ${params.quantity.toFixed(4)} SUI below minimum 10 SUI` };
    if (params.agent.balance <= 0) return { valid: false, reason: "Agent has no balance — deposit SUI first" };
    const posCount = (params.openPositionCount || 0) + 1;
    const dynamicReserve = BASE_GAS_RESERVE_SUI + (posCount * GAS_PER_CLOSE_SUI);
    const usable = params.agent.balance - dynamicReserve;
    if (usable <= 0) return { valid: false, reason: `Balance ${params.agent.balance.toFixed(4)} SUI too low to cover gas reserve (${dynamicReserve.toFixed(2)} SUI for ${posCount} positions)` };
    const collateralNeeded = params.quantity / params.leverage;
    if (collateralNeeded > usable) {
      return { valid: false, reason: `Collateral ${collateralNeeded.toFixed(4)} SUI exceeds usable balance ${usable.toFixed(4)} SUI (after ${dynamicReserve.toFixed(2)} gas reserve for ${posCount} positions)` };
    }
    return { valid: true };
  }
}
