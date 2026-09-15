import type { SuiNetwork } from "./launchpadAdapter";

export interface SuipumpManifest {
  network: SuiNetwork;
  sourceUrl: string;
  retrievedAt: string;
  verification: "UNVERIFIED" | "PARTIAL" | "VERIFIED";
  packageLineages: readonly {
    name: string;
    packageId: string | null;
    definingId: string | null;
    writePackageId: string | null;
    curveType: string | null;
    eventTypes: readonly string[];
    supportedEntryFunctions: readonly string[];
    supportedExitFunctions: readonly string[];
    graduationDestinations: readonly string[];
  }[];
}

const DEFAULT_MANIFEST: SuipumpManifest = {
  network: "mainnet",
  sourceUrl: "https://suipump.org/",
  // This is intentionally not presented as current chain verification. The
  // public brief did not establish stable package IDs or a supported API.
  retrievedAt: "2026-09-15",
  verification: "UNVERIFIED",
  packageLineages: [],
};

function parseManifest(value: unknown): SuipumpManifest {
  if (!value || typeof value !== "object") throw new Error("Invalid Suipump manifest");
  const candidate = value as Partial<SuipumpManifest>;
  if (candidate.network !== "mainnet") {
    throw new Error("SUIPUMP_MANIFEST_NETWORK_MISMATCH: only Sui mainnet is accepted");
  }
  if (typeof candidate.sourceUrl !== "string" || typeof candidate.retrievedAt !== "string") {
    throw new Error("Invalid Suipump manifest metadata");
  }
  if (!Array.isArray(candidate.packageLineages)) throw new Error("Invalid Suipump package lineages");
  return {
    network: "mainnet",
    sourceUrl: candidate.sourceUrl,
    retrievedAt: candidate.retrievedAt,
    verification: candidate.verification === "VERIFIED" || candidate.verification === "PARTIAL"
      ? candidate.verification : "UNVERIFIED",
    packageLineages: candidate.packageLineages.map((lineage) => ({
      name: typeof lineage.name === "string" ? lineage.name : "unknown",
      packageId: lineage.packageId ?? null,
      definingId: lineage.definingId ?? null,
      writePackageId: lineage.writePackageId ?? null,
      curveType: lineage.curveType ?? null,
      eventTypes: Array.isArray(lineage.eventTypes) ? (lineage.eventTypes as unknown[]).filter((v: unknown): v is string => typeof v === "string") : [],
      supportedEntryFunctions: Array.isArray(lineage.supportedEntryFunctions)
        ? (lineage.supportedEntryFunctions as unknown[]).filter((v: unknown): v is string => typeof v === "string") : [],
      supportedExitFunctions: Array.isArray(lineage.supportedExitFunctions)
        ? (lineage.supportedExitFunctions as unknown[]).filter((v: unknown): v is string => typeof v === "string") : [],
      graduationDestinations: Array.isArray(lineage.graduationDestinations)
        ? (lineage.graduationDestinations as unknown[]).filter((v: unknown): v is string => typeof v === "string") : [],
    })),
  };
}

/** Loads an operator-supplied manifest while refusing cross-network data. */
export function loadSuipumpManifest(serialized = process.env.SUIPUMP_MANIFEST_JSON): SuipumpManifest {
  if (!serialized) return DEFAULT_MANIFEST;
  try {
    return parseManifest(JSON.parse(serialized));
  } catch (error) {
    throw new Error(`SUIPUMP_MANIFEST_INVALID: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
}