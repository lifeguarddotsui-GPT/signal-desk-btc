import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import type { DexAdapter, DexOrderParams, DexCloseParams, DexOrderResult, DexPositionInfo, DexBalanceInfo, DexFeeEstimate } from "./types";
import { decryptKeypair } from "./wallet-manager";
import { withWalletLock } from "./tx-queue";
import { signAndExecuteSafe } from "./safe-execute";

const SUI_RPC = "https://fullnode.mainnet.sui.io:443";

const PYTH_HERMES_URL = "https://hermes.pyth.network";
const PYTH_SUI_FEED_ID = "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744";

const PERP_PACKAGE_ID = "0xf60e3542f1c65a77d9bcdffd5d8a712a46b935ec51b9052e5ad98888e0392d09";
const PERP_VERSION = "0x7c30204bd3f4dc37918281907308e0d7d09a75a6826473aec0caa1712ee149e5";
const MARKET_REGISTRY = "0x327c8a176055400e9aacde8553a897898b5da969d6dcdb55eee268bb501a2c3a";
const LP_POOL_REGISTRY = "0x46ef530d3ad13037ac54b77be324e5ab063124af8a119e86f1f59be8a16a22a2";
const SUI_COIN_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

const TYPUS_ORACLE_PACKAGE = "0xfc9b05223195de2f134c84c2299c5ff3f2b51725b8ba821f46975da1264ace73";
const TYPUS_ORACLE_SUI = "0xeb6b3e3300ff884604ead6172b0aeadee3854980cab65a7feb57300b04b74cc1";
const CLOCK_ID = "0x6";

const PYTH_STATE_ID = "0x1f9310238ee9298fb703c3419030b35b22bb1cc37113e3bb5007c99aec79e5b8";
const PYTH_SUI_USD_PRICE_INFO_OBJECT = "0x801dbc2f0053d34734814b2d6df491ce7807a725fe9a01ad74a07e9c51396c37";

const ALLOWED_TARGETS = new Set([
  `${PERP_PACKAGE_ID}::trading::create_trading_order`,
  `${TYPUS_ORACLE_PACKAGE}::oracle::update_with_pyth_usd`,
  "0x2::coin::zero",
]);

const SUI_MARKET_INDEX = 0;
const SUI_POOL_INDEX = 0;

const MIST_PER_SUI = 1_000_000_000;
const TYPUS_ORACLE_DECIMALS = 8;
const GAS_BUDGET_MIST = 50_000_000;
const GAS_RESERVE_SUI = 0.10;
const SLIPPAGE_BPS = BigInt(300);
const BPS_BASE = BigInt(10000);

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

export class TypusAdapter implements DexAdapter {
  readonly venue = "typus";
  readonly supported = true;
  readonly description = "Typus Perps - On-chain perpetual trading on SUI with Pyth oracle pricing and up to 50x leverage";
  private client: SuiJsonRpcClient;

  private consecutiveFailures = new Map<string, { count: number; lastError: string }>();
  private static readonly CIRCUIT_BREAKER_THRESHOLD = 3;

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

  private addPythOracleUpdateToTx(tx: Transaction): void {
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
  }

  getCircuitBreakerStatus(agentId: string): { tripped: boolean; count: number; lastError: string } {
    const record = this.consecutiveFailures.get(agentId);
    if (!record) return { tripped: false, count: 0, lastError: "" };
    return {
      tripped: record.count >= TypusAdapter.CIRCUIT_BREAKER_THRESHOLD,
      count: record.count,
      lastError: record.lastError,
    };
  }

  resetCircuitBreaker(agentId: string): void {
    this.consecutiveFailures.delete(agentId);
  }

  private recordFailure(agentId: string, error: string): void {
    const record = this.consecutiveFailures.get(agentId) || { count: 0, lastError: "" };
    record.count += 1;
    record.lastError = error;
    this.consecutiveFailures.set(agentId, record);
  }

  private recordSuccess(agentId: string): void {
    this.consecutiveFailures.delete(agentId);
  }

