import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import type { DexAdapter, DexOrderParams, DexCloseParams, DexOrderResult, DexPositionInfo, DexBalanceInfo, DexFeeEstimate } from "./types";
import { decryptKeypair } from "./wallet-manager";

const SUI_RPC = "https://fullnode.mainnet.sui.io:443";
const suiClient = new SuiJsonRpcClient({ url: SUI_RPC, network: "mainnet" });

const ZO_PACKAGE_ID = "0x25a1d518373e465f1bff4c4ab069e160f9c30da9d9a2cb5a17f5bd645ab62ea4";
const ZO_ORIGINAL_PACKAGE = "0xf7fade57462e56e2eff1d7adef32e4fd285b21fd81f983f407bb7110ca766cda";

const CLOCK_ID = "0x6";
const MARKET_ID = "0x35c667bd8c401036103992791a924f31df0d104256a9e2313acee5b1bcf05b7e";

const ZLP_TYPE = `${ZO_ORIGINAL_PACKAGE}::zlp::ZLP`;
const LONG_TYPE = `${ZO_ORIGINAL_PACKAGE}::market::LONG`;
const SHORT_TYPE = `${ZO_ORIGINAL_PACKAGE}::market::SHORT`;
const SUI_COIN_TYPE = "0x2::sui::SUI";

const SUI_PYTH_FEEDER = "0x801dbc2f0053d34734814b2d6df491ce7807a725fe9a01ad74a07e9c51396c37";

const SUI_VAULT_RESERVING_FEE_MODEL = "0x4d19ffb376fb4c0dcfc85f434b100372f55a67eae44078b4516b61f28a82ceb4";

const SUI_LONG_CONFIG = {
  fundingFeeModel: "0xb79f8117573ede4c73be995dee65039ec0b649fa9d19526dedbea10c59a1901a",
  positionConfig: "0xc7c1b89b5afc7eb22ac86e24b4fb19821debeba1e9d6b607af25b90b30baf0ee",
};

const SUI_SHORT_CONFIG = {
  fundingFeeModel: "0x376cc5b1ae3797ceeda86a27f8ab13213aa38fc25437f634d57e41a3eb0e2467",
  positionConfig: "0x02802513d54807dc5c4682dac0c88c91e818e05b9aa8c02cff4ebb8372a09f5e",
};

const SUI_DECIMALS = 9;
const MIST_PER_SUI = 1_000_000_000;

const DECIMAL_PRECISION = BigInt("1000000000000000000");

function suiToMist(sui: number): bigint {
  return BigInt(Math.floor(sui * MIST_PER_SUI));
}

function priceToDecimalRaw(price: number): bigint {
  return BigInt(Math.floor(price * Number(DECIMAL_PRECISION)));
}

async function getOwnedPositionCaps(
  owner: string,
  direction: "long" | "short"
): Promise<Array<{ objectId: string; positionCapId: string }>> {
  const dirType = direction === "long" ? LONG_TYPE : SHORT_TYPE;
  const capType = `${ZO_ORIGINAL_PACKAGE}::market::PositionCap<${SUI_COIN_TYPE}, ${SUI_COIN_TYPE}, ${dirType}>`;

  try {
    const result = await suiClient.getOwnedObjects({
      owner,
      filter: { StructType: capType },
      options: { showContent: true, showType: true },
    });

    return (result.data || []).map((obj) => ({
      objectId: obj.data?.objectId || "",
      positionCapId: obj.data?.objectId || "",
    }));
  } catch (error: any) {
    console.error(`[ZO] Error fetching position caps: ${error.message}`);
    return [];
  }
}

async function getSuiCoins(owner: string): Promise<Array<{ objectId: string; balance: bigint }>> {
  try {
    const coins = await suiClient.getCoins({ owner, coinType: SUI_COIN_TYPE });
    return (coins.data || []).map((c) => ({
      objectId: c.coinObjectId,
      balance: BigInt(c.balance),
    }));
  } catch {
    return [];
  }
}

