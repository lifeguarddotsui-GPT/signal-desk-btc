// Direct API deployment avoids installing Wrangler. Never print credentials.
// This script only manages the isolated source-only trial, not the trading app.
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const SCRIPT = "waterx-edge-prototype";
const DB_NAME = "waterx-edge-prototype";
const API = "https://api.cloudflare.com/client/v4";
const headers = () => {
  if (!process.env.CLOUDFLARE_API_KEY || !process.env.CLOUDFLARE_EMAIL)
    throw new Error("Cloudflare API key and account email must be supplied through Secrets.");
  return {
    "X-Auth-Key": process.env.CLOUDFLARE_API_KEY,
    "X-Auth-Email": process.env.CLOUDFLARE_EMAIL,
    Accept: "application/json",
  };
};

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { ...headers(), ...options.headers },
    signal: AbortSignal.timeout(45_000),
  });
  const body = await response.json();
  if (!response.ok || !body.success) {
    const codes = body.errors?.map(e => ({ code: e.code, message: e.message }));
    throw new Error(`Cloudflare ${path}: HTTP ${response.status} ${JSON.stringify(codes)}`);
  }
  return body.result;
}

const jsonOptions = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function account() {
  const accounts = await api("/accounts?per_page=50");
  if (accounts.length !== 1)
    throw new Error("Expected exactly one Cloudflare account; choose the account explicitly.");
  return accounts[0].id;
}

async function assertFree(id) {
  const subscriptions = await api(`/accounts/${id}/subscriptions`);
  // Deliberately fail closed, even for a subscription to an unrelated product.
  if (subscriptions.length !== 0)
    throw new Error("Account has subscriptions. Stop and verify prices before any provisioning.");
}

async function subdomain(id, create = false) {
  try {
    return (await api(`/accounts/${id}/workers/subdomain`)).subdomain;
  } catch (error) {
    if (!create || !String(error).includes('"code":10007')) throw error;
    return (await api(`/accounts/${id}/workers/subdomain`,
      jsonOptions("PUT", { subdomain: `waterx-source-${id.slice(0, 8)}` }))).subdomain;
  }
}

async function database(id, create = false) {
  const databases = await api(`/accounts/${id}/d1/database`);
  let db = databases.find(d => d.name === DB_NAME);
  if (!db && create)
    db = await api(`/accounts/${id}/d1/database`,
      jsonOptions("POST", { name: DB_NAME, primary_location_hint: "enam" }));
  if (!db) throw new Error("The trial D1 database does not exist.");
  return db;
}

async function query(id, dbId, sql, params = []) {
  const result = await api(`/accounts/${id}/d1/database/${dbId}/query`,
    jsonOptions("POST", { sql, params }));
  if (result.some(r => r.success === false || r.error))
    throw new Error(`Trial D1 query failed: ${JSON.stringify(result.map(r => r.error))}`);
  return result;
}

