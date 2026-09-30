import { mkdtemp, readFile, mkdir, writeFile, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative } from "node:path";

// Never push this workspace's existing Git history: it contains uploaded images.
// Every publicly copied file must appear in this reviewed manifest.
const root = resolve(import.meta.dirname, "..");
const manifest = [
  ".env.example", ".gitignore", ".npmrc", "PUBLIC_AUDIT.md",
  "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts",
  "client/index.html", "client/public/favicon.svg", "client/public/favicon-mono.svg",
  "client/src/App.tsx", "client/src/AdvisoryCards.tsx", "client/src/IndicativeEstimate.tsx", "client/src/advisory-contract.ts", "client/src/advisory-contract.test.ts", "client/src/browser-latency.ts", "client/src/chart-contract.ts", "client/src/economics-contract.ts",
  "client/src/index.css", "client/src/main.tsx", "client/src/waterx-ui-contract.ts",
  "server/btc/advisor.ts", "server/btc/artifact.ts", "server/btc/build-info.ts",
  "server/btc/chart.ts", "server/btc/chart-history.ts", "server/btc/coinbase-stream.ts", "server/btc/economics.ts", "server/btc/economics-feed.ts",
  "server/btc/engine.ts", "server/btc/evidence.ts", "server/btc/model.ts", "server/btc/reporting.ts",
  "server/btc/policy.ts", "server/btc/service.ts", "server/btc/source.ts", "server/btc/store.ts",
  "server/waterx/advisory.ts", "server/waterx/background-queue.ts", "server/waterx/candidate-capture.ts", "server/waterx/candidate-runtime.ts", "server/waterx/candidate-status.ts", "server/waterx/coverage.ts",
  "server/waterx/candidate-training.ts", "server/waterx/diagnostics.ts", "server/waterx/latency.ts",
  "server/waterx/learning.ts", "server/waterx/service.ts", "server/waterx/source.ts", "server/waterx/types.ts", "server/waterx/worker.ts",
  "server/index.ts", "server/routes.ts", "server/static.ts", "server/vite.ts",
  "script/build.ts", "scripts/advisor.test.ts", "scripts/artifact.test.ts", "scripts/backfill.ts",
  "scripts/btc.test.ts", "scripts/chart.test.ts", "scripts/chart-contract.test.ts", "scripts/chart-stream-integration.test.ts", "scripts/coinbase-stream.test.ts", "scripts/economics.test.ts",
  "scripts/economics-client.test.ts", "scripts/economics-feed.test.ts", "scripts/evidence.test.ts",
  "scripts/export-public.ts", "scripts/lockfile.test.ts", "scripts/model.test.ts", "scripts/train-waterx-candidate.ts",
  "scripts/vm-production-supervisor.mjs", "scripts/vm-production-supervisor.test.ts", "scripts/waterx-worker-lifecycle.test.ts",
  "scripts/pipeline.test.ts", "scripts/policy.test.ts", "scripts/reporting.test.ts",
  "scripts/waterx-advisory.test.ts", "scripts/waterx-browser-latency.test.ts", "scripts/waterx-candidate-runtime.test.ts", "scripts/waterx-collector-continuity.test.ts", "scripts/waterx-coverage.test.ts", "scripts/waterx-indicative-price.test.ts",
  "scripts/waterx-candidate-training.test.ts", "scripts/waterx-chart-history.test.ts", "scripts/waterx-diagnostics.test.ts",
  "scripts/waterx-latency.test.ts", "scripts/waterx-learning.test.ts", "scripts/waterx-round-guard.test.ts",
  "scripts/waterx-source.test.ts", "scripts/waterx-ui.test.ts", "client/src/chart-contract.test.ts", "client/src/waterx-ui-contract.test.ts",
  "migrations/0001_accumulation_foundation.sql", "migrations/0002_collector_checkpoint.sql",
  "migrations/0003_wallet_auth_challenges.sql", "migrations/0004_operational_trading_foundation.sql",
  "migrations/0005_durable_event_replay.sql", "migrations/0006_turnkey_custody.sql",
  "migrations/btc-learning.sql", "migrations/waterx-learning.sql",
  "migrations/waterx-candidate.sql", "migrations/waterx-comparison-ticks.sql",
];
const forbidden = /-----BEGIN [A-Z ]*PRIVATE KEY|(?:ghp_|gho_|github_pat_|sk_live_|xox[baprs]-)[A-Za-z0-9_-]{8,}/i;
const publicReadme = `# BluewaterAI

Advisory-only, read-only research for WaterX BTC 5-minute and 15-minute rounds. The interface describes market lean and data availability, but does not issue a qualified trade action, connect a wallet, sign, submit an order, or verify a fill. WaterX odds are market observations, not forecasts or executable quotes.

## Run locally

Node.js 22 is required. Run \`npm ci\`, then \`npm run dev\`; run \`npm run check\`, \`npm test\`, and \`npm run build\` before changes. Configure environment values privately; never commit real values. A compatible PostgreSQL database is needed for persisted learning observations.

See [PUBLIC_AUDIT.md](PUBLIC_AUDIT.md) for source interpretation, limitations, and tests. The WaterX provider API is unofficial and may change. WaterX's reported price-to-beat may be unconfirmed; Coinbase is comparison-only; displayed $5 gross-return arithmetic excludes unknown fees and gas. The product's Chainlink TWAP settlement description is not independently verified by this app.

Learning is prospective, interval-separated, and not model promotion. Data gaps are unknown; an idle autoscale deployment can sleep. Legacy DeepBook BTC material is retained as archive, not the current WaterX interface.

The allowlist intentionally includes legacy server modules required by retained routes/imports as well as WaterX modules, schema, and tests. It excludes deployment configuration, production data, backups, images, internal release notes, local workspace metadata, dated legacy audit reports, and the original private Git history.
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