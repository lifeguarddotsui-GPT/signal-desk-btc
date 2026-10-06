// Best-effort development-workspace reporting only. This never controls the
// Cloudflare collector and is not a durable scheduled service.
import { execFile as execFileCallback } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_AFTER_MS = Date.parse("2026-10-01T22:03:00.000Z");
const REPORT_FILE = ".local/edge-trial/24-hour-report.json";
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

export function reportDelayMs(nowMs) {
  return Math.max(0, REPORT_AFTER_MS - nowMs);
}

async function main() {
  if (process.argv.slice(2).some(arg => arg !== "--dry-run"))
    throw new Error("Only --dry-run is supported.");
  console.log(JSON.stringify({
    purpose: "read-only trial report; no collector or production changes",
    reportNotBeforeUtc: new Date(REPORT_AFTER_MS).toISOString(),
    reportFile: REPORT_FILE,
    remainingMs: reportDelayMs(Date.now()),
    persistence: "best-effort only; lost if the development workspace stops",
    paidSchedulingEnabled: false,
  }));
  if (process.argv.includes("--dry-run")) return;

  while (reportDelayMs(Date.now()) > 0)
    await sleep(Math.min(reportDelayMs(Date.now()), 15 * 60_000));

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { stdout } = await execFile(process.execPath, [
        resolve(ROOT, "scripts/cloudflare-waterx-report.mjs"),
        "--out", resolve(ROOT, REPORT_FILE),
      ], { cwd: ROOT, timeout: 300_000, maxBuffer: 1024 * 1024 });
      const summary = JSON.parse(stdout);
      console.log(`WATERX_24H_REPORT_READY ${JSON.stringify(summary)}`);
      return;
    } catch (error) {
      // Do not log subprocess environment, request headers, or arbitrary
      // stderr. The report itself also redacts its evidence.
      console.log(JSON.stringify({
        event: "read-only report attempt failed",
        attempt,
        error: typeof error.code === "string" &&
          /^[A-Z0-9_]+$/.test(error.code) ? error.code : "REPORT_UNAVAILABLE",
      }));
      if (attempt < 3) await sleep(2 * 60_000);
    }
  }
  console.log("WATERX_24H_REPORT_UNAVAILABLE");
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();