async function upload(id, dbId) {
  const bundle = await build({
    entryPoints: ["edge/worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  await assertFree(id);
  const form = new FormData();
  form.set("metadata", JSON.stringify({
    main_module: "worker.mjs",
    compatibility_date: "2026-09-30",
    bindings: [
      { type: "d1", name: "DB", id: dbId },
      { type: "durable_object_namespace", name: "WATERX_COLLECTOR", class_name: "WaterxCollector" },
    ],
    exports: { WaterxCollector: { type: "durable-object", storage: "sqlite" } },
    observability: {
      enabled: true,
      head_sampling_rate: 1,
      logs: { enabled: true, invocation_logs: true, head_sampling_rate: 1 },
    },
    logpush: false,
    annotations: { "workers/message": "Source-only bounded Free-tier trial; production unchanged." },
  }));
  form.set("worker.mjs", new Blob([bundle.outputFiles[0].text],
    { type: "application/javascript+module" }), "worker.mjs");
  const uploaded = await api(`/accounts/${id}/workers/scripts/${SCRIPT}`,
    { method: "PUT", body: form });
  return { uploaded, bundleBytes: bundle.outputFiles[0].contents.byteLength };
}

async function deploy(id) {
  await assertFree(id);
  const [scripts, existingDatabases] = await Promise.all([
    api(`/accounts/${id}/workers/scripts`),
    api(`/accounts/${id}/d1/database`),
  ]);
  if (scripts.some(s => s.id === SCRIPT))
    throw new Error("Trial Worker already exists. Refusing an implicit overwrite.");
  if (existingDatabases.some(d => d.name === DB_NAME))
    throw new Error("Trial D1 already exists. Refusing to mix this trial with existing history.");
  const [db, host] = await Promise.all([database(id, true), subdomain(id, true)]);
  await query(id, db.uuid, await readFile("edge/0001_schema.sql", "utf8"));
  const { uploaded, bundleBytes } = await upload(id, db.uuid);
  await api(`/accounts/${id}/workers/scripts/${SCRIPT}/subdomain`,
    jsonOptions("POST", { enabled: true, previews_enabled: false }));
  await api(`/accounts/${id}/workers/scripts/${SCRIPT}/schedules`,
    jsonOptions("PUT", [{ cron: "* * * * *" }]));
  await assertFree(id);
  console.log(JSON.stringify({
    script: SCRIPT, databaseId: db.uuid,
    url: `https://${SCRIPT}.${host}.workers.dev`,
    deployedAt: new Date().toISOString(),
    upload: { id: uploaded.id, usage_model: uploaded.usage_model,
      durable_objects: uploaded.durable_objects },
    bundleBytes,
    paidSubscriptions: 0,
    note: "Cron can take up to 15 minutes to propagate. This does not prove 24h coverage.",
  }, null, 2));
}

async function update(id) {
  await assertFree(id);
  const db = await database(id);
  const settings = await api(`/accounts/${id}/workers/scripts/${SCRIPT}/settings`);
  const boundDb = settings.bindings?.find(b => b.name === "DB" && b.type === "d1");
  const boundDo = settings.bindings?.find(b =>
    b.name === "WATERX_COLLECTOR" && b.type === "durable_object_namespace");
  if (boundDb?.id !== db.uuid || boundDo?.class_name !== "WaterxCollector" ||
      !settings.annotations?.["workers/message"]?.startsWith("Source-only bounded Free-tier trial;"))
    throw new Error("Existing Worker is not the isolated source-only trial. Refusing to update.");
  const { bundleBytes } = await upload(id, db.uuid);
  await assertFree(id);
  console.log(JSON.stringify({
    script: SCRIPT, updatedAt: new Date().toISOString(), bundleBytes,
    paidSubscriptions: 0, preservedExistingTrialState: true,
  }, null, 2));
}

async function status(id) {
  await assertFree(id);
  const [db, host, settings, schedules] = await Promise.all([
    database(id), subdomain(id),
    api(`/accounts/${id}/workers/scripts/${SCRIPT}/settings`),
    api(`/accounts/${id}/workers/scripts/${SCRIPT}/schedules`),
  ]);
  const url = `https://${SCRIPT}.${host}.workers.dev`;
  const endpoints = await Promise.all(["health", "latest", "coverage"].map(async path => {
    try {
      const response = await fetch(`${url}/${path}`, { signal: AbortSignal.timeout(30_000) });
      return { path, http: response.status, body: await response.json() };
    } catch (error) {
      return { path, availability: "unavailable",
        error: error.cause?.code ?? error.name, detail: error.message };
    }
  }));
  const tables = await query(id, db.uuid, `
    SELECT 'round_first' AS kind, COUNT(*) AS rows FROM waterx_round_first
    UNION ALL SELECT 'snapshots', COUNT(*) FROM waterx_snapshots
    UNION ALL SELECT 'settlement', COUNT(*) FROM waterx_settlement_evidence
    UNION ALL SELECT 'pending', COUNT(*) FROM waterx_settlement_pending
    UNION ALL SELECT 'coverage', COUNT(*) FROM waterx_edge_coverage;
    SELECT interval_minutes, round_id, observed_at_ms, up_odds_cents,
      down_odds_cents, reference_confirmed
    FROM waterx_snapshots ORDER BY observed_at_ms DESC LIMIT 4`);
  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(), url, paidSubscriptions: 0,
    database: { id: db.uuid, fileSize: db.file_size },
    settings: { usage_model: settings.usage_model, observability: settings.observability,
      bindings: settings.bindings, exports: settings.exports },
    schedules, endpoints, tables,
  }, null, 2));
}

const action = process.argv[2];
if (!["--deploy-free-trial", "--update-free-trial", "--status"].includes(action))
  throw new Error("Choose --deploy-free-trial, --update-free-trial, or --status.");
const id = await account();
if (action === "--deploy-free-trial") await deploy(id);
else if (action === "--update-free-trial") await update(id);
else await status(id);