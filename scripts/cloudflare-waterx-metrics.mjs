// Read-only, schema-driven Cloudflare metrics for the isolated WaterX prototype.
// Credentials are used only in request headers and are never included in output.
const API = "https://api.cloudflare.com/client/v4";
const GRAPHQL = `${API}/graphql`;
const EXECUTION_PROBE = process.argv.includes("--execution-probe");
const SCRIPT = EXECUTION_PROBE ? "waterx-execution-feasibility" : "waterx-edge-prototype";
const DATABASE = SCRIPT;
const env = process.env;

if (!env.CLOUDFLARE_API_KEY || !env.CLOUDFLARE_EMAIL) {
  throw new Error("Set CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL in the environment.");
}

const authHeaders = {
  "X-Auth-Key": env.CLOUDFLARE_API_KEY,
  "X-Auth-Email": env.CLOUDFLARE_EMAIL,
  Accept: "application/json",
};

async function rest(path) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new Error(`Cloudflare GET ${path} failed before receiving a response.`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Cloudflare GET ${path} returned non-JSON HTTP ${response.status}.`);
  }
  if (!response.ok || body.success !== true) {
    const codes = (body.errors ?? []).map(error => error.code).filter(code => code !== undefined);
    throw new Error(`Cloudflare GET ${path} failed (HTTP ${response.status}; codes: ${codes.join(",") || "unavailable"}).`);
  }
  return body.result;
}

async function graphql(query) {
  let response;
  try {
    response = await fetch(GRAPHQL, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error("Cloudflare GraphQL request failed before receiving a response.");
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Cloudflare GraphQL returned non-JSON HTTP ${response.status}.`);
  }
  if (!response.ok) throw new Error(`Cloudflare GraphQL returned HTTP ${response.status}.`);
  if (body.errors?.length) {
    const messages = body.errors.map(error => String(error.message ?? "GraphQL error").slice(0, 180));
    return { data: body.data, errors: messages };
  }
  return { data: body.data, errors: [] };
}

const typeRef = `
  kind name description
  ofType { kind name description
    ofType { kind name description
      ofType { kind name description
        ofType { kind name description
          ofType { kind name description
            ofType { kind name description
              ofType { kind name description
                ofType { kind name description }
              }
            }
          }
        }
      }
    }
  }
`;

function namedType(type) {
  let current = type;
  while (current?.ofType) current = current.ofType;
  return current;
}

function refsFromText(text) {
  const refs = [];
  const pattern = /(?:\b|\.)((?:workers|durableObjects|d1)[A-Za-z0-9_]*(?:Adaptive|Groups|Analytics|Storage)[A-Za-z0-9_]*)/g;
  for (const match of text.matchAll(pattern)) refs.push(match[1]);
  return [...new Set(refs)];
}

function gqlName(name) {
  return /^[_A-Za-z][_0-9A-Za-z]*$/.test(name);
}

function quote(value) {
  return JSON.stringify(value);
}

function isListType(type) {
  let current = type;
  while (current?.kind === "NON_NULL") current = current.ofType;
  return current?.kind === "LIST";
}

function inputLiteral(type, fieldName, values, depth = 0) {
  if (type?.kind === "NON_NULL") return inputLiteral(type.ofType, fieldName, values, depth + 1);
  const current = namedType(type);
  if (!current || depth > 5) return null;
  if (current.kind === "INPUT_OBJECT") {
    const fields = values.inputTypes.get(current.name)?.inputFields ?? [];
    const byName = new Map(fields.map(field => [field.name, field]));
    const entries = new Map();
    const add = (name, value) => {
      const field = byName.get(name);
      if (!field) return false;
      if (name.endsWith("_in") || name === "namespaceIds_has" || name === "namespaceIds_hasany") {
        if (!isListType(field.type)) return false;
        value = [value];
      } else if (isListType(field.type)) {
        return false;
      }
      const literal = valueLiteral(field.type, field.name, value, values, depth + 1);
      if (literal === null) return false;
      entries.set(name, `${name}: ${literal}`);
      return true;
    };

    add("datetime_geq", values.from);
    add("datetime_leq", values.to);
    if (values.script !== undefined && !add("scriptName", values.script)) {
      add("scriptName_in", values.script);
    }
    if (values.namespace !== undefined && !add("namespaceId", values.namespace) &&
        !add("namespaceId_in", values.namespace) &&
        !add("namespaceIds_has", values.namespace)) {
      add("namespaceIds_hasany", values.namespace);
    }
    if (values.database !== undefined && !add("databaseId", values.database)) {
      add("databaseId_in", values.database);
    }
    if (values.account !== undefined) add("accountTag", values.account);

    for (const field of fields) {
      if (field.type.kind === "NON_NULL" && !entries.has(field.name) &&
          field.defaultValue == null) return null;
    }
    return `{${[...entries.values()].join(", ")}}`;
  }
  return null;
}

