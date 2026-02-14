import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import type { DexAdapter, DexOrderParams, DexCloseParams, DexOrderResult, DexPositionInfo, DexBalanceInfo, DexFeeEstimate } from "./types";
import { decryptKeypair } from "./wallet-manager";

const SUI_RPC = "https://fullnode.mainnet.sui.io:443";

const TYPUS_PACKAGE = "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1";
const TYPUS_PERP_REGISTRY = "0xabcdef0123456789typus";

export class TypusAdapter implements DexAdapter {
  readonly venue = "typus";
  readonly supported = true;
  readonly description = "Typus Finance - Perpetual futures with up to 50x leverage on SUI";
  private client: SuiJsonRpcClient;

  isReady(): boolean {
    return !TYPUS_PERP_REGISTRY.includes("abcdef0123456789");
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
      const tx = new Transaction();

      const collateralAmount = Math.floor((params.quantity * params.price / params.leverage) * 1e9);
      const [coin] = tx.splitCoins(tx.gas, [collateralAmount]);

      tx.moveCall({
        target: `${TYPUS_PACKAGE}::perp::open_position`,
        arguments: [
          tx.object(TYPUS_PERP_REGISTRY),
          coin,
          tx.pure.u64(Math.floor(params.quantity * 1e9)),
          tx.pure.u64(params.leverage),
          tx.pure.bool(params.side === "long"),
          tx.pure.u64(Math.floor((params.slippage || 0.01) * 1e6)),
        ],
      });

      const result = await this.client.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
        options: { showEffects: true, showEvents: true },
      });

      if (result.effects?.status?.status === "success") {
        return { success: true, txDigest: result.digest, orderId: result.digest, venue: this.venue };
      } else {
        return {
          success: false,
          error: `Typus tx failed: ${result.effects?.status?.error || "unknown"}`,
          txDigest: result.digest,
          venue: this.venue,
        };
      }
    } catch (error: any) {
      return { success: false, error: `Typus execution error: ${error.message}`, venue: this.venue };
    }
  }

  async closePosition(params: DexCloseParams): Promise<DexOrderResult> {
    try {
      if (!params.agent.agentWallet) {
        return { success: false, error: "Agent wallet not configured", venue: this.venue };
      }

      const keypair = decryptKeypair(params.agent.agentWallet);
      const tx = new Transaction();

      tx.moveCall({
        target: `${TYPUS_PACKAGE}::perp::close_position`,
        arguments: [
          tx.object(TYPUS_PERP_REGISTRY),
          tx.object(params.positionId),
        ],
      });

      const result = await this.client.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
        options: { showEffects: true },
      });

      if (result.effects?.status?.status === "success") {
        return { success: true, txDigest: result.digest, venue: this.venue };
      } else {
        return { success: false, error: `Typus close failed`, txDigest: result.digest, venue: this.venue };
      }
    } catch (error: any) {
      return { success: false, error: `Typus close error: ${error.message}`, venue: this.venue };
    }
  }

  async getPositions(walletAddress: string): Promise<DexPositionInfo[]> {
    try {
      const objects = await this.client.getOwnedObjects({
        owner: walletAddress,
        filter: { Package: TYPUS_PACKAGE },
        options: { showContent: true, showType: true },
      });

      const positions: DexPositionInfo[] = [];
      for (const obj of objects.data) {
        if (obj.data?.content && "fields" in obj.data.content) {
          const fields = obj.data.content.fields as any;
          if (fields.size && fields.entry_price) {
            positions.push({
              positionId: obj.data.objectId,
              symbol: "SUI-PERP",
              side: fields.is_long ? "long" : "short",
              size: Number(fields.size || 0) / 1e9,
              entryPrice: Number(fields.entry_price || 0) / 1e9,
              markPrice: Number(fields.mark_price || 0) / 1e9,
              unrealizedPnl: Number(fields.unrealized_pnl || 0) / 1e9,
              liquidationPrice: Number(fields.liquidation_price || 0) / 1e9,
              leverage: Number(fields.leverage || 1),
            });
          }
        }
      }
      return positions;
    } catch (error: any) {
      console.error(`Typus getPositions error: ${error.message}`);
      return [];
    }
  }

  async getBalance(walletAddress: string): Promise<DexBalanceInfo> {
    try {
      const balance = await this.client.getBalance({ owner: walletAddress });
      const total = Number(balance.totalBalance) / 1e9;
      return { available: total, locked: 0, total };
    } catch {
      return { available: 0, locked: 0, total: 0 };
    }
  }

  async estimateFees(params: DexOrderParams): Promise<DexFeeEstimate> {
    const notionalValue = params.quantity * params.price;
    const tradingFee = notionalValue * 0.0015;
    const gasFee = 0.005;
    return { tradingFee, gasFee, total: tradingFee + gasFee };
  }

  async validateOrder(params: DexOrderParams): Promise<{ valid: boolean; reason?: string }> {
    if (params.leverage < 1 || params.leverage > 50) {
      return { valid: false, reason: "Leverage must be between 1x and 50x for Typus" };
    }
    if (params.quantity <= 0) {
      return { valid: false, reason: "Quantity must be positive" };
    }
    const requiredCollateral = (params.quantity * params.price) / params.leverage;
    if (params.agent.balance < requiredCollateral) {
      return { valid: false, reason: `Insufficient balance: need ${requiredCollateral.toFixed(4)} SUI` };
    }
    return { valid: true };
  }
}
