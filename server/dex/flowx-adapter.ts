import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import type { DexAdapter, DexOrderParams, DexCloseParams, DexOrderResult, DexPositionInfo, DexBalanceInfo, DexFeeEstimate } from "./types";
import { decryptKeypair } from "./wallet-manager";

const SUI_RPC = "https://fullnode.mainnet.sui.io:443";

const SUI_COIN_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const USDC_COIN_TYPE = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

const FLOWX_SWAP_PACKAGE = "0xba153169476e8c3114962571c05e1da6a9a723c0d0e5e6e3f8b0a1c2d3e4f5a6";
const FLOWX_POOL_REGISTRY = "0xpool_registry_placeholder";

export class FlowXAdapter implements DexAdapter {
  readonly venue = "flowx";
  readonly supported = true;
  readonly description = "FlowX Finance - DEX aggregator on SUI for optimal swap routing";
  private client: SuiJsonRpcClient;

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

      const tokenIn = params.side === "long" ? USDC_COIN_TYPE : SUI_COIN_TYPE;
      const tokenOut = params.side === "long" ? SUI_COIN_TYPE : USDC_COIN_TYPE;
      const amountIn = Math.floor(params.quantity * 1e9);

      const [coin] = tx.splitCoins(tx.gas, [amountIn]);

      tx.moveCall({
        target: `${FLOWX_SWAP_PACKAGE}::router::swap_exact_input`,
        arguments: [
          tx.object(FLOWX_POOL_REGISTRY),
          coin,
          tx.pure.u64(0),
          tx.pure.u64(Math.floor((params.slippage || 0.01) * 1e6)),
        ],
        typeArguments: [tokenIn, tokenOut],
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
          error: `FlowX swap failed: ${result.effects?.status?.error || "unknown"}`,
          txDigest: result.digest,
          venue: this.venue,
        };
      }
    } catch (error: any) {
      return { success: false, error: `FlowX execution error: ${error.message}`, venue: this.venue };
    }
  }

  async closePosition(params: DexCloseParams): Promise<DexOrderResult> {
    try {
      if (!params.agent.agentWallet) {
        return { success: false, error: "Agent wallet not configured", venue: this.venue };
      }

      const keypair = decryptKeypair(params.agent.agentWallet);
      const tx = new Transaction();

      const amountIn = Math.floor((params.quantity || 0) * 1e9);
      const [coin] = tx.splitCoins(tx.gas, [amountIn]);

      tx.moveCall({
        target: `${FLOWX_SWAP_PACKAGE}::router::swap_exact_input`,
        arguments: [
          tx.object(FLOWX_POOL_REGISTRY),
          coin,
          tx.pure.u64(0),
          tx.pure.u64(Math.floor(0.01 * 1e6)),
        ],
        typeArguments: [SUI_COIN_TYPE, USDC_COIN_TYPE],
      });

      const result = await this.client.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
        options: { showEffects: true },
      });

      if (result.effects?.status?.status === "success") {
        return { success: true, txDigest: result.digest, venue: this.venue };
      } else {
        return { success: false, error: "FlowX close swap failed", txDigest: result.digest, venue: this.venue };
      }
    } catch (error: any) {
      return { success: false, error: `FlowX close error: ${error.message}`, venue: this.venue };
    }
  }

  async getPositions(_walletAddress: string): Promise<DexPositionInfo[]> {
    return [];
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
    const tradingFee = notionalValue * 0.003;
    const gasFee = 0.003;
    return { tradingFee, gasFee, total: tradingFee + gasFee };
  }

  async validateOrder(params: DexOrderParams): Promise<{ valid: boolean; reason?: string }> {
    if (params.leverage > 1) {
      return { valid: false, reason: "FlowX is a spot DEX - leverage trading not supported. Use 1x only." };
    }
    if (params.quantity <= 0) {
      return { valid: false, reason: "Quantity must be positive" };
    }
    if (params.agent.balance < params.quantity * params.price) {
      return { valid: false, reason: `Insufficient balance for spot trade` };
    }
    return { valid: true };
  }
}
