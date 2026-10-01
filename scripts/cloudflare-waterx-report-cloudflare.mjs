const API = "https://api.cloudflare.com/client/v4";
const WORKER = "waterx-edge-prototype";
const DATABASE = "waterx-edge-prototype";
const START_MS = 1_790_805_764_752;
const DUE_MS = 1_790_892_164_752;
const STOP_MS = 1_790_899_364_752;
const INTERVALS = [5, 15];

export const reportD1ReadAccounting = {
  queryCount: 0,
  rowsRead: 0,
  rowsWritten: 0,
  metadataQueries: 0,
  metadataComplete: true,
};

function errorKind(error) {
  const code = error?.cause?.code ?? error?.code;
  if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) return code;
  return error?.name === "TimeoutError" || error?.name === "AbortError"
    ? "TIMEOUT" : "REQUEST_FAILED";
}

function authHeaders() {
  const key = process.env.CLOUDFLARE_API_KEY;
  const email = process.env.CLOUDFLARE_EMAIL;
  if (!key || !email)
    throw new Error("Set CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL through Secrets.");
  return {
    "X-Auth-Key": key,
    "X-Auth-Email": email,
    Accept: "application/json",
  };
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

async function cloudflareGet(path) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    throw new Error(`Cloudflare read failed (${errorKind(error)}).`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Cloudflare read returned non-JSON HTTP ${response.status}.`);
  }
  if (!response.ok || body.success !== true) {
    const codes = (body.errors ?? []).map(item => item.code)
      .filter(code => code !== undefined).join(",");
    throw new Error(`Cloudflare read failed (HTTP ${response.status}; codes: ${codes || "unavailable"}).`);
  }
  return body.result;
}

async function cloudflareQuery(accountId, databaseId, sql, params = []) {
  if (!/^\s*SELECT\b/i.test(sql))
    throw new Error("Refusing a non-SELECT D1 statement.");
  let response;
  try {
    response = await fetch(
      `${API}/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
      {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ sql, params }),
        signal: AbortSignal.timeout(60_000),
      },
    );
  } catch (error) {
    throw new Error(`Read-only D1 query failed (${errorKind(error)}).`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Read-only D1 query returned non-JSON HTTP ${response.status}.`);
  }
  if (!response.ok || body.success !== true)
    throw new Error(`Read-only D1 query failed (HTTP ${response.status}).`);
  const result = body.result;
  if (!Array.isArray(result) || result.some(item => item.success === false || item.error))
    throw new Error("Read-only D1 query returned an unsuccessful result.");
  reportD1ReadAccounting.queryCount++;
  const metadata = result.map(item => item.meta).filter(Boolean);
  if (!metadata.length) {
    reportD1ReadAccounting.metadataComplete = false;
  } else {
    reportD1ReadAccounting.metadataQueries++;
    if (metadata.some(meta => !Number.isFinite(Number(meta.rows_read)))) {
      reportD1ReadAccounting.metadataComplete = false;
    } else {
      reportD1ReadAccounting.rowsRead += metadata.reduce((sum, meta) =>
        sum + Number(meta.rows_read), 0);
    }
    reportD1ReadAccounting.rowsWritten += metadata.reduce((sum, meta) =>
      sum + Number(meta.rows_written ?? meta.changes ?? 0), 0);
  }
  return result.flatMap(item => Array.isArray(item.results) ? item.results : []);
}

export async function getEndpoint(url, path) {
  if (!url) return { path, availability: "unavailable", reason: "worker_url_unavailable" };
  try {
    const response = await fetch(`${url}/${path}`, { signal: AbortSignal.timeout(30_000) });
    let body = null;
    try { body = redact(await response.json()); } catch { /* keep malformed body unavailable */ }
    return {
      path,
      availability: response.ok && body !== null ? "available" : "unavailable",
      http: response.status,
      ...(body === null ? { reason: "non_json_response" } : { body }),
    };
  } catch (error) {
    return { path, availability: "unavailable", error: errorKind(error) };
  }
}

export async function verifiedResources() {
  const accounts = await cloudflareGet("/accounts?per_page=50");
  if (!Array.isArray(accounts) || accounts.length !== 1)
    throw new Error(`Expected exactly one Cloudflare account; received ${Array.isArray(accounts) ? accounts.length : "an invalid response"}.`);
  const accountId = accounts[0].id;
  const subscriptions = await cloudflareGet(`/accounts/${encodeURIComponent(accountId)}/subscriptions`);
  if (!Array.isArray(subscriptions) || subscriptions.length !== 0)
    throw new Error("Cloudflare account subscriptions are not empty; refusing a possibly paid account.");

  const [databaseResult, settingsResult, subdomainResult] = await Promise.allSettled([
    cloudflareGet(`/accounts/${encodeURIComponent(accountId)}/d1/database?per_page=100`),
    cloudflareGet(`/accounts/${encodeURIComponent(accountId)}/workers/scripts/${WORKER}/settings`),
    cloudflareGet(`/accounts/${encodeURIComponent(accountId)}/workers/subdomain`),
  ]);
  const databases = databaseResult.status === "fulfilled" ? databaseResult.value : [];
  const settings = settingsResult.status === "fulfilled" ? settingsResult.value : null;
  const subdomain = subdomainResult.status === "fulfilled" ? subdomainResult.value?.subdomain : null;
  const database = Array.isArray(databases)
    ? databases.find(item => item.name === DATABASE) : null;
  const dbBinding = (settings?.bindings ?? []).find(binding =>
    binding.name === "DB" && binding.type === "d1");
  const doBinding = (settings?.bindings ?? []).find(binding =>
    binding.name === "WATERX_COLLECTOR" &&
    binding.type === "durable_object_namespace");
  const isTrial = Boolean(database && settings &&
    dbBinding?.id === database.uuid &&
    doBinding?.class_name === "WaterxCollector" &&
    settings.annotations?.["workers/message"]?.startsWith(
      "Source-only bounded Free-tier trial;",
    ));
  if (!isTrial)
    return {
      accountId, subscriptions: 0, database, settings, subdomain,
      bindingVerified: false,
      verificationReason: "worker_or_d1_is_not_the_named_isolated_source_only_trial",
    };
  return {
    accountId,
    subscriptions: 0,
    database,
    settings,
    subdomain,
    bindingVerified: true,
    workerUrl: subdomain ? `https://${WORKER}.${subdomain}.workers.dev` : null,
    bindings: {
      databaseId: database.uuid,
      databaseBindingName: dbBinding.name,
      durableObjectClass: doBinding.class_name,
      durableObjectNamespaceId: doBinding.namespace_id ?? doBinding.id ?? null,
    },
    ...(databaseResult.status === "rejected" ? { databaseListUnavailable: true } : {}),
    ...(settingsResult.status === "rejected" ? { settingsUnavailable: true } : {}),
    ...(subdomainResult.status === "rejected" ? { subdomainUnavailable: true } : {}),
  };
}

