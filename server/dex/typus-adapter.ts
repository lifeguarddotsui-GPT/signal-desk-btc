import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { SuiPythClient, SuiPriceServiceConnection } from "@pythnetwork/pyth-sui-js";
import type { DexAdapter, DexOrderParams, DexCloseParams, DexOrderResult, DexPositionInfo, DexBalanceInfo, DexFeeEstimate } from "./types";
import { decryptKeypair } from "./wallet-manager";

const SUI_RPC = "https://fullnode.mainnet.sui.io:443";
const SUI_PRICE_FEED_ID = "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744";

const PERP_PACKAGE_ID = "0xf60e3542f1c65a77d9bcdffd5d8a712a46b935ec51b9052e5ad98888e0392d09";
const PERP_VERSION = "0x7c30204bd3f4dc37918281907308e0d7d09a75a6826473aec0caa1712ee149e5";
const MARKET_REGISTRY = "0x327c8a176055400e9aacde8553a897898b5da969d6dcdb55eee268bb501a2c3a";
const LP_POOL_REGISTRY = "0x46ef530d3ad13037ac54b77be324e5ab063124af8a119e86f1f59be8a16a22a2";
const SUI_COIN_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

const PYTH_STATE_ID = "0x1f9310238ee9298fb703c3419030b35b22bb1cc37113e3bb5007c99aec79e5b8";
const PYTH_WORMHOLE_STATE_ID = "0xaeab97f96cf9877fee2883315d459552b2b921edc16d7ceac6eab944dd88919c";

const TYPUS_ORACLE_PACKAGE = "0xfc9b05223195de2f134c84c2299c5ff3f2b51725b8ba821f46975da1264ace73";
const TYPUS_ORACLE_SUI = "0xeb6b3e3300ff884604ead6172b0aeadee3854980cab65a7feb57300b04b74cc1";
const PYTH_PRICE_INFO_SUI = "0x801dbc2f0053d34734814b2d6df491ce7807a725fe9a01ad74a07e9c51396c37";
const CLOCK_ID = "0x6";

const SUI_MARKET_INDEX = 0;
const SUI_POOL_INDEX = 0;

const MIST_PER_SUI = 1_000_000_000;
const TYPUS_SIZE_DECIMALS = 9;
const TYPUS_PRICE_DECIMALS = 9;
const GAS_BUDGET_MIST = 100_000_000;
const GAS_RESERVE_SUI = GAS_BUDGET_MIST / MIST_PER_SUI + 0.05;

function suiToMist(sui: number): bigint {
  return BigInt(Math.floor(sui * MIST_PER_SUI));
}

function toSizeUnits(quantity: number): bigint {
  return BigInt(Math.floor(quantity * Math.pow(10, TYPUS_SIZE_DECIMALS)));
}

function toPriceUnits(price: number): bigint {
  return BigInt(Math.floor(price * Math.pow(10, TYPUS_PRICE_DECIMALS)));
}

export class TypusAdapter implements DexAdapter {
  readonly venue = "typus";
  readonly supported = true;
  readonly description = "Typus Perps - On-chain perpetual trading on SUI with Pyth oracle pricing and up to 50x leverage";
  private client: SuiJsonRpcClient;
  private pythClient: SuiPythClient;
  private priceService: SuiPriceServiceConnection;

  isReady(): boolean {
    return true;
  }

  constructor() {
    this.client = new SuiJsonRpcClient({ url: SUI_RPC, network: "mainnet" });
    this.pythClient = new SuiPythClient(
      this.client as any,
      PYTH_STATE_ID,
      PYTH_WORMHOLE_STATE_ID
    );
    this.priceService = new SuiPriceServiceConnection("https://hermes.pyth.network");
  }

  private async updatePythAndTypusOracle(tx: Transaction): Promise<void> {
    const priceUpdateData = await this.priceService.getPriceFeedsUpdateData([SUI_PRICE_FEED_ID]);
    if (!priceUpdateData || priceUpdateData.length === 0) {
      throw new Error("Pyth Hermes returned no price update data for SUI feed");
    }

    await this.pythClient.updatePriceFeeds(tx as any, priceUpdateData, [SUI_PRICE_FEED_ID]);

    tx.moveCall({
      target: `${TYPUS_ORACLE_PACKAGE}::oracle::update_with_pyth_usd`,
      typeArguments: [],
      arguments: [
        tx.object(TYPUS_ORACLE_SUI),
        tx.object(PYTH_STATE_ID),
        tx.object(PYTH_PRICE_INFO_SUI),
        tx.object(CLOCK_ID),
      ],
    });
  }

  async openPosition(params: DexOrderParams): Promise<DexOrderResult> {
    try {
      const validation = await this.validateOrder(params);
      if (!validation.valid) {
        return { success: false, error: validation.reason, venue: this.venue };
      }

      if (!params.agent.agentWallet) {
        return { success: false, error: "Agent wallet not configured", venue: this.venue };
      }

      const keypair = decryptKeypair(params.agent.agentWallet);
      const walletAddress = keypair.toSuiAddress();
      const isLong = params.side === "long";

      const collateralSui = (params.quantity * params.price) / params.leverage;
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
      const triggerPrice = toPriceUnits(params.price);

      const allCoins = await this.client.getCoins({ owner: walletAddress, coinType: SUI_COIN_TYPE });
      const coinObjects = (allCoins.data || []).sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)));

      if (coinObjects.length === 0) {
        return { success: false, error: "No SUI coins found in agent wallet", venue: this.venue };
      }

      const tx = new Transaction();
      tx.setGasPayment(coinObjects.map(c => ({
        objectId: c.coinObjectId,
        version: c.version,
        digest: c.digest,
      })));

      await this.updatePythAndTypusOracle(tx);

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

      tx.setGasBudget(GAS_BUDGET_MIST);

      const result = await this.client.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
        options: { showEffects: true, showEvents: true },
      });

      if (result.effects?.status?.status === "success") {
        return { success: true, txDigest: result.digest, venue: this.venue };
      } else {
        return { success: false, error: result.effects?.status?.error || "Transaction failed", venue: this.venue };
      }
    } catch (error: any) {
      return { success: false, error: error.message, venue: this.venue };
    }
  }

  async closePosition(params: DexCloseParams): Promise<DexOrderResult> {
    try {
      if (!params.agent.agentWallet) {
        return { success: false, error: "Agent wallet not configured", venue: this.venue };
      }
      const keypair = decryptKeypair(params.agent.agentWallet);
      const walletAddress = keypair.toSuiAddress();
      const sizeUnits = toSizeUnits(params.quantity || 0);
      const triggerPrice = toPriceUnits(params.price);

      const allCoins = await this.client.getCoins({ owner: walletAddress, coinType: SUI_COIN_TYPE });
      const coinObjects = (allCoins.data || []).sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)));

      if (coinObjects.length === 0) {
        return { success: false, error: "No SUI coins found in agent wallet for gas", venue: this.venue };
      }

      const tx = new Transaction();
      tx.setGasPayment(coinObjects.map(c => ({
        objectId: c.coinObjectId,
        version: c.version,
        digest: c.digest,
      })));

      await this.updatePythAndTypusOracle(tx);

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

      tx.setGasBudget(GAS_BUDGET_MIST);
      const result = await this.client.signAndExecuteTransaction({ transaction: tx, signer: keypair, options: { showEffects: true } });
      return { success: result.effects?.status?.status === "success", txDigest: result.digest, venue: this.venue };
    } catch (error: any) {
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