function valueLiteral(type, fieldName, value, values, depth = 0) {
  if (type?.kind === "NON_NULL") return valueLiteral(type.ofType, fieldName, value, values, depth + 1);
  if (type?.kind === "LIST") {
    const valuesList = Array.isArray(value) ? value : [value];
    const rendered = valuesList.map(item => valueLiteral(type.ofType, fieldName, item, values, depth + 1));
    return rendered.some(item => item === null) ? null : `[${rendered.join(", ")}]`;
  }
  const current = namedType(type);
  if (!current) return null;
  if (current.kind === "INPUT_OBJECT") return inputLiteral(type, fieldName, values, depth + 1);
  if (current.kind === "SCALAR") {
    if (/^(Int|Float)$/.test(current.name)) return String(value);
    if (current.name === "Boolean") return String(Boolean(value));
    return quote(String(value));
  }
  if (current.kind === "ENUM") return gqlName(String(value)) ? String(value) : null;
  return null;
}

const metricFieldAllowlist = {
  workerCpuAndRequests: {
    dimensions: ["datetime", "scriptName", "status"],
    sum: ["requests", "errors"],
    quantiles: ["cpuTimeP50", "cpuTimeP90", "cpuTimeP99"],
  },
  durableObjectInvocations: {
    dimensions: ["datetime", "namespaceId", "name", "status"],
    sum: ["requests", "errors", "wallTime"],
    quantiles: ["cpuTimeP50", "cpuTimeP90", "cpuTimeP99", "wallTimeP50", "wallTimeP90", "wallTimeP99"],
  },
  durableObjectPeriodic: {
    dimensions: ["datetime", "namespaceId", "name"],
    sum: ["cpuTime", "duration", "rowsRead", "rowsWritten", "storageReadUnits", "storageWriteUnits", "billedTime"],
    max: ["memoryUsageBytes"],
    count: [],
  },
  durableObjectStorage: {
    dimensions: ["datetime", "namespaceId"],
    max: ["storedBytes"],
  },
  durableObjectSubrequests: {
    dimensions: ["datetime", "namespaceId", "scriptName", "hostname", "httpResponseStatus"],
    sum: ["requests", "errors", "requestBodySizeUncached"],
    count: [],
  },
  d1Analytics: {
    dimensions: ["datetime", "databaseId"],
    sum: ["rowsRead", "rowsWritten", "readQueries", "writeQueries"],
    count: [],
  },
  d1Queries: {
    dimensions: ["datetime", "databaseId", "error"],
    sum: ["rowsRead", "rowsWritten"],
    count: [],
  },
  d1Storage: {
    dimensions: ["datetime", "databaseId"],
    max: ["databaseSizeBytes"],
  },
  workerSubrequestsByStatusHost: {
    dimensions: ["datetime", "scriptName", "hostname", "httpResponseStatus", "requestOutcome"],
    sum: ["subrequests", "requestBodySizeUncached"],
    count: [],
  },
};

