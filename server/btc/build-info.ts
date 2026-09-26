import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type BuildInfo = {
  id: string | null;
  status: "packaged" | "dev/unbuilt" | "unavailable";
};

const buildDirectory = path.dirname(fileURLToPath(import.meta.url));
let cachedBuildInfo: BuildInfo | undefined;

export function buildInfo(): BuildInfo {
  if (cachedBuildInfo) return cachedBuildInfo;

  if (process.env.NODE_ENV !== "production") {
    cachedBuildInfo = { id: null, status: "dev/unbuilt" };
    return cachedBuildInfo;
  }

  try {
    const manifest = JSON.parse(
      readFileSync(path.join(buildDirectory, "build-info.json"), "utf8"),
    ) as { id?: unknown; format?: unknown };
    if (manifest.format === 1 &&
      typeof manifest.id === "string" &&
      /^sha256:[a-f0-9]{64}$/.test(manifest.id)) {
      cachedBuildInfo = { id: manifest.id, status: "packaged" };
      return cachedBuildInfo;
    }
  } catch {
    // A production source checkout or incomplete deployment has no packaged ID.
  }

  cachedBuildInfo = { id: null, status: "unavailable" };
  return cachedBuildInfo;
}