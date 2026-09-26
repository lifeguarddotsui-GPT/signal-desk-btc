import { mkdtemp, readFile, mkdir, writeFile, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative } from "node:path";

// Never push this workspace's existing Git history: it contains uploaded images.
// Every publicly copied file must appear in this reviewed manifest.
const root = resolve(import.meta.dirname, "..");
const manifest = [
  ".env.example", ".gitignore", "PUBLIC_AUDIT.md",
  "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts",
  "client/index.html", "client/src/App.tsx", "client/src/index.css", "client/src/main.tsx",
  "server/btc/artifact.ts", "server/btc/engine.ts", "server/btc/evidence.ts", "server/btc/model.ts",
  "server/btc/policy.ts", "server/btc/service.ts", "server/btc/source.ts", "server/btc/store.ts",
  "server/index.ts", "server/routes.ts", "server/static.ts", "server/vite.ts",
  "script/build.ts", "scripts/artifact.test.ts", "scripts/backfill.ts", "scripts/btc.test.ts",
  "scripts/evidence.test.ts", "scripts/export-public.ts", "scripts/model.test.ts",
  "scripts/policy.test.ts",
  "migrations/0001_accumulation_foundation.sql", "migrations/0002_collector_checkpoint.sql",
  "migrations/0003_wallet_auth_challenges.sql", "migrations/0004_operational_trading_foundation.sql",
  "migrations/0005_durable_event_replay.sql", "migrations/0006_turnkey_custody.sql",
  "migrations/btc-learning.sql",
];
const forbidden = /-----BEGIN [A-Z ]*PRIVATE KEY|(?:ghp_|gho_|github_pat_|sk_live_|xox[baprs]-)[A-Za-z0-9_-]{8,}/i;
const publicReadme = `# Signal Desk

Read-only BTC one-minute research console. The current BTC UI does not connect a trading wallet, sign, or submit orders. HOLD is a safety decision, not a price prediction.

## Run locally

Node.js 22 is required. Run \`npm ci\`, then \`npm run dev\`; run \`npm run check\`, \`npm test\`, and \`npm run build\` before changes. Configure local environment variables privately using the names in \`.env.example\`; never commit real values. A compatible PostgreSQL database and supported market-data sources are required for live collection.

See [PUBLIC_AUDIT.md](PUBLIC_AUDIT.md) for the precise decision rule, evidence limitations, file map, and test commands. This repository contains all current application source, tests, and migration definitions, including historical custody/auth schemas. It intentionally excludes deployment configuration, production data, backup files, images, internal release notes, workspace metadata, and the original private Git history.

Availability checks and indicative market odds are not a calibrated predictive confidence score. Neither a backtest nor an observed probability establishes a profitable executable trade.
`;

const target = await mkdtemp(join(tmpdir(), "signal-desk-public-"));
const copied: string[] = [];
const actualRoot = await realpath(root);

async function copySource(path: string) {
  const source = resolve(root, path);
  if (!relative(root, source) || relative(root, source).startsWith("..")) {
    throw new Error(`Source outside allowed project tree: ${path}`);
  }
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing non-file: ${path}`);
  const actualSource = await realpath(source);
  if (relative(actualRoot, actualSource).startsWith("..")) throw new Error(`Refusing symlinked parent: ${path}`);
  if (info.size > 1_000_000) throw new Error(`Review unexpectedly large source file: ${path}`);
  const content = await readFile(source);
  if (forbidden.test(content.toString("utf8"))) throw new Error(`Potential credential in ${path}; review before export`);
  const destination = join(target, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content);
  copied.push(path);
}

for (const file of manifest) await copySource(file);
try { await lstat(join(root, "LICENSE")); await copySource("LICENSE"); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
await writeFile(join(target, "README.md"), publicReadme);
copied.push("README.md");
console.log(`Staged ${copied.length} source/configuration files in ${target}.`);
console.log("Fresh repository only. Do not publish the existing Git history or the full workspace.");