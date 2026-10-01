import { pathToFileURL } from "node:url";

export function assessAvailability(interval, live, health, nowMs) {
  const lastSuccess = health?.collector?.lastValidObservationAt;
  const lastSuccessMs = lastSuccess ? Date.parse(lastSuccess) : NaN;
  const ageMs = Number.isFinite(lastSuccessMs) ? nowMs - lastSuccessMs : null;
  const liveRound = live?.intervalMinutes === interval && live?.status === "LIVE" &&
    live?.round?.startMs <= nowMs && nowMs < live?.round?.expiryMs;
  const sustainedStale = ageMs !== null && ageMs > 120_000 && !liveRound;
  return {
    intervalMinutes: interval,
    waterxStatus: live?.status ?? "UNAVAILABLE",
    collectorHealth: health?.collector?.healthState ?? "UNKNOWN",
    lastValidObservationAt: lastSuccess ?? null,
    ageMs,
    sustainedStale,
    comparisonStatus: live?.comparison ? "reported-separately" : "unavailable",
    reason: live?.reason ?? "WaterX response unavailable.",
  };
}

export async function checkAvailability(base, fetcher = fetch, nowMs = Date.now()) {
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Monitoring requires a public HTTPS URL without credentials.");
  const failures = [];
  async function read(path) {
    try {
      const response = await fetcher(new URL(path, url), {
        signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      failures.push({ path, reason: error instanceof Error ? error.message : "Read failed" });
      return null;
    }
  }
  const [liveness, five, fifteen, fiveHealth, fifteenHealth] = await Promise.all([
    read("/health/live"), read("/api/waterx/live?interval=5"),
    read("/api/waterx/live?interval=15"), read("/api/waterx/health?interval=5"),
    read("/api/waterx/health?interval=15"),
  ]);
  const intervals = [
    assessAvailability(5, five, fiveHealth, nowMs),
    assessAvailability(15, fifteen, fifteenHealth, nowMs),
  ];
  return {
    measuredAt: new Date(nowMs).toISOString(),
    homepageLiveness: liveness?.status === "ok" ? "available" : "unavailable",
    intervals, failures,
    alert: liveness?.status !== "ok" || failures.length > 0 ||
      intervals.some(result => result.sustainedStale),
    note: "A current comparison price is not WaterX liveness. One failed check is not a measured outage duration. Email delivery depends on GitHub notification settings.",
  };
}

async function updateIssue(report) {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !token) return "not-configured";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository identity.");
  const title = "WaterX availability: stale or unavailable";
  async function api(path, method = "GET", body) {
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      method, signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${token}`, accept: "application/vnd.github+json",
        "content-type": "application/json", "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`GitHub alert operation failed: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  const issues = await api("/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100");
  const existing = issues.find(issue => !issue.pull_request && issue.title === title);
  if (report.alert && !existing) {
    await api("/issues", "POST", {
      title,
      body: `External read-only check failed.\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n\nGlows must remain neutral while evidence is stale. This check does not repair or restart production.`,
    });
    return "issue-opened";
  }
  if (!report.alert && existing) {
    await api(`/issues/${existing.number}/comments`, "POST", {
      body: `Recovery observed at ${report.measuredAt}; this point-in-time check is not a claim of continuous uptime.`,
    });
    await api(`/issues/${existing.number}`, "PATCH", { state: "closed" });
    return "recovery-recorded";
  }
  return existing ? "existing-alert-retained" : "healthy-no-alert";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.env.WATERX_MONITOR_URL;
  if (!base) throw new Error("Set WATERX_MONITOR_URL to the verified public production URL.");
  const report = await checkAvailability(base);
  console.log(JSON.stringify(report, null, 2));
  console.log(`Alert delivery: ${await updateIssue(report)}`);
  process.exitCode = report.alert ? 1 : 0;
}