function topLevelSelection(type, types, key) {
  const named = namedType(type);
  const object = types.get(named?.name);
  if (!object?.fields) return null;
  const parts = [];
  for (const field of object.fields) {
    if (field.args.length) continue;
    const child = namedType(field.type);
    if (!child) continue;
    if (["SCALAR", "ENUM"].includes(child.kind) &&
        Object.hasOwn(metricFieldAllowlist[key] ?? {}, field.name)) {
      parts.push(field.name);
    } else if (child.kind === "OBJECT") {
      const wanted = metricFieldAllowlist[key]?.[field.name];
      const metricObject = types.get(child.name);
      if (!wanted || !metricObject?.fields) continue;
      let leaves = metricObject.fields.filter(metric => wanted.includes(metric.name) &&
        metric.args.length === 0 && ["SCALAR", "ENUM"].includes(namedType(metric.type)?.kind));
      if (field.name === "dimensions" && wanted.includes("datetime")) {
        // A full day has >10,000 alarm/query timestamps. Coarse time groups
        // keep the result bounded without silently losing the rest of the day.
        const timeField = ["datetimeHour", "datetimeFifteenMinutes",
          "datetimeFiveMinutes", "datetimeMinute", "date", "datetime"]
          .map(name => metricObject.fields.find(metric => metric.name === name &&
            metric.args.length === 0 &&
            ["SCALAR", "ENUM"].includes(namedType(metric.type)?.kind)))
          .find(Boolean);
        if (timeField) leaves = [...leaves.filter(metric => metric.name !== "datetime"), timeField];
      }
      if (leaves.length) parts.push(`${field.name} { ${leaves.map(metric => metric.name).join(" ")} }`);
    }
  }
  return parts.length ? `{ ${parts.join(" ")} }` : null;
}

function schemaUnavailableFields(key, field, types) {
  const outputType = types.get(namedType(field.type)?.name);
  const unavailable = {};
  for (const [group, names] of Object.entries(metricFieldAllowlist[key] ?? {})) {
    if (!names.length) continue;
    const groupField = outputType?.fields?.find(item => item.name === group);
    const groupType = groupField && types.get(namedType(groupField.type)?.name);
    const available = new Set((groupType?.fields ?? []).map(item => item.name));
    const absent = names.filter(name => !available.has(name));
    if (absent.length) unavailable[group] = absent;
  }
  return unavailable;
}

function selectedDescriptions(selection, type, types, parent = "") {
  const descriptions = {};
  const object = types.get(namedType(type)?.name);
  if (!object?.fields) return descriptions;
  let index = 1;
  while (index < selection.length - 1) {
    while (/\s/.test(selection[index] ?? "")) index++;
    const start = index;
    while (/[_0-9A-Za-z]/.test(selection[index] ?? "")) index++;
    const fieldName = selection.slice(start, index);
    if (!fieldName) break;
    while (/\s/.test(selection[index] ?? "")) index++;
    const field = object.fields.find(item => item.name === fieldName);
    if (selection[index] === "{") {
      let depth = 1;
      const childStart = ++index;
      while (index < selection.length && depth) {
        if (selection[index] === "{") depth++;
        else if (selection[index] === "}") depth--;
        index++;
      }
      if (field && depth === 0) {
        Object.assign(descriptions, selectedDescriptions(
          `{ ${selection.slice(childStart, index - 1)} }`, field.type, types, `${parent}${field.name}.`,
        ));
      }
    } else if (field?.description) {
      descriptions[`${parent}${fieldName}`] = field.description;
    }
  }
  return descriptions;
}

function unavailable(reason, extra = {}) {
  return { availability: "unavailable", reason, ...extra };
}

function parseIsoTimestamp(value, flag) {
  if (typeof value !== "string") throw new Error(`${flag} requires an ISO timestamp.`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value)
    throw new Error(`${flag} must be a canonical UTC ISO timestamp such as 2026-10-01T22:02:44.752Z.`);
  return milliseconds;
}

