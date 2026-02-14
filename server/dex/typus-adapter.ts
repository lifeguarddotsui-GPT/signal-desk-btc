import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import type { DexAdapter, DexOrderParams, DexCloseParams, DexOrderResult, DexPositionInfo, DexBalanceInfo, DexFeeEstimate } from "./types";
import { decryptKeypair } from "./wallet-manager";

const SUI_RPC = "https://fullnode.mainnet.sui.io:443";

const PERP_PACKAGE_ID = "0xf60e3542f1c65a77d9bcdffd5d8a712a46b935ec51b9052e5ad98888e0392d09";

const PERP_VERSION = "0x7c30204bd3f4dc37918281907308e0d7d09a75a6826473aec0caa1712ee149e5";
const MARKET_REGISTRY = "0x327c8a176055400e9aacde8553a897898b5da969d6dcdb55eee268bb501a2c3a";
const LP_POOL_REGISTRY = "0x46ef530d3ad13037ac54b77be324e5ab063124af8a119e86f1f59be8a16a22a2";
const COMPETITION_CONFIG = "0xe896530a778adedc1b38e4fc31059a6557146caa7b1da56950b671a433de5f08";
const CLOCK_ID = "0x6";

const SUI_COIN_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

const SUI_MARKET_INDEX = 0;
const SUI_POOL_INDEX = 0;