function floorTo(value, step) {
  return Math.floor(value / step) * step;
}

function queryBounds(intervalMinutes) {
  const step = intervalMinutes * 60_000;
  const firstBoundary = floorTo(START_MS, step);
  const terminalBoundary = floorTo(STOP_MS, step);
  return { firstBoundary, afterTerminalBoundary: terminalBoundary + step };
}

export async function readPrivateEvidence(accountId, databaseId) {
  const [coverage, firstRounds, snapshots] = await Promise.all([
    cloudflareQuery(accountId, databaseId, `
      SELECT interval_minutes AS intervalMinutes,
             expected_round_start_ms AS expectedStartMs,
             expected_round_id AS expectedRoundId,
             first_success_at_ms AS firstSuccessAtMs,
             last_success_at_ms AS lastSuccessAtMs,
             max_freshness_age_ms AS maxFreshnessAgeMs,
             max_scheduled_delay_ms AS maxScheduledDelayMs,
             had_gap AS hadGap
        FROM waterx_edge_coverage
       WHERE expected_round_start_ms >= ? AND expected_round_start_ms < ?
       ORDER BY interval_minutes, expected_round_start_ms`,
    [
      Math.min(...INTERVALS.map(interval => queryBounds(interval).firstBoundary)),
      Math.max(...INTERVALS.map(interval => queryBounds(interval).afterTerminalBoundary)),
    ]),
    cloudflareQuery(accountId, databaseId, `
      SELECT interval_minutes AS intervalMinutes,
             round_id AS roundId, market_id AS marketId,
             round_starts_at_ms AS startsAtMs, round_ends_at_ms AS endsAtMs,
             first_observed_at_ms AS firstObservedAtMs,
             up_probability_cents AS upProbabilityCents,
             down_probability_cents AS downProbabilityCents,
             up_odds_cents AS upOddsCents,
             down_odds_cents AS downOddsCents,
             reference_price AS referencePrice,
             reference_confirmed AS referenceConfirmed,
             quote_source AS source
        FROM waterx_round_first
       WHERE round_starts_at_ms >= ? AND round_starts_at_ms < ?
       ORDER BY interval_minutes, round_starts_at_ms`,
    [
      Math.min(...INTERVALS.map(interval => queryBounds(interval).firstBoundary)),
      Math.max(...INTERVALS.map(interval => queryBounds(interval).afterTerminalBoundary)),
    ]),
    cloudflareQuery(accountId, databaseId, `
      SELECT interval_minutes AS intervalMinutes,
             round_id AS roundId,
             observed_bucket_ms AS observedBucketMs,
             observed_at_ms AS observedAtMs,
             scheduled_at_ms AS scheduledAtMs,
             up_probability_cents AS upProbabilityCents,
             down_probability_cents AS downProbabilityCents,
             up_odds_cents AS upOddsCents,
             down_odds_cents AS downOddsCents,
             reference_price AS referencePrice,
             reference_confirmed AS referenceConfirmed,
             round_starts_at_ms AS startsAtMs,
             round_ends_at_ms AS endsAtMs,
             source
        FROM waterx_snapshots
       WHERE observed_at_ms >= ? AND observed_at_ms < ?
       ORDER BY interval_minutes, observed_at_ms`,
    [
      Math.min(...INTERVALS.map(interval => queryBounds(interval).firstBoundary)),
      Math.max(...INTERVALS.map(interval => queryBounds(interval).afterTerminalBoundary)),
    ]),
  ]);
  const settlements = await cloudflareQuery(accountId, databaseId, `
    SELECT e.interval_minutes AS intervalMinutes,
           e.expected_round_id AS expectedRoundId,
           e.probe_bucket_ms AS probeBucketMs,
           e.observed_at_ms AS observedAtMs,
           e.expected_closing_epoch AS expectedClosingEpoch,
           e.provider_round_id AS providerRoundId,
           e.provider_closing_epoch AS providerClosingEpoch,
           e.provider_status AS providerStatus,
           e.provider_outcome AS providerOutcome,
           e.provider_settled_at_epoch AS providerSettledAtEpoch,
           e.provider_settle_price AS providerSettlePrice,
           e.provider_anchor_price AS providerAnchorPrice,
           e.provider_anchor_confirmed AS providerAnchorConfirmed,
           e.verdict AS verdict,
           e.reason AS reason,
           e.source AS source,
           r.market_id AS expectedMarketId,
           r.round_starts_at_ms AS expectedRoundStartMs,
           r.round_ends_at_ms AS expectedRoundEndMs
      FROM waterx_settlement_evidence AS e
      JOIN waterx_round_first AS r
        ON r.interval_minutes = e.interval_minutes
       AND r.round_id = e.expected_round_id
     WHERE r.round_starts_at_ms >= ? AND r.round_starts_at_ms < ?
     ORDER BY e.interval_minutes, e.expected_round_id, e.observed_at_ms, e.probe_bucket_ms`,
  [START_MS, DUE_MS]);
  return { coverage, firstRounds, snapshots, settlements };
}