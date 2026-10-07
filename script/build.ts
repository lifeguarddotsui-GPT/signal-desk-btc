import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BTC_ARTIFACT_FORMAT, BTC_ARTIFACT_VERSION } from "../server/btc/artifact";
import {sourceSnapshot,packageSource} from "./source-snapshot";

async function clientFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async entry => {
    const filePath = path.join(directory, entry.name);
    return entry.isDirectory() ? clientFiles(filePath) : [filePath];
  }));
  return files.flat();
}

async function main() {
  // A Git revision is only evidence of the packaged source if the entire
  // checkout was clean when the build began. Never label a dirty build with
  // HEAD just because HEAD happens to exist.
  let sourceCommit: string | null = null;
  try {
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
      encoding: "utf8",
    }).trim();
    if (!dirty) {
      const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      if (/^[a-f0-9]{40}$/.test(revision)) sourceCommit = revision;
    }
  } catch {
    // An exported source tree may not have a Git directory.
  }
  const schemaHash = createHash("sha256");
  for (const name of (await readdir("migrations")).filter(name => name.endsWith(".sql")).sort()) {
    const contents = await readFile(path.join("migrations", name));
    schemaHash.update(name);
    schemaHash.update("\0");
    schemaHash.update(contents);
    schemaHash.update("\0");
  }
  const schemaVersion = `schema-sha256:${schemaHash.digest("hex")}`;
  // This fingerprints checked-in decision policy, not deployment environment
  // variables or runtime provider settings. Never disclose runtime secrets.
  const policyHash = createHash("sha256");
  for (const name of ["server/btc/advisor.ts", "server/btc/engine.ts", "server/btc/policy.ts",
    "shared/timed-decision.ts","shared/timed-completion.ts","shared/lock-readiness.ts","server/agent/risk.ts",
    "server/waterx/early-policy.ts","server/waterx/two-stage-policy.ts","server/waterx/two-stage-registry.ts","shared/two-stage.ts"]) {
    policyHash.update(name);
    policyHash.update("\0");
    policyHash.update(await readFile(name));
    policyHash.update("\0");
  }
  const configurationVersion = `policy-sha256:${policyHash.digest("hex")}`;
  await rm("dist", { recursive: true, force: true });
  await viteBuild();
  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "esm",
    outfile: "dist/index.mjs",
    packages: "external",
    target: "node22",
    logLevel: "info",
  });
  await esbuild({
    entryPoints: ["server/waterx/worker.ts"],
    platform: "node",
    bundle: true,
    format: "esm",
    outfile: "dist/waterx-worker.mjs",
    packages: "external",
    target: "node22",
    logLevel: "info",
  });
  await esbuild({entryPoints:["scripts/train-early-horizons.ts"],platform:"node",bundle:true,format:"esm",
    outfile:"dist/early-training.mjs",packages:"external",target:"node22",logLevel:"info"});

  // Identify the packaged output and locked external runtime dependencies;
  // this is deliberately not a workspace Git revision.
  const files = [
    "dist/index.mjs", "dist/waterx-worker.mjs","dist/early-training.mjs",
    ...(await clientFiles("dist/public")), "package-lock.json",
  ]
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const relativePath = file === "package-lock.json" ? file :
      path.relative("dist", file).split(path.sep).join("/");
    const contents = await readFile(file);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(String(contents.byteLength));
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  const snapshot=await sourceSnapshot();
  hash.update("source-only-snapshot\0"+snapshot.digest);
  const build={
    id: `sha256:${hash.digest("hex")}`,
    format: 3,
    builtAt: new Date().toISOString(),
    sourceCommit,
    schemaVersion,
    configurationVersion,
    modelArtifactVersion: `${BTC_ARTIFACT_FORMAT}/v${BTC_ARTIFACT_VERSION}`,
    sourceSnapshotSha256:snapshot.digest,sourceArchiveUrl:"/source-release.tar.gz",
  };
  const sourceArchiveSha256=await packageSource(snapshot,build);
  await writeFile("dist/build-info.json", JSON.stringify({...build,sourceArchiveSha256}) + "\n");
}
main().catch(error => { console.error(error); process.exitCode = 1; });