export class ZoAdapter implements DexAdapter {
  readonly venue = "zo";
  readonly supported = true;
  readonly description = "ZO Perpetuals (Sudo Finance) - Fully on-chain perpetual DEX on SUI with direct Move contract execution";

  isReady(): boolean {
    return true;
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
      const address = keypair.getPublicKey().toSuiAddress();
      const isLong = params.side === "long";
      const directionType = isLong ? LONG_TYPE : SHORT_TYPE;
      const config = isLong ? SUI_LONG_CONFIG : SUI_SHORT_CONFIG;

      const collateralSui = (params.quantity * params.price) / params.leverage;
      const feeSui = collateralSui * 0.001;
      const totalNeeded = suiToMist(collateralSui + feeSui + 0.01);
      const collateralMist = suiToMist(collateralSui);
      const feeMist = suiToMist(feeSui);

      const openAmountMist = suiToMist(params.quantity);
      const reserveAmountMist = collateralMist;

      const limitPrice = isLong
        ? priceToDecimalRaw(params.price * 1.05)
        : priceToDecimalRaw(params.price * 0.95);
      const collateralPriceThreshold = priceToDecimalRaw(params.price * 0.8);

      const tx = new Transaction();

      const [collateralCoin, feeCoin] = tx.splitCoins(tx.gas, [
        tx.pure.u64(collateralMist),
        tx.pure.u64(feeMist),
      ]);

      tx.moveCall({
        target: `${ZO_PACKAGE_ID}::market::open_position`,
        typeArguments: [
          ZLP_TYPE,
          SUI_COIN_TYPE,
          SUI_COIN_TYPE,
          directionType,
          SUI_COIN_TYPE,
        ],
        arguments: [
          tx.object(CLOCK_ID),
          tx.object(MARKET_ID),
          tx.object(SUI_VAULT_RESERVING_FEE_MODEL),
          tx.object(config.fundingFeeModel),
          tx.object(config.positionConfig),
          tx.object(SUI_PYTH_FEEDER),
          tx.object(SUI_PYTH_FEEDER),
          collateralCoin,
          feeCoin,
          tx.pure.u8(0),
          tx.pure.u64(openAmountMist),
          tx.pure.u64(reserveAmountMist),
          tx.pure.u256(collateralPriceThreshold),
          tx.pure.u256(limitPrice),
        ],
      });

      tx.setGasBudget(50_000_000);

      console.log(`[ZO] Submitting open_position tx: ${params.side} ${params.quantity} SUI @ $${params.price}`);

      const result = await suiClient.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
        options: { showEffects: true, showEvents: true },
      });

      const txDigest = result.digest;
      const status = result.effects?.status?.status;

      if (status === "success") {
        console.log(`[ZO] Position opened successfully: ${txDigest}`);
        return {
          success: true,
          txDigest,
          orderId: txDigest,
          venue: this.venue,
        };
      } else {
        const errorMsg = result.effects?.status?.error || "Transaction failed";
        console.error(`[ZO] Transaction failed: ${errorMsg}`);
        return {
          success: false,
          error: `ZO on-chain tx failed: ${errorMsg}`,
          venue: this.venue,
        };
      }
    } catch (error: any) {
      console.error(`[ZO] Open position error: ${error.message}`);
      return {
        success: false,
        error: `ZO execution error: ${error.message}`,
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
      const address = keypair.getPublicKey().toSuiAddress();

      const longCaps = await getOwnedPositionCaps(address, "long");
      const shortCaps = await getOwnedPositionCaps(address, "short");
      const allCaps = [
        ...longCaps.map((c) => ({ ...c, side: "long" as const })),
        ...shortCaps.map((c) => ({ ...c, side: "short" as const })),
      ];

      if (allCaps.length === 0) {
        return { success: false, error: "No open position caps found on-chain", venue: this.venue };
      }

      const cap = allCaps[0];
      const isLong = cap.side === "long";
      const directionType = isLong ? LONG_TYPE : SHORT_TYPE;
      const config = isLong ? SUI_LONG_CONFIG : SUI_SHORT_CONFIG;

      const decreaseAmount = suiToMist(params.quantity || 0);
      const currentPrice = params.price;

      const limitPrice = isLong
        ? priceToDecimalRaw(currentPrice * 0.95)
        : priceToDecimalRaw(currentPrice * 1.05);
      const collateralPriceThreshold = priceToDecimalRaw(currentPrice * 0.8);

      const feeMist = suiToMist(0.005);

      const tx = new Transaction();
      const [feeCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(feeMist)]);

      tx.moveCall({
        target: `${ZO_PACKAGE_ID}::market::decrease_position`,
        typeArguments: [
          ZLP_TYPE,
          SUI_COIN_TYPE,
          SUI_COIN_TYPE,
          directionType,
          SUI_COIN_TYPE,
        ],
        arguments: [
          tx.object(CLOCK_ID),
          tx.object(MARKET_ID),
          tx.object(cap.objectId),
          tx.object(SUI_VAULT_RESERVING_FEE_MODEL),
          tx.object(config.fundingFeeModel),
          tx.object(SUI_PYTH_FEEDER),
          tx.object(SUI_PYTH_FEEDER),
          feeCoin,
          tx.pure.u8(0),
          tx.pure.bool(true),
          tx.pure.u64(decreaseAmount),
          tx.pure.u256(collateralPriceThreshold),
          tx.pure.u256(limitPrice),
        ],
      });

      tx.setGasBudget(50_000_000);

      console.log(`[ZO] Submitting decrease_position tx: closing ${cap.side} position`);

      const result = await suiClient.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
        options: { showEffects: true, showEvents: true },
      });

      const txDigest = result.digest;
      const status = result.effects?.status?.status;

      if (status === "success") {
        console.log(`[ZO] Position closed successfully: ${txDigest}`);
        return {
          success: true,
          txDigest,
          venue: this.venue,
        };
      } else {
        const errorMsg = result.effects?.status?.error || "Transaction failed";
        console.error(`[ZO] Close transaction failed: ${errorMsg}`);
        return {
          success: false,
          error: `ZO close tx failed: ${errorMsg}`,
          venue: this.venue,
        };
      }
    } catch (error: any) {
      console.error(`[ZO] Close position error: ${error.message}`);
      return {
        success: false,
        error: `ZO close error: ${error.message}`,
        venue: this.venue,
      };
    }
  }

  async getPositions(walletAddress: string): Promise<DexPositionInfo[]> {
    try {
      const positions: DexPositionInfo[] = [];

      for (const direction of ["long", "short"] as const) {
        const caps = await getOwnedPositionCaps(walletAddress, direction);
        for (const cap of caps) {
          positions.push({
            positionId: cap.objectId,
            symbol: "SUI-PERP",
            side: direction,
            size: 0,
            entryPrice: 0,
            markPrice: 0,
            unrealizedPnl: 0,
            leverage: 1,
          });
        }
      }

      return positions;
    } catch (error: any) {
      console.error(`[ZO] getPositions error: ${error.message}`);
      return [];
    }
  }

  async getBalance(walletAddress: string): Promise<DexBalanceInfo> {
    try {
      const balance = await suiClient.getBalance({
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
    const tradingFee = notionalValue * 0.001;
    const gasFee = 0.01;
    return { tradingFee, gasFee, total: tradingFee + gasFee };
  }

  async validateOrder(params: DexOrderParams): Promise<{ valid: boolean; reason?: string }> {
    if (params.leverage < 1 || params.leverage > 50) {
      return { valid: false, reason: "Leverage must be between 1x and 50x for ZO Perpetuals" };
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