const MIST_PER_SUI = 1_000_000_000;
const TYPUS_SIZE_DECIMALS = 9;
const TYPUS_PRICE_DECIMALS = 9;

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
  readonly description = "Typus Perps - On-chain perpetual trading on SUI with Pyth oracle pricing and up to 100x leverage";
  private client: SuiJsonRpcClient;

  isReady(): boolean {
    return true;
  }

  constructor() {
    this.client = new SuiJsonRpcClient({ url: SUI_RPC, network: "mainnet" });
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
      const isLong = params.side === "long";

      const collateralSui = (params.quantity * params.price) / params.leverage;
      const collateralMist = suiToMist(collateralSui);

      const sizeUnits = toSizeUnits(params.quantity);
      const triggerPrice = toPriceUnits(params.price);
      const leverageMbp = BigInt(params.leverage * 10000);

      const tx = new Transaction();

      const [collateralCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(collateralMist)]);

      tx.moveCall({
        target: `${PERP_PACKAGE_ID}::trading::create_trading_order`,
        typeArguments: [SUI_COIN_TYPE, SUI_COIN_TYPE],
        arguments: [
          tx.object(PERP_VERSION),
          tx.object(MARKET_REGISTRY),
          tx.object(LP_POOL_REGISTRY),
          tx.pure.u64(SUI_MARKET_INDEX),
          tx.pure.u64(SUI_POOL_INDEX),
          tx.object(CLOCK_ID),
          collateralCoin,
          tx.pure.u64(sizeUnits),
          tx.pure.u64(triggerPrice),
          tx.pure.bool(isLong),
          tx.pure.bool(false),
          tx.pure.bool(false),
          tx.pure.option("u64", null),
        ],
      });

      tx.setGasBudget(100_000_000);

      console.log(`[Typus] Submitting create_trading_order: ${params.side} ${params.quantity} SUI @ $${params.price} (${params.leverage}x)`);

      const result = await this.client.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
        options: { showEffects: true, showEvents: true },
      });

      const txDigest = result.digest;
      const status = result.effects?.status?.status;

      if (status === "success") {
        let orderId = txDigest;
        if (result.events?.length) {
          for (const event of result.events) {
            if (event.type?.includes("CreateTradingOrderEvent")) {
              const parsed = event.parsedJson as any;
              if (parsed?.order_id) {
                orderId = String(parsed.order_id);
              }
            }
          }
        }

        console.log(`[Typus] Trading order created: ${txDigest} (orderId: ${orderId})`);
        return {
          success: true,
          txDigest,
          orderId,
          venue: this.venue,
        };
      } else {
        const errorMsg = result.effects?.status?.error || "Transaction failed";
        console.error(`[Typus] Transaction failed: ${errorMsg}`);
        return {
          success: false,
          error: `Typus on-chain tx failed: ${errorMsg}`,
          venue: this.venue,
        };
      }
    } catch (error: any) {
      console.error(`[Typus] Open position error: ${error.message}`);
      return {
        success: false,
        error: `Typus execution error: ${error.message}`,
        venue: this.venue,
      };
    }
  }

  async closePosition(params: DexCloseParams): Promise<DexOrderResult> {
    try {
      if (!params.agent.agentWallet) {
        return { success: false, error: "Agent wallet not configured", venue: this.venue };
      }

      const keypair = decryptKeypair(params.agent.agentWallet);

      const sizeUnits = toSizeUnits(params.quantity || 0);
      const triggerPrice = toPriceUnits(params.price);

      const tx = new Transaction();

      const zeroCoin = tx.moveCall({
        target: "0x2::coin::zero",
        typeArguments: [SUI_COIN_TYPE],
        arguments: [],
      });

      tx.moveCall({
        target: `${PERP_PACKAGE_ID}::trading::create_trading_order`,
        typeArguments: [SUI_COIN_TYPE, SUI_COIN_TYPE],
        arguments: [
          tx.object(PERP_VERSION),
          tx.object(MARKET_REGISTRY),
          tx.object(LP_POOL_REGISTRY),
          tx.pure.u64(SUI_MARKET_INDEX),
          tx.pure.u64(SUI_POOL_INDEX),
          tx.object(CLOCK_ID),
          zeroCoin,
          tx.pure.u64(sizeUnits),
          tx.pure.u64(triggerPrice),
          tx.pure.bool(false),
          tx.pure.bool(false),
          tx.pure.bool(true),
          tx.pure.option("u64", null),
        ],
      });

      tx.setGasBudget(100_000_000);

      console.log(`[Typus] Submitting close order for position ${params.positionId}`);

      const result = await this.client.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
        options: { showEffects: true, showEvents: true },
      });

      const txDigest = result.digest;
      const status = result.effects?.status?.status;

      if (status === "success") {
        console.log(`[Typus] Position close order created: ${txDigest}`);
        return {
          success: true,
          txDigest,
          venue: this.venue,
        };
      } else {
        const errorMsg = result.effects?.status?.error || "Transaction failed";
        console.error(`[Typus] Close transaction failed: ${errorMsg}`);
        return {
          success: false,
          error: `Typus close tx failed: ${errorMsg}`,
          venue: this.venue,
        };
      }
    } catch (error: any) {
      console.error(`[Typus] Close position error: ${error.message}`);
      return {
        success: false,
        error: `Typus close error: ${error.message}`,
        venue: this.venue,
      };
    }
  }

  async getPositions(walletAddress: string): Promise<DexPositionInfo[]> {
    try {
      const tx = new Transaction();

      tx.moveCall({
        target: `${PERP_PACKAGE_ID}::trading::get_user_positions`,
        arguments: [
          tx.object(PERP_VERSION),
          tx.object(MARKET_REGISTRY),
          tx.pure.u64(SUI_MARKET_INDEX),
          tx.pure.address(walletAddress),
        ],
      });

      const result = await this.client.devInspectTransactionBlock({
        sender: walletAddress,
        transactionBlock: tx,
      });

      if (!result.results?.length) return [];

      return [];
    } catch (error: any) {
      console.error(`[Typus] getPositions error: ${error.message}`);
      return [];
    }
  }

  async getBalance(walletAddress: string): Promise<DexBalanceInfo> {
    try {
      const balance = await this.client.getBalance({
        owner: walletAddress,
        coinType: SUI_COIN_TYPE,
      });

      const available = Number(balance.totalBalance) / MIST_PER_SUI;
      return { available, locked: 0, total: available };
    } catch {
      return { available: 0, locked: 0, total: 0 };
    }
  }

  async estimateFees(params: DexOrderParams): Promise<DexFeeEstimate> {
    const notionalValue = params.quantity * params.price;
    const tradingFee = notionalValue * 0.0005;
    const gasFee = 0.01;
    return { tradingFee, gasFee, total: tradingFee + gasFee };
  }

  async validateOrder(params: DexOrderParams): Promise<{ valid: boolean; reason?: string }> {
    if (params.leverage < 1 || params.leverage > 100) {
      return { valid: false, reason: "Leverage must be between 1x and 100x for Typus Perps" };
    }
    if (params.quantity <= 0) {
      return { valid: false, reason: "Quantity must be positive" };
    }
    const requiredCollateral = (params.quantity * params.price) / params.leverage;
    const totalNeeded = requiredCollateral + (requiredCollateral * 0.002) + 0.01;
    if (params.agent.balance < totalNeeded) {
      return {
        valid: false,
        reason: `Insufficient balance: need ~${totalNeeded.toFixed(4)} SUI (collateral + fees + gas), have ${params.agent.balance.toFixed(4)} SUI`,
      };
    }
    return { valid: true };
  }
}
