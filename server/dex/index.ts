import type { DexAdapter } from "./types";
import { SudoAdapter } from "./sudo-adapter";
import { TypusAdapter } from "./typus-adapter";
import { FlowXAdapter } from "./flowx-adapter";
import { ZoFAIAdapter } from "./zofai-adapter";
import { AstrosAdapter } from "./astros-adapter";

const adapters: Record<string, DexAdapter> = {
  sudo: new SudoAdapter(),
  typus: new TypusAdapter(),
  flowx: new FlowXAdapter(),
  zofai: new ZoFAIAdapter(),
  astros: new AstrosAdapter(),
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
