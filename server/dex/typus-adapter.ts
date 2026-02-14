import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import type { DexAdapter, DexOrderParams, DexCloseParams, DexOrderResult, DexPositionInfo, DexBalanceInfo, DexFeeEstimate } from "./types";
import { decryptKeypair } from "./wallet-manager";

const SUI_RPC = "https://fullnode.mainnet.sui.io:443";
const HERMES_URL = "https://hermes.pyth.network/v2/updates/price/latest";
const SUI_PRICE_FEED_ID = "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744";

const PERP_PACKAGE_ID = "0xf60e3542f1c65a77d9bcdffd5d8a712a46b935ec51b9052e5ad98888e0392d09";
const PERP_VERSION = "0x7c30204bd3f4dc37918281907308e0d7d09a75a6826473aec0caa1712ee149e5";
const MARKET_REGISTRY = "0x327c8a176055400e9aacde8553a897898b5da969d6dcdb55eee268bb501a2c3a";
const LP_POOL_REGISTRY = "0x46ef530d3ad13037ac54b77be324e5ab063124af8a119e86f1f59be8a16a22a2";
const CLOCK_ID = "0x6";
const SUI_COIN_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

// Oracle Update Config
const PYTH_STATE_ID = "0x1f38e76a66710486c9d2f267793a384f697920786f1e56b4f74d75f28499298d";
const PYTH_WORMHOLE_STATE_ID = "0xaeab092976c6bca40b03eb3c0e60971be5e1a29327e0b0010e9f0d4638706031";

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

async function getPythVAA(): Promise<string[]> {
  const resp = await fetch(`${HERMES_URL}?ids[]=${SUI_PRICE_FEED_ID}`);
  const data = await resp.json();
  return data.binary.data;
}

export class TypusAdapter implements DexAdapter {
  readonly venue = "typus";
  readonly supported = true;
  readonly description = "Typus Perps - On-chain perpetual trading on SUI with Pyth oracle pricing and up to 50x leverage";
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

      const tx = new Transaction();
      
      // Oracle update
      const vaas = await getPythVAA();
      const [updateFee] = tx.splitCoins(tx.gas, [tx.pure.u64(vaas.length)]);
      
      const priceInfos = tx.moveCall({
        target: `0x00b53d4588e401c10d72023a4b76e5d871329c2982d6e46a782d259587326dfb::pyth::update_single_price_feeds`,
        arguments: [
          tx.object(PYTH_STATE_ID),
          tx.pure.vector("u8", Array.from(Buffer.from(vaas[0], "hex"))),
          tx.object(CLOCK_ID),
          updateFee
        ],
      });

      const [collateralCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(collateralMist)]);

      // 16-parameter signature
      tx.moveCall({
        target: `${PERP_PACKAGE_ID}::trading::create_trading_order`,
        typeArguments: [SUI_COIN_TYPE, SUI_COIN_TYPE],
        arguments: [
          tx.object(PERP_VERSION),
          tx.object(MARKET_REGISTRY),
          tx.object(LP_POOL_REGISTRY),
          tx.pure.u64(SUI_MARKET_INDEX),
          tx.pure.u64(SUI_POOL_INDEX),
          priceInfos, // oracle_collateral
          priceInfos, // oracle_base
          tx.object(CLOCK_ID),
          tx.pure.u64(0), // linked_position_id
          collateralCoin,
          tx.pure.u64(sizeUnits),
          tx.pure.u64(triggerPrice),
          tx.pure.bool(isLong),
          tx.pure.bool(false), // is_limit
          tx.pure.bool(false), // is_close
          tx.pure.option("u64", null), // client_order_id
        ],
      });

      tx.setGasBudget(100_000_000);

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
      const sizeUnits = toSizeUnits(params.quantity || 0);
      const triggerPrice = toPriceUnits(params.price);

      const tx = new Transaction();
      const vaas = await getPythVAA();
      const [updateFee] = tx.splitCoins(tx.gas, [tx.pure.u64(vaas.length)]);
      
      const priceInfos = tx.moveCall({
        target: `0x00b53d4588e401c10d72023a4b76e5d871329c2982d6e46a782d259587326dfb::pyth::update_single_price_feeds`,
        arguments: [
          tx.object(PYTH_STATE_ID),
          tx.pure.vector("u8", Array.from(Buffer.from(vaas[0], "hex"))),
          tx.object(CLOCK_ID),
          updateFee
        ],
      });

      const zeroCoin = tx.moveCall({ target: "0x2::coin::zero", typeArguments: [SUI_COIN_TYPE] });

      tx.moveCall({
        target: `${PERP_PACKAGE_ID}::trading::create_trading_order`,
        typeArguments: [SUI_COIN_TYPE, SUI_COIN_TYPE],
        arguments: [
          tx.object(PERP_VERSION),
          tx.object(MARKET_REGISTRY),
          tx.object(LP_POOL_REGISTRY),
          tx.pure.u64(SUI_MARKET_INDEX),
          tx.pure.u64(SUI_POOL_INDEX),
          priceInfos,
          priceInfos,
          tx.object(CLOCK_ID),
          tx.pure.u64(0),
          zeroCoin,
          tx.pure.u64(sizeUnits),
          tx.pure.u64(triggerPrice),
          tx.pure.bool(false),
          tx.pure.bool(false),
          tx.pure.bool(true), // is_close
          tx.pure.option("u64", null),
        ],
      });

      tx.setGasBudget(100_000_000);
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
    if (params.agent.balance < 0.1) return { valid: false, reason: "Min 0.1 SUI required" };
    return { valid: true };
  }
}
