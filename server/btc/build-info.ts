import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BTC_ARTIFACT_FORMAT, BTC_ARTIFACT_VERSION } from "./artifact";

export type BuildInfo = {
  id: string | null;
  status: "packaged" | "dev/unbuilt" | "unavailable";
  sourceCommit: string | null;
  schemaVersion: string | null;
  modelArtifactVersion: string;
};

const buildDirectory = path.dirname(fileURLToPath(import.meta.url));
let cachedBuildInfo: BuildInfo | undefined;

export function buildInfo(): BuildInfo {
  if (cachedBuildInfo) return cachedBuildInfo;
  const modelArtifactVersion = `${BTC_ARTIFACT_FORMAT}/v${BTC_ARTIFACT_VERSION}`;

  if (process.env.NODE_ENV !== "production") {
    cachedBuildInfo = {
      id: null, status: "dev/unbuilt", sourceCommit: null,
      schemaVersion: null, modelArtifactVersion,
    };
    return cachedBuildInfo;
  }

  try {
    const manifest = JSON.parse(
      readFileSync(path.join(buildDirectory, "build-info.json"), "utf8"),
    ) as { id?: unknown; format?: unknown; sourceCommit?: unknown;
      schemaVersion?: unknown; modelArtifactVersion?: unknown };
    if (manifest.format === 2 &&
      typeof manifest.id === "string" &&
      /^sha256:[a-f0-9]{64}$/.test(manifest.id) &&
      (manifest.sourceCommit === null ||
        (typeof manifest.sourceCommit === "string" && /^[a-f0-9]{40}$/.test(manifest.sourceCommit))) &&
      typeof manifest.schemaVersion === "string" &&
      /^schema-sha256:[a-f0-9]{64}$/.test(manifest.schemaVersion) &&
      manifest.modelArtifactVersion === modelArtifactVersion) {
      cachedBuildInfo = {
        id: manifest.id, status: "packaged",
        sourceCommit: manifest.sourceCommit as string | null,
        schemaVersion: manifest.schemaVersion,
        modelArtifactVersion,
      };
      return cachedBuildInfo;
    }
  } catch {
    // A production source checkout or incomplete deployment has no packaged ID.
  }

  cachedBuildInfo = {
    id: null, status: "unavailable", sourceCommit: null,
    schemaVersion: null, modelArtifactVersion,
  };
  return cachedBuildInfo;
}