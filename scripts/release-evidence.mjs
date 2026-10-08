// Verify that a CI build corresponds to the exact checked-out Git commit.
// This intentionally emits ONLY build fingerprints; never environment variables,
// workspace files, production database contents, or authentication material.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, stat } from "node:fs/promises";

const files = [
  "dist/index.mjs",
  "dist/waterx-worker.mjs",
  "dist/early-training.mjs",
  "dist/public/index.html",
  "package-lock.json",
];

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const fullCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(fullCommit)) throw new Error("No valid Git commit at build time.");
const build = JSON.parse(await readFile("dist/build-info.json", "utf8"));

if (build.sourceCommit !== fullCommit)
  throw new Error("Build source commit is missing or differs from checkout; release is blocked.");
if (!/^sha256:[a-f0-9]{64}$/.test(build.id ?? ""))
  throw new Error("Build has no valid release digest.");
if (!/^schema-sha256:[a-f0-9]{64}$/.test(build.schemaVersion ?? ""))
  throw new Error("Build has no verified schema fingerprint.");
if (!/^policy-sha256:[a-f0-9]{64}$/.test(build.configurationVersion ?? ""))
  throw new Error("Build has no verified policy fingerprint.");

const filesVerified = {};
for (const path of files) {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0) throw new Error(`Required build artifact absent or empty: ${path}`);
  filesVerified[path] = { bytes: info.size, sha256: sha256(await readFile(path)) };
}
const report = {
  format: 1,
  purpose: "Build evidence for a manually approved BlueWaterAI release. Not proof of production deployment.",
  sourceCommit: fullCommit,
  buildId: build.id,
  buildTimestamp: build.builtAt,
  schemaVersion: build.schemaVersion,
  configurationVersion: build.configurationVersion,
  sourceSnapshotSha256: build.sourceSnapshotSha256,
  files: filesVerified,
  deployStatus: "NOT_DEPLOYED",
};
await writeFile("dist/release-evidence.json", JSON.stringify(report, null, 2) + "\n");
console.log("Verified build provenance for commit", fullCommit, "build", build.id);
console.log("No deployment has been performed.");