  private checkCircuitBreaker(agentId: string): string | null {
    const status = this.getCircuitBreakerStatus(agentId);
    if (status.tripped) {
      return `Circuit breaker tripped after ${status.count} consecutive failures. Last error: ${status.lastError}. Agent paused to prevent wallet drain. Reset manually to retry.`;
    }
    return null;
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
      const collateralSui = (params.quantity * freshPrice) / params.leverage;
      const totalNeeded = collateralSui + GAS_RESERVE_SUI;
      if (totalNeeded > params.agent.balance) {
        return {
          success: false,
          error: `Collateral (${collateralSui.toFixed(4)}) + gas (${GAS_RESERVE_SUI.toFixed(4)}) = ${totalNeeded.toFixed(4)} SUI exceeds balance ${params.agent.balance.toFixed(4)} SUI — reduce position size`,
          venue: this.venue,
        };
      }
      const collateralMist = suiToMist(collateralSui);
      const sizeUnits = toSizeUnits(params.quantity);

      const oraclePriceBigInt = toOraclePriceUnits(freshPrice);
      const triggerPrice = applySlippage(oraclePriceBigInt, isLong, SLIPPAGE_BPS);

      const diffBps = ((triggerPrice - oraclePriceBigInt) * BigInt(10000)) / oraclePriceBigInt;
      console.log(`[TypusAdapter] OPEN ${isLong ? "LONG" : "SHORT"} | Pyth: $${freshPrice.toFixed(6)} | oracle(8dec): ${oraclePriceBigInt} | trigger: ${triggerPrice} | diff: ${diffBps}bps | age: ${oracleAge}s | qty: ${params.quantity.toFixed(4)} | lev: ${params.leverage}x`);

      const self = this;
      const result = await withWalletLock(walletAddress, async () => {
        const res = await signAndExecuteSafe({
          client: self.client,
          signer: keypair,
          owner: walletAddress,
          gasBudget: GAS_BUDGET_MIST,
          allowedTargets: ALLOWED_TARGETS,
          buildTx: async (tx) => {
            self.addPythOracleUpdateToTx(tx);

            const [collateralCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(collateralMist)]);

            tx.moveCall({
              target: `${PERP_PACKAGE_ID}::trading::create_trading_order`,
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
                tx.pure.bool(isLong),
                tx.pure.bool(false),
                tx.pure.bool(false),
                tx.pure.u64(sizeUnits),
                tx.pure.u64(triggerPrice),
              ],
            });
          },
          dryRun: true,
        });
        return res;
      });

      if (result.effects?.status?.status === "success") {
        this.recordSuccess(params.agent.id);
        console.log(`[TypusAdapter] Trade SUCCESS: ${result.digest}`);
        return { success: true, txDigest: result.digest, venue: this.venue };
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

      const oraclePriceBigInt = toOraclePriceUnits(pythPrice.price);
      const triggerPrice = applySlippage(oraclePriceBigInt, false, SLIPPAGE_BPS);

      console.log(`[TypusAdapter] CLOSE | Pyth: $${pythPrice.price.toFixed(6)} | oracle(8dec): ${oraclePriceBigInt} | trigger: ${triggerPrice} | age: ${oracleAge}s`);

      const self = this;
      const result = await withWalletLock(walletAddress, async () => {
        const res = await signAndExecuteSafe({
          client: self.client,
          signer: keypair,
          owner: walletAddress,
          gasBudget: GAS_BUDGET_MIST,
          allowedTargets: ALLOWED_TARGETS,
          buildTx: async (tx) => {
            self.addPythOracleUpdateToTx(tx);

            const zeroCoin = tx.moveCall({ target: "0x2::coin::zero", typeArguments: [SUI_COIN_TYPE] });

            tx.moveCall({
              target: `${PERP_PACKAGE_ID}::trading::create_trading_order`,
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
                zeroCoin,
                tx.pure.bool(false),
                tx.pure.bool(true),
                tx.pure.bool(true),
                tx.pure.u64(sizeUnits),
                tx.pure.u64(triggerPrice),
              ],
            });
          },
          dryRun: true,
        });
        return res;
      });

      if (result.effects?.status?.status === "success") {
        this.recordSuccess(params.agent.id);
      } else {
        this.recordFailure(params.agent.id, result.effects?.status?.error || "Close failed");
      }
      return { success: result.effects?.status?.status === "success", txDigest: result.digest, venue: this.venue };
    } catch (error: any) {
      this.recordFailure(params.agent.id, error.message);
      return { success: false, error: error.message, venue: this.venue };
    }
  }

  async getPositions(walletAddress: string): Promise<DexPositionInfo[]> {
    return [];
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
    if (params.agent.balance <= 0) return { valid: false, reason: "Agent has no balance — deposit SUI first" };
    const usable = params.agent.balance - GAS_RESERVE_SUI;
    if (usable <= 0) return { valid: false, reason: `Balance ${params.agent.balance.toFixed(4)} SUI too low to cover gas reserve (${GAS_RESERVE_SUI.toFixed(2)} SUI)` };
    const collateralNeeded = (params.quantity * params.price) / params.leverage;
    if (collateralNeeded > usable) {
      return { valid: false, reason: `Collateral ${collateralNeeded.toFixed(4)} SUI exceeds usable balance ${usable.toFixed(4)} SUI (after ${GAS_RESERVE_SUI.toFixed(2)} gas reserve)` };
    }
    return { valid: true };
  }
}
