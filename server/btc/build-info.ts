import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BTC_ARTIFACT_FORMAT, BTC_ARTIFACT_VERSION } from "./artifact";

export type BuildInfo = {
  id: string | null;
  status: "packaged" | "dev/unbuilt" | "unavailable";
  sourceCommit: string | null;
  builtAt: string | null;
  schemaVersion: string | null;
  configurationVersion: string | null;
  modelArtifactVersion: string;
  sourceSnapshotSha256?:string|null;
  sourceArchiveSha256?:string|null;
};

const buildDirectory = path.dirname(fileURLToPath(import.meta.url));
let cachedBuildInfo: BuildInfo | undefined;

export function buildInfo(): BuildInfo {
  if (cachedBuildInfo) return cachedBuildInfo;
  const modelArtifactVersion = `${BTC_ARTIFACT_FORMAT}/v${BTC_ARTIFACT_VERSION}`;

  if (process.env.NODE_ENV !== "production") {
    cachedBuildInfo = {
      id: null, status: "dev/unbuilt", sourceCommit: null,
      builtAt: null, schemaVersion: null, configurationVersion: null, modelArtifactVersion,
    };
    return cachedBuildInfo;
  }

  try {
    const manifest = JSON.parse(
      readFileSync(path.join(buildDirectory, "build-info.json"), "utf8"),
    ) as { id?: unknown; format?: unknown; sourceCommit?: unknown;
      builtAt?: unknown; schemaVersion?: unknown; configurationVersion?: unknown;
      modelArtifactVersion?: unknown;sourceSnapshotSha256?:unknown;sourceArchiveSha256?:unknown };
    if (manifest.format === 3 &&
      typeof manifest.id === "string" &&
      /^sha256:[a-f0-9]{64}$/.test(manifest.id) &&
      (manifest.sourceCommit === null ||
        (typeof manifest.sourceCommit === "string" && /^[a-f0-9]{40}$/.test(manifest.sourceCommit))) &&
      typeof manifest.builtAt === "string" &&
      !Number.isNaN(Date.parse(manifest.builtAt)) &&
      typeof manifest.schemaVersion === "string" &&
      /^schema-sha256:[a-f0-9]{64}$/.test(manifest.schemaVersion) &&
      typeof manifest.configurationVersion === "string" &&
      /^policy-sha256:[a-f0-9]{64}$/.test(manifest.configurationVersion) &&
      manifest.modelArtifactVersion === modelArtifactVersion) {
      cachedBuildInfo = {
        id: manifest.id, status: "packaged",
        sourceCommit: manifest.sourceCommit as string | null,
        builtAt: manifest.builtAt,
        schemaVersion: manifest.schemaVersion,
        configurationVersion: manifest.configurationVersion,
        modelArtifactVersion,
        sourceSnapshotSha256:typeof manifest.sourceSnapshotSha256==="string"&&/^[a-f0-9]{64}$/.test(manifest.sourceSnapshotSha256)?manifest.sourceSnapshotSha256:null,
        sourceArchiveSha256:typeof manifest.sourceArchiveSha256==="string"&&/^[a-f0-9]{64}$/.test(manifest.sourceArchiveSha256)?manifest.sourceArchiveSha256:null,
      };
      return cachedBuildInfo;
    }
  } catch {
    // A production source checkout or incomplete deployment has no packaged ID.
  }

  cachedBuildInfo = {
    id: null, status: "unavailable", sourceCommit: null,
    builtAt: null, schemaVersion: null, configurationVersion: null, modelArtifactVersion,
  };
  return cachedBuildInfo;
}