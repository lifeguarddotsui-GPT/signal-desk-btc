// Read-only report for the bounded Cloudflare WaterX source-only trial.
// Cloudflare credentials are used only in request headers and never emitted.
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createCoverageSummary, expectedRoundStarts } from "./cloudflare-waterx-report-coverage.mjs";
import { fullWindowValidity } from "./cloudflare-waterx-report-assessment.mjs";
import { analyzeSettlementEvidence } from "./cloudflare-waterx-report-settlements.mjs";
import {
  buildMonthlyProjection,
  metricsWindowIsFullDay,
} from "./cloudflare-waterx-report-resources.mjs";
import {
  getEndpoint,
  readPrivateEvidence,
  reportD1ReadAccounting,
  verifiedResources,
} from "./cloudflare-waterx-report-cloudflare.mjs";

export {
  analyzeSettlementEvidence,
  buildMonthlyProjection,
  createCoverageSummary,
  expectedRoundStarts,
  fullWindowValidity,
  metricsWindowIsFullDay,
};

const execFile = promisify(execFileCallback);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = "waterx-edge-prototype";
const DATABASE = "waterx-edge-prototype";
const START_MS = 1_790_805_764_752;
const DUE_MS = 1_790_892_164_752;
const STOP_MS = 1_790_899_364_752;
const DAY_MS = 86_400_000;
const INTERVALS = [5, 15];
const MARKET_IDS = {
  5: "9129d50d-6e9c-4c1d-b4af-a76b5993bf85",
  15: "3bad357c-3e20-4533-b8c4-e4938dfe30b6",
};
const SOURCE_FILES = [
  "edge/worker.ts",
  "edge/0001_schema.sql",
  "server/waterx/source.ts",
  "scripts/cloudflare-waterx-trial.mjs",
  "scripts/cloudflare-waterx-metrics.mjs",
  "scripts/cloudflare-waterx-report-cloudflare.mjs",
  "scripts/cloudflare-waterx-report-coverage.mjs",
  "scripts/cloudflare-waterx-report-assessment.mjs",
  "scripts/cloudflare-waterx-report-settlements.mjs",
  "scripts/cloudflare-waterx-report-resources.mjs",
  "docs/waterx-trial-report-contract.md",
];

function parseArgs(args) {
  let preview = false;
  let out;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--preview") {
      preview = true;
    } else if (arg === "--out") {
      if (!args[index + 1] || args[index + 1].startsWith("--"))
        throw new Error("--out requires a file path.");
      out = args[++index];
    } else if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
      if (!out) throw new Error("--out requires a file path.");
    } else {
      throw new Error("Supported options are --preview and --out <path>.");
    }
  }
  return { preview, out };
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function redact(value) {
  const secrets = [process.env.CLOUDFLARE_API_KEY, process.env.CLOUDFLARE_EMAIL]
    .filter(secret => typeof secret === "string" && secret.length > 0);
  if (typeof value === "string")
    return secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /authorization|api.?key|token|secret|email/i.test(key) ? "[REDACTED]" : redact(item),
    ]));
  }
  return value;
}

async function readMetricsHelper(resources, fromMs, toMs) {
  if (!resources.bindingVerified) return {
    availability: "unavailable",
    reason: "isolated_trial_binding_not_verified",
  };
  try {
    const helper = resolve(ROOT, "scripts/cloudflare-waterx-metrics.mjs");
    const { stdout } = await execFile(process.execPath, [
      helper, "--from", iso(fromMs), "--to", iso(toMs),
    ], {
      cwd: ROOT,
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        CLOUDFLARE_API_KEY: process.env.CLOUDFLARE_API_KEY,
        CLOUDFLARE_EMAIL: process.env.CLOUDFLARE_EMAIL,
      },
    });
    const metrics = JSON.parse(stdout);
    const resourceMatch = metrics.resources?.d1?.id === resources.database.uuid &&
      metrics.resources?.worker?.name === WORKER &&
      metrics.resources?.durableObjectNamespace?.id ===
        resources.bindings.durableObjectNamespaceId;
    const requestedWindowMatches = metrics.timeWindow?.start === iso(fromMs) &&
      metrics.timeWindow?.end === iso(toMs) &&
      Number(metrics.timeWindow?.durationSeconds) === (toMs - fromMs) / 1000;
    if (!resourceMatch || !requestedWindowMatches) return {
      availability: "unavailable",
      reason: !resourceMatch
        ? "metrics_helper_resources_do_not_match_verified_trial_bindings"
        : "metrics_helper_window_does_not_match_requested_fixed_trial_window",
      resourceMatch,
      requestedWindowMatches,
      timeWindow: metrics.timeWindow ?? null,
      datasets: metrics.datasets ?? {},
    };
    return { ...metrics, resourceMatch: true };
  } catch {
    return { availability: "unavailable", reason: "read_only_cloudflare_metrics_helper_failed" };
  }
}

async function sourceStamps() {
  const sources = {};
  for (const relativePath of SOURCE_FILES) {
    try {
      const bytes = await readFile(resolve(ROOT, relativePath));
      sources[relativePath] = { sha256: sha256(bytes), availability: "available" };
    } catch {
      sources[relativePath] = { sha256: null, availability: "unavailable" };
    }
  }
  const ownScript = await readFile(fileURLToPath(import.meta.url));
  sources["scripts/cloudflare-waterx-report.mjs"] = {
    sha256: sha256(ownScript),
    availability: "available",
  };
  return sources;
}

function makeHealthSummary(healthEndpoint) {
  const health = healthEndpoint?.body ?? {};
  const endpointStartedAt = numeric(health.startedAtMs);
  return {
    endpointAvailability: healthEndpoint?.availability ?? "unavailable",
    expectedCollectorStartMs: START_MS,
    expectedCollectorStart: iso(START_MS),
    observedCollectorStartMs: endpointStartedAt,
    observedCollectorStart: iso(endpointStartedAt),
    startMatchesExpected: endpointStartedAt === START_MS,
    reportedTrialStatus: health.trialStatus ?? null,
    reportedStopsAtMs: numeric(health.stopsAtMs),
    observedHealth: health,
    browserIndependence: {
      collectorTopologyRequiresBrowser: health.browserRequired === true
        ? "yes" : healthEndpoint?.availability === "available"
          ? "no_per_worker_health_endpoint" : "not_measured",
      everyBrowserActuallyClosed: "unknown_not_measured",
    },
  };
}

function buildErrorReport(health, settlement) {
  const evidence = health?.observedHealth?.health;
  if (!Array.isArray(evidence)) return {
    status: "not_measured",
    source: "health endpoint unavailable",
    historicalProviderErrorEvents: "unknown_not_persisted_as_a_counter",
  };
  const current = evidence.map(item => ({
    intervalMinutes: item.intervalMinutes,
    currentLastError: item.lastError ?? null,
    currentD1Error: item.d1Error ?? null,
    currentSettlementError: item.settlementError ?? null,
    retries: numeric(item.retries),
  }));
  return {
    status: "verified_observed_current_state_only",
    current,
    currentProviderErrorStates: current.filter(item => item.currentLastError).length,
    currentD1ErrorStates: current.filter(item => item.currentD1Error).length,
    currentSettlementErrorStates: current.filter(item => item.currentSettlementError).length,
    persistedHistoricalErrorCounter: "unknown_not_persisted",
    persistedSettlementReadErrorEvents:
      settlement?.persistedReadErrorEvidenceCount ?? "unknown_private_d1_unavailable",
    persistedSettlementReadErrorReasons:
      settlement?.persistedReadErrorReasons ?? "unknown_private_d1_unavailable",
  };
}

async function main() {
  const { preview, out } = parseArgs(process.argv.slice(2));
  const checkedAtMs = Date.now();
  if (!preview && checkedAtMs < DUE_MS)
    throw new Error(`The fixed first 24 hours do not complete until ${iso(DUE_MS)}; use --preview only for an explicitly incomplete read-only report.`);

  const metricsEndMs = Math.min(DUE_MS, Math.max(START_MS, checkedAtMs));
  const resources = await verifiedResources();
  const endpoints = await Promise.all(["health", "latest", "coverage"].map(path =>
    getEndpoint(resources.workerUrl, path)));
  const health = makeHealthSummary(endpoints.find(endpoint => endpoint.path === "health"));

  let privateEvidence = { availability: "unavailable", reason: "verified_isolated_d1_binding_required" };
  let summaries = [];
  let settlement = null;
  if (resources.bindingVerified) {
    try {
      privateEvidence = {
        ...await readPrivateEvidence(resources.accountId, resources.database.uuid),
        availability: "available",
        readOnly: true,
        queryMode: "SELECT only",
        reportQueryMetadata: reportD1ReadAccounting,
      };
      summaries = INTERVALS.map(interval => createCoverageSummary(interval, privateEvidence));
      settlement = analyzeSettlementEvidence(
        privateEvidence.settlements, privateEvidence.firstRounds,
      );
    } catch {
      privateEvidence = {
        availability: "unavailable",
        reason: "one_or_more_read_only_private_d1_queries_failed",
        readOnly: true,
      };
    }
  }

  const metrics = await readMetricsHelper(resources, START_MS, metricsEndMs);
  const elapsedBeforeStop = checkedAtMs < STOP_MS;
  const full24h = fullWindowValidity(checkedAtMs, preview, health, summaries);
  const metricsData = metrics.availability === "unavailable" ? null : metrics;
  const d1WindowComplete = !preview && full24h.full24HoursElapsed &&
    full24h.privateEvidenceHasBothIntervals &&
    Object.values(full24h.directD1AccountingCompletePerInterval).length === 2 &&
    Object.values(full24h.directD1AccountingCompletePerInterval).every(Boolean) &&
    Object.values(full24h.sourceIdentityVerifiedPerInterval).length === 2 &&
    Object.values(full24h.sourceIdentityVerifiedPerInterval).every(Boolean) &&
    full24h.collectionGapProofComplete;
  const resourceMetrics = buildMonthlyProjection(
    metricsData, d1WindowComplete, { startMs: START_MS, endMs: metricsEndMs },
  );
  resourceMetrics.separateOneTimeCosts.reportD1Reads =
    privateEvidence.availability === "available" &&
      reportD1ReadAccounting.metadataComplete
      ? {
        readOnlyQueries: reportD1ReadAccounting.queryCount,
        rowsRead: reportD1ReadAccounting.rowsRead,
        rowsWritten: reportD1ReadAccounting.rowsWritten,
        source: "D1 API query metadata for this report's SELECT statements",
      }
      : {
        status: "not_measured",
        readOnlyQueriesAttempted: reportD1ReadAccounting.queryCount,
        rowsReadObservedSoFar: reportD1ReadAccounting.rowsRead,
        metadataComplete: reportD1ReadAccounting.metadataComplete,
      };
  resourceMetrics.separateOneTimeCosts.reportWorkerEndpointRequests = {
    requestsAttempted: endpoints.length,
    source: "this report's health/latest/coverage GET attempts",
    includedInCloudflareAnalyticsIfTheirAnalyticsWindowOverlaps: true,
    subtractedFromSteadyCollectionTotals: false,
  };
  const output = redact({
    reportType: "cloudflare-waterx-source-only-trial-evidence",
    generatedAt: iso(checkedAtMs),
    preview,
    readOnly: true,
    mutationStatus: "no_cloudflare_mutations_performed",
    paidSubscriptions: resources.subscriptions,
    trialTimeline: {
      collectorStartMs: START_MS,
      collectorStart: iso(START_MS),
      fixedFirst24hDueMs: DUE_MS,
      fixedFirst24hDue: iso(DUE_MS),
      collectorStopMs: STOP_MS,
      collectorStop: iso(STOP_MS),
      fixedFirst24hDurationMs: DAY_MS,
      checkedBeforeFixedStop: elapsedBeforeStop,
      reportProcessDoesNotControlCollectorStop: true,
      minuteCronMayContinueAfterPollingStops: true,
    },
    windowAssessment: full24h,
    sourceStamp: {
      localSourceFiles: await sourceStamps(),
      deployedWorkerSourceHash: "not_exposed_by_read_only_cloudflare_resource_metadata",
      sourceIdentity: {
        worker: WORKER,
        d1Database: DATABASE,
        marketsByInterval: MARKET_IDS,
      },
    },
    verifiedResources: {
      bindingVerified: resources.bindingVerified,
      verificationReason: resources.verificationReason ?? null,
      worker: WORKER,
      workerUrl: resources.workerUrl ?? null,
      database: resources.database ? {
        name: resources.database.name,
        id: resources.database.uuid,
        listedFileSizeBytes: resources.database.file_size ?? null,
        listedFileSizeFreshness: "resource-list size may lag; analytics/helper and Worker results are separately reported",
      } : null,
      bindings: resources.bindings ?? null,
      accountSubscriptions: resources.subscriptions,
    },
    workerEndpoints: endpoints,
    privateD1Evidence: {
      availability: privateEvidence.availability,
      reason: privateEvidence.reason ?? null,
      readOnly: privateEvidence.readOnly ?? true,
      queryMode: privateEvidence.queryMode ?? "SELECT only",
      reportQueryMetadata: privateEvidence.reportQueryMetadata ??
        reportD1ReadAccounting,
      rowCounts: privateEvidence.availability === "available" ? {
        coverage: privateEvidence.coverage.length,
        firstRounds: privateEvidence.firstRounds.length,
        snapshots: privateEvidence.snapshots.length,
        settlementProbes: privateEvidence.settlements.length,
      } : null,
    },
    healthAndTopology: health,
    persistedWaterXErrors: buildErrorReport(health, settlement),
    fixedFirst24HoursByInterval: summaries.map(item => item.fixedFirst24Hours),
    initialAndTerminalPartialRoundsByInterval: summaries.map(item => ({
      intervalMinutes: item.intervalMinutes,
      ...item.trialBoundaryPartialRounds,
    })),
    settlementLabels: settlement ?? {
      status: "not_measured",
      reason: "verified_isolated_d1_binding_or_private_evidence_unavailable",
      independentlyAuditCompleteDistinctLabels: 0,
    },
    predictionEvaluation: {
      frozenIndependentModelPredictions: 0,
      predictionAccuracy: "not measured",
      activeLearning: "not measured",
      verifiedSettlementLabelsAreProspectiveResults: false,
    },
    cloudflareMetrics: metricsData ?? {
      availability: "unavailable",
      reason: metrics.reason ?? "metrics_helper_result_unavailable",
    },
    resourceProjection: resourceMetrics,
    browserClosureClaim: "A server-side Worker can operate without a browser, but whether every browser was closed is unknown and not measured.",
    deploymentAndApplicationCompatibility: {
      existingAppOrUICompatibility: "not assessed by this read-only trial report",
      productionAdapterEnabled: false,
      productionChangesMade: false,
    },
    reportLimitations: [
      "Worker health/coverage/latest endpoint failures are reported as unavailable rather than treated as zero.",
      "Persisted WaterX provider-error event totals are not available as historical counters; current health errors are point-in-time observations.",
      "The 30-second D1 snapshots provide only a coarse observation-gap bound; waterx_edge_coverage.max_freshness_age_ms is the collector's per-round poll-derived maximum.",
      "D1 settlement evidence does not persist provider marketId or the raw provider response; Worker-side market identity checks therefore cannot be independently audited from D1.",
      "Worker VERIFIED settlement anchors are confirmed but need not numerically match the provisional prospective anchor; VERIFIED rounds stop receiving subsequent probes, so later provider revisions are not detected.",
      "No prediction accuracy or active-learning result is inferred from coverage or settlement labels.",
      "This report cannot prove every browser was closed, and does not establish compatibility with the existing application/API/UI.",
      "Cloudflare metrics may be unavailable, lagged, partial, or truncated. Unknown telemetry is not reported as zero.",
      "Analytics windows are requested for the fixed trial start through its due time; datasets are aggregated at Cloudflare-provided granularities and may have field-specific lag.",
    ],
  });

  const defaultPath = resolve(ROOT, ".local/edge-trial",
    `waterx-report-${checkedAtMs}.json`);
  const outputPath = out
    ? isAbsolute(out) ? out : resolve(process.cwd(), out)
    : defaultPath;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    reportPath: outputPath,
    generatedAt: output.generatedAt,
    preview: output.preview,
    windowAssessment: output.windowAssessment.status,
    bindingVerified: output.verifiedResources.bindingVerified,
    privateEvidence: output.fixedFirst24HoursByInterval.length
      ? "available" : "unavailable",
    workerVerifiedLabels: output.settlementLabels.workerVerifiedDistinctOutcomeLabels ?? 0,
    independentlyAuditCompleteLabels:
      output.settlementLabels.independentlyAuditCompleteDistinctLabels ?? 0,
    metricsAvailability: output.cloudflareMetrics.availability ?? "available",
    metricsWindow: output.resourceProjection.metricsWindow,
  }, null, 2));
}

const isDirectRun = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await main();