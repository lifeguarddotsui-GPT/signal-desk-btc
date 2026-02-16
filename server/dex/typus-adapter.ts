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
const PERP_VERSION = "0x7c30204bd3f4dc37918281907308e0d7d09a75a6826473aec0caa1712ee149e5";
const MARKET_REGISTRY = "0x327c8a176055400e9aacde8553a897898b5da969d6dcdb55eee268bb501a2c3a";
const LP_POOL_REGISTRY = "0x46ef530d3ad13037ac54b77be324e5ab063124af8a119e86f1f59be8a16a22a2";
const SUI_COIN_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

const TYPUS_ORACLE_PACKAGE = "0xfc9b05223195de2f134c84c2299c5ff3f2b51725b8ba821f46975da1264ace73";
const TYPUS_ORACLE_SUI = "0x0a318f26fcf35922a8671a2d843872a7a25ac10b678bdee52f10fbc77140c0d0";
const CLOCK_ID = "0x6";

const PYTH_STATE_ID = "0x1f9310238ee9298fb703c3419030b35b22bb1cc37113e3bb5007c99aec79e5b8";
const WORMHOLE_STATE_ID = "0xaeab97f96cf9877fee2883315d459552b2b921edc16d7ceac6eab944dd88919c";
const PYTH_SUI_USD_PRICE_INFO_OBJECT = "0x801dbc2f0053d34734814b2d6df491ce7807a725fe9a01ad74a07e9c51396c37";

const SUI_MARKET_INDEX = 0;
const SUI_POOL_INDEX = 0;

const MIST_PER_SUI = 1_000_000_000;
const TYPUS_ORACLE_DECIMALS = 8;
const GAS_BUDGET_MIST = 50_000_000;
const BASE_GAS_RESERVE_SUI = 0.10;
const GAS_PER_CLOSE_SUI = 0.05;
const SLIPPAGE_BPS = BigInt(500);
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

function applySlippage(price: bigint, isLong: boolean, slippageBps: bigint): bigint {
  return isLong
    ? (price * (BPS_BASE + slippageBps)) / BPS_BASE
    : (price * (BPS_BASE - slippageBps)) / BPS_BASE;
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
      if (totalNeeded > params.agent.balance) {
        return {
          success: false,
          error: `Collateral (${collateralSui.toFixed(4)}) + gas reserve (${dynamicReserve.toFixed(4)}) = ${totalNeeded.toFixed(4)} SUI exceeds balance ${params.agent.balance.toFixed(4)} SUI — reduce position size`,
          venue: this.venue,
        };
      }
      const collateralMist = suiToMist(collateralSui);
      const sizeUnits = toSizeUnits(params.quantity);

      const oraclePriceBigInt = toOraclePriceUnits(freshPrice);
      const triggerPrice = applySlippage(oraclePriceBigInt, isLong, SLIPPAGE_BPS);

      if (sizeUnits < SUI_PERP_MIN_SIZE_UNITS) {
        return {
          success: false,
          error: `Position size ${params.quantity.toFixed(4)} SUI below minimum 10 SUI (lot_size=1 SUI)`,
          venue: this.venue,
        };
      }

      const diffBps = ((triggerPrice - oraclePriceBigInt) * BigInt(10000)) / oraclePriceBigInt;
      const effectiveLev = params.quantity / collateralSui;
      console.log(`[TypusAdapter] OPEN ${isLong ? "LONG" : "SHORT"} | Pyth: $${freshPrice.toFixed(6)} | oracle(8dec): ${oraclePriceBigInt} | trigger: ${triggerPrice} | diff: ${diffBps}bps | age: ${oracleAge}s | qty: ${params.quantity.toFixed(4)} SUI | collateral: ${collateralSui.toFixed(4)} SUI | configured_lev: ${params.leverage}x | effective_lev: ${effectiveLev.toFixed(2)}x | pkg: ${PERP_TRADING_PACKAGE.slice(0,10)} | oracle: SUI×2`);

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
                tx.pure.bool(false),
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
        if (result.events) {
          for (const evt of result.events) {
            const parsed = evt.parsedJson as any;
            if (!parsed) continue;
            
            if (evt.type.includes("CreateTradingOrderEvent")) {
              console.log(`[TypusAdapter] CreateTradingOrderEvent: order_id=${parsed.order_id}, linked_position_id=${parsed.linked_position_id}, filled=${parsed.filled}`);
              if (parsed.linked_position_id) {
                onChainPositionId = String(parsed.linked_position_id);
              } else if (parsed.order_id !== undefined) {
                onChainPositionId = String(parsed.order_id);
              }
            }
            
            if (evt.type.includes("FillTradingOrderEvent") || evt.type.includes("PositionChangeEvent")) {
              console.log(`[TypusAdapter] ${evt.type.split("::").pop()}: position_id=${parsed.position_id}, order_id=${parsed.order_id}`);
              if (parsed.position_id && !onChainPositionId) {
                onChainPositionId = String(parsed.position_id);
              }
            }
          }
          
          if (!onChainPositionId) {
            console.log(`[TypusAdapter] WARNING: No position ID found in ${result.events.length} events. Event types: ${result.events.map(e => e.type.split("::").pop()).join(", ")}`);
          }
        }

        return { 
          success: true, 
          txDigest: result.digest, 
          venue: this.venue,
          positionId: onChainPositionId
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

  async closePosition(params: DexCloseParams): Promise<DexOrderResult> {
    try {
      const cbError = this.checkCircuitBreaker(params.agent.id);
      if (cbError) {
        return { success: false, error: cbError, venue: this.venue };
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
        const errMsg = `Pyth oracle price too stale (${oracleAge}s old). Skipping close.`;
        this.recordFailure(params.agent.id, errMsg);
        return { success: false, error: errMsg, venue: this.venue };
      }

      const keypair = decryptKeypair(params.agent.agentWallet);
      const walletAddress = keypair.toSuiAddress();
      const sizeUnits = toSizeUnits(params.quantity || 0);
      const isLong = params.side === "long";

      const oraclePriceBigInt = toOraclePriceUnits(pythPrice.price);
      const triggerPrice = applySlippage(oraclePriceBigInt, !isLong, SLIPPAGE_BPS);

      const isOnChainId = params.positionId && !params.positionId.includes("-");
      const linkedPositionId = isOnChainId ? BigInt(params.positionId) : null;

      if (!linkedPositionId) {
        const errMsg = `Cannot close position: no on-chain positionId available (got UUID: ${params.positionId}). Position may need manual reconciliation.`;
        console.log(`[TypusAdapter] CLOSE REJECTED: ${errMsg}`);
        this.recordFailure(params.agent.id, errMsg);
        return { success: false, error: errMsg, venue: this.venue };
      }

      console.log(`[TypusAdapter] CLOSE ${isLong ? "LONG" : "SHORT"} | posId: ${params.positionId} | linkedId: ${linkedPositionId} | Pyth: $${pythPrice.price.toFixed(6)} | oracle(8dec): ${oraclePriceBigInt} | trigger: ${triggerPrice} | age: ${oracleAge}s | oracle: SUI×2`);

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
                tx.pure.bool(false),
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
      } else {
        this.recordFailure(params.agent.id, result.effects?.status?.error || "Close failed");
      }
      return { 
        success: result.effects?.status?.status === "success", 
        txDigest: result.digest, 
        venue: this.venue,
        positionId: params.positionId
      };
    } catch (error: any) {
      this.recordFailure(params.agent.id, error.message);
      return { success: false, error: error.message, venue: this.venue };
    }
  }

  async getPositions(walletAddress: string): Promise<DexPositionInfo[]> {
    try {
      // Best effort to find existing positions on Typus
      // In a real production app we'd query the MarginAccount object
      // For now, we return empty to avoid breaking the interface, but the positionId logic above handles new trades
      return [];
    } catch {
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
