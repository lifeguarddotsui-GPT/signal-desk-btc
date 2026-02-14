import type { DexAdapter } from "./types";
import { TypusAdapter } from "./typus-adapter";

const adapters: Record<string, DexAdapter> = {
  typus: new TypusAdapter(),
};

export function getAdapter(venue: string): DexAdapter | null {
  return adapters[venue] || null;
}

export function getAllAdapters(): Record<string, DexAdapter> {
  return { ...adapters };
}

export function getAdapterStatus(): Array<{ venue: string; supported: boolean; description: string }> {
  return Object.values(adapters).map((a) => ({
    venue: a.venue,
    supported: a.supported,
    description: a.description,
  }));
}

export { generateAgentWallet, decryptKeypair } from "./wallet-manager";
export type { DexAdapter, DexOrderParams, DexCloseParams, DexOrderResult, DexPositionInfo, DexBalanceInfo, DexFeeEstimate, AgentWallet } from "./types";