function resolveMetricsWindow(args, nowMs = Date.now()) {
  let from;
  let to;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--from" || argument === "--to") {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`${argument} requires a timestamp.`);
      if (argument === "--from") from = value;
      else to = value;
    } else if (argument !== "--execution-probe") {
      throw new Error("Supported options are --from <ISO timestamp>, --to <ISO timestamp>, and --execution-probe.");
    }
  }
  if ((from === undefined) !== (to === undefined))
    throw new Error("--from and --to must be supplied together.");
  if (from === undefined) {
    const endMs = nowMs;
    const startMs = endMs - 24 * 60 * 60 * 1000;
    return {
      startMs, endMs,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      durationSeconds: 86_400,
      selection: "trailing_24_hours",
    };
  }
  const startMs = parseIsoTimestamp(from, "--from");
  const endMs = parseIsoTimestamp(to, "--to");
  if (endMs <= startMs) throw new Error("--to must be later than --from.");
  return {
    startMs, endMs, start: from, end: to,
    durationSeconds: (endMs - startMs) / 1000,
    selection: "explicit",
  };
}

async function main(args = process.argv.slice(2)) {
  const window = resolveMetricsWindow(args);
  const accounts = await rest("/accounts?per_page=50");
  if (!Array.isArray(accounts) || accounts.length !== 1) {
    throw new Error(`Expected exactly one Cloudflare account; received ${Array.isArray(accounts) ? accounts.length : "an invalid response"}.`);
  }
  const accountId = accounts[0].id;
  const subscriptions = await rest(`/accounts/${encodeURIComponent(accountId)}/subscriptions`);
  if (!Array.isArray(subscriptions) || subscriptions.length !== 0) {
    throw new Error("Account subscriptions are not empty; refusing to collect under a potentially paid account.");
  }

  const [databaseResult, settingsResult, namespacesResult] = await Promise.allSettled([
    rest(`/accounts/${encodeURIComponent(accountId)}/d1/database?per_page=100`),
    rest(`/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(SCRIPT)}/settings`),
    rest(`/accounts/${encodeURIComponent(accountId)}/workers/durable_objects/namespaces?per_page=100`),
  ]);
  const databases = databaseResult.status === "fulfilled" ? databaseResult.value : [];
  const settings = settingsResult.status === "fulfilled" ? settingsResult.value : null;
  const namespaces = namespacesResult.status === "fulfilled" ? namespacesResult.value : [];
  const database = Array.isArray(databases) ? databases.find(item => item.name === DATABASE) : null;
  const binding = (settings?.bindings ?? []).find(item =>
    item.name === (EXECUTION_PROBE ? "EXECUTION_PROBE" : "WATERX_COLLECTOR") && item.type === "durable_object_namespace");
  const bindingNamespaceId = binding?.namespace_id ?? binding?.id;
  const namespace = bindingNamespaceId && Array.isArray(namespaces)
    ? namespaces.find(item => item.id === bindingNamespaceId)
    : null;

  const introspection = await graphql(`query WaterxSchema {
    __schema {
      queryType { name fields { name description args { name description defaultValue type { ${typeRef} } type { ${typeRef} } } type { ${typeRef} } } }
      types {
        kind name description
        fields { name description args { name description defaultValue type { ${typeRef} } } type { ${typeRef} } }
        inputFields { name description defaultValue type { ${typeRef} } }
        enumValues { name description }
      }
    }
  }`);
  if (!introspection.data?.__schema) {
    throw new Error(`Cloudflare GraphQL introspection failed: ${introspection.errors.join("; ") || "schema unavailable"}`);
  }
  const types = new Map(introspection.data.__schema.types.map(type => [type.name, type]));
  const root = introspection.data.__schema.queryType;
  const rootFields = root.fields ?? [];
  const viewerField = rootFields.find(field => field.name === "viewer");
  if (!viewerField) throw new Error("Cloudflare GraphQL schema does not expose viewer.");
  const viewerType = namedType(viewerField.type);
  const viewer = types.get(viewerType.name);
  const accountsField = viewer?.fields?.find(field => field.name === "accounts");
  if (!accountsField) throw new Error("Cloudflare GraphQL schema does not expose viewer.accounts.");
  const accountsType = namedType(accountsField.type);
  const accountType = types.get(accountsType.name);
  const datasets = (accountType?.fields ?? []).filter(field =>
    /^(workers|durableObjects|d1)/.test(field.name) &&
    /Adaptive|Groups|Analytics|Storage/i.test(field.name));
  const matches = datasets.map(field => ({
    field,
    category: /workers/i.test(field.name) ? "worker" :
      /durableObjects/i.test(field.name) ? "durableObjects" : "d1",
  }));

  const output = {
    collector: SCRIPT,
    readOnly: true,
    accountSubscriptions: { availability: "available", count: 0 },
    timeWindow: {
      start: window.start,
      end: window.end,
      durationSeconds: window.durationSeconds,
      selection: window.selection,
      boundarySemantics: "The requested interval is passed to Cloudflare analytics filters; returned metrics remain subject to Cloudflare's dataset grouping and boundary precision.",
    },
    analyticsFreshnessBasis: "Dataset lag is measured relative to the requested window end, not current wall-clock time. Historical requests can be intentionally older than report generation time.",
    analyticsGroupingLimitations: "Dimensions may be hourly, 15-minute, 5-minute, per-minute, or date-grouped depending on dataset; analytics do not prove quote-level polling freshness or exact sub-bucket boundary attribution.",
    resources: {
      worker: {
        name: SCRIPT,
        availability: settings ? "available" : "unavailable",
        ...(!settings ? { reason: "worker_settings_not_available_or_worker_not_deployed" } : {}),
      },
      durableObjectNamespace: {
        availability: namespace ? "available" : "unavailable",
        ...(namespace ? {
          id: namespace.id,
          name: namespace.name ?? null,
          className: binding.class_name ?? null,
          storageType: namespace.storage_type ?? null,
        } : { reason: settingsResult.status === "rejected"
          ? "worker_settings_not_available_or_worker_not_deployed"
          : namespacesResult.status === "rejected"
            ? "namespace_list_not_available"
            : "worker_namespace_binding_not_found" }),
      },
      d1: {
        availability: database ? "available" : "unavailable",
        ...(database ? {
          name: database.name,
          id: database.uuid,
          storageBytes: database.file_size ?? null,
          storageBytesAvailability: database.file_size == null ? "unavailable" : "available",
        } : { reason: databaseResult.status === "rejected" ? "d1_database_list_unavailable" : "database_not_found" }),
      },
    },
    datasets: {},
    schema: { discoveredDatasets: matches.map(({ field }) => field.name) },
  };

  const goals = [
    ["workerCpuAndRequests", "worker", /workersInvocationsAdaptive/i],
    ["durableObjectInvocations", "durableObjects", /durableObjectsInvocationsAdaptive/i],
    ["durableObjectPeriodic", "durableObjects", /durableObjectsPeriodicGroups/i],
    ["durableObjectStorage", "durableObjects", /durableObjects.*Storage.*(Adaptive|Groups)/i],
    ["durableObjectSubrequests", "durableObjects", /durableObjectsSubrequestsAdaptiveGroups/i],
    ["workerSubrequestsByStatusHost", "worker", /workersSubrequestsAdaptiveGroups/i],
    ["d1Analytics", "d1", /d1.*(Analytics|Queries).*AdaptiveGroups/i],
    ["d1Queries", "d1", /d1QueriesAdaptiveGroups/i],
    ["d1Storage", "d1", /d1.*Storage.*(Adaptive|Groups)/i],
  ];
  const selectedDatasets = goals.map(([key, category, pattern]) => {
    const found = matches.find(item => item.category === category && pattern.test(item.field.name));
    return { key, category, field: found?.field };
  });

  const accountArg = accountsField.args.find(arg => arg.name === "filter");
  const inputTypes = new Map([...types].map(([name, type]) => [name, type]));

  for (const { key, category, field } of selectedDatasets) {
    if (!field) {
      output.datasets[key] = unavailable("dataset_not_exposed_by_current_schema");
      continue;
    }
    const selection = topLevelSelection(field.type, types, key);
    if (!selection) {
      output.datasets[key] = unavailable("dataset_has_no_selectable_metric_fields", { schemaField: field.name });
      continue;
    }
    if (category === "durableObjects" && !namespace) {
      output.datasets[key] = unavailable("worker_durable_object_namespace_not_available", {
        schemaField: field.name,
        ...(Object.keys(schemaUnavailableFields(key, field, types)).length
          ? { unavailableFields: schemaUnavailableFields(key, field, types) }
          : {}),
      });
      continue;
    }
    if (category === "d1" && !database) {
      output.datasets[key] = unavailable("isolated_d1_database_not_available", {
        schemaField: field.name,
        ...(Object.keys(schemaUnavailableFields(key, field, types)).length
          ? { unavailableFields: schemaUnavailableFields(key, field, types) }
          : {}),
      });
      continue;
    }
    const values = {
      inputTypes, from: window.start, to: window.end,
      script: SCRIPT, namespace: namespace?.id, database: database?.uuid, account: accountId,
    };
    const args = [];
    if (field.args.some(arg => arg.name === "limit")) args.push("limit: 10000");
    const filterArg = field.args.find(arg => /filter/i.test(arg.name));
    if (!filterArg) {
      output.datasets[key] = unavailable("dataset_filter_argument_not_exposed_by_schema", { schemaField: field.name });
      continue;
    }
    const filterType = types.get(namedType(filterArg.type)?.name);
    const filterFieldNames = new Set((filterType?.inputFields ?? []).map(item => item.name));
    const requiredFilterNames = ["datetime_geq", "datetime_leq"];
    if (category === "worker") requiredFilterNames.push("scriptName");
    if (category === "durableObjects") {
      const namespaceFilter = filterFieldNames.has("namespaceId") || filterFieldNames.has("namespaceIds_has");
      if (!namespaceFilter) {
        output.datasets[key] = unavailable("namespace_filter_not_exposed_by_schema", { schemaField: field.name });
        continue;
      }
    }
    if (category === "d1") requiredFilterNames.push("databaseId");
    const missingFilterNames = requiredFilterNames.filter(name => !filterFieldNames.has(name));
    if (missingFilterNames.length) {
      output.datasets[key] = unavailable("required_resource_or_time_filter_not_exposed_by_schema", {
        schemaField: field.name,
        missingFilterFields: missingFilterNames,
      });
      continue;
    }
    const filterLiteral = inputLiteral(filterArg.type, filterArg.name, values);
    if (filterLiteral === null) {
      output.datasets[key] = unavailable("required_filter_fields_could_not_be_satisfied_from_schema", { schemaField: field.name });
      continue;
    }
    args.push(`${filterArg.name}: ${filterLiteral}`);
    const requiredUnknown = field.args.filter(arg =>
      arg.type.kind === "NON_NULL" && arg.defaultValue == null &&
      !args.some(argument => argument.startsWith(`${arg.name}:`)));
    if (requiredUnknown.length) {
      output.datasets[key] = unavailable("required_arguments_not_supported_by_collector", {
        schemaField: field.name,
        requiredArguments: requiredUnknown.map(arg => arg.name),
      });
      continue;
    }

    const argsText = args.length ? `(${args.join(", ")})` : "";
    const accountArgs = [];
    if (!accountArg) {
      output.datasets[key] = unavailable("account_filter_not_exposed_by_schema", { schemaField: field.name });
      continue;
    }
    const accountFilterType = types.get(namedType(accountArg.type)?.name);
    if (!(accountFilterType?.inputFields ?? []).some(item => item.name === "accountTag")) {
      output.datasets[key] = unavailable("account_tag_filter_not_exposed_by_schema", { schemaField: field.name });
      continue;
    }
    const accountLiteral = inputLiteral(accountArg.type, accountArg.name, values);
    if (accountLiteral === null) {
      output.datasets[key] = unavailable("account_filter_could_not_be_satisfied_from_schema", { schemaField: field.name });
      continue;
    }
    accountArgs.push(`${accountArg.name}: ${accountLiteral}`);
    const query = `query WaterxMetric {
      viewer { accounts${accountArgs.length ? `(${accountArgs.join(", ")})` : ""} {
        ${field.name}${argsText} ${selection}
      } }
    }`;
    const response = await graphql(query);
    if (response.errors.length) {
      output.datasets[key] = unavailable("graphql_query_restricted_or_rejected", {
        schemaField: field.name,
        details: response.errors,
      });
      continue;
    }
    const rows = response.data?.viewer?.accounts?.[0]?.[field.name] ?? null;
    const descriptions = selectedDescriptions(selection, field.type, types);
    const requested = metricFieldAllowlist[key] ?? {};
    const exposed = Object.fromEntries(Object.entries(requested).map(([group, names]) => {
      const selected = selection.match(new RegExp(`\\b${group}\\s*\\{([^{}]+)\\}`));
      return [group, selected ? selected[1].trim().split(/\s+/) : []];
    }));
    const notExposed = schemaUnavailableFields(key, field, types);
    const unavailableFields = { ...notExposed };
    const latestTimestamp = Array.isArray(rows)
      ? rows.reduce((latest, row) => {
        const dimension = row?.dimensions;
        const value = dimension?.datetime ?? dimension?.datetimeHour ??
          dimension?.datetimeFifteenMinutes ?? dimension?.datetimeFiveMinutes ??
          dimension?.datetimeMinute;
        const time = typeof value === "string" ? Date.parse(value) : NaN;
        return Number.isFinite(time) && time > latest ? time : latest;
      }, -Infinity)
      : NaN;
    const lagSeconds = Number.isFinite(latestTimestamp)
      ? Math.max(0, Math.floor((window.endMs - latestTimestamp) / 1000))
      : null;
    const staleLimitSeconds = key === "durableObjectStorage" || key === "d1Storage" ? 86_400 : 7_200;
    const isLagged = lagSeconds !== null && lagSeconds > staleLimitSeconds;
    const noData = Array.isArray(rows) && rows.length === 0;
    const hitResultLimit = Array.isArray(rows) && rows.length >= 10_000;
    const unavailableBecauseNoData = rows === null || noData;
    output.datasets[key] = {
      availability: unavailableBecauseNoData || isLagged ? "unavailable" :
        Object.keys(unavailableFields).length || hitResultLimit ? "partial" : "available",
      ...(rows === null ? { reason: "graphql_returned_no_dataset_value" } :
        noData ? { reason: "no_data_in_requested_window", dataState: "no_data_not_zero" } :
          isLagged ? { reason: `dataset_lagged_beyond_${staleLimitSeconds}_seconds` } : {}),
      schemaField: field.name,
      fieldDescription: field.description ?? null,
      unitsAndFieldDescriptions: descriptions,
      selectedFields: exposed,
      resultLimit: 10_000,
      possiblyTruncated: hitResultLimit,
      ...(hitResultLimit ? {
        completenessWarning: "Result limit reached; these rows cannot establish full-window usage.",
      } : {}),
      ...(Object.keys(unavailableFields).length ? { unavailableFields } : {}),
      freshness: {
        latestDataTimestamp: Number.isFinite(latestTimestamp) ? new Date(latestTimestamp).toISOString() : null,
        lagSeconds,
        referenceTime: window.end,
        referenceBasis: "requested_analytics_window_end",
        staleLimitSeconds,
        ...(latestTimestamp === -Infinity && !noData ? {
          note: "This dataset is aggregated by date; exact telemetry freshness is unavailable.",
        } : {}),
      },
      rows: rows ?? [],
      ...(noData ? { note: "No rows returned; this is not a zero measurement." } : {}),
      ...(key === "workerSubrequestsByStatusHost" ? {
        caveat: "Worker-subrequest telemetry; this does not substitute for Durable Object-specific subrequests.",
      } : {}),
    };
  }
  console.log(JSON.stringify(output, null, 2));
}

await main(process.argv.slice(2));