import type { WaterxDetail, WaterxInterval, WaterxRound } from "./types";

const API = "https://api.waterx.app/predict/markets/crypto";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_MARKET_ID = /^[a-zA-Z0-9_-]{1,160}$/;
const CACHE_MS = 1_500;
const CACHE_MAX = 256;
const TIMEOUT_MS = 4_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const cache = new Map<string, { expiresAt: number; detail: WaterxDetail }>();
const inflight = new Map<string, Promise<WaterxDetail>>();
const requestMetadata = new WeakMap<WaterxDetail, { receivedAt: string; sourceTimestamp: string | null }>();

export class WaterxProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
    readonly stage: "provider" | "parse" | "round_validation" | "timeout" = "provider",
    readonly requestReceivedAt: string | null = null,
  ) {
    super(message);
    this.name = "WaterxProviderError";
  }
}

export function waterxSlug(interval: WaterxInterval): string {
  if (interval !== 5 && interval !== 15)
    throw new WaterxProviderError("WaterX interval must be 5 or 15 minutes");
  return `crypto-btc-updown-${interval}m`;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new WaterxProviderError(`Malformed WaterX ${label}`);
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, label: string, min = -Infinity, max = Infinity): number {
  const parsed = typeof value === "number" ? value :
    typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max)
    throw new WaterxProviderError(`Invalid WaterX ${label}`);
  return parsed;
}

function seconds(value: unknown, label: string): number {
  const parsed = typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value)
    ? Date.parse(value) / 1000 : finiteNumber(value, label, 0, Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > Number.MAX_SAFE_INTEGER)
    throw new WaterxProviderError(`Invalid WaterX ${label}`);
  return parsed;
}

function unavailableSide(label: string, reason = `WaterX ${label} side was not reported.`): WaterxRound["sides"]["up"] {
  return { oddsCents: null, probabilityCents: null, availability: "unavailable", reason };
}

function side(value: unknown, label: string): WaterxRound["sides"]["up"] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return unavailableSide(label, `Malformed WaterX ${label} side; odds are temporarily unavailable.`);
  const raw = value as Record<string, unknown>;
  const statusFields = [raw.status, raw.state, raw.availability]
    .filter((entry): entry is string => typeof entry === "string")
    .map(entry => entry.trim().toLowerCase());
  const explicitlyLocked = raw.locked === true || raw.isLocked === true ||
    statusFields.some(status => ["locked", "closed", "suspended"].includes(status));
  const explicitlyUnavailable = raw.available === false ||
    statusFields.some(status => ["unavailable", "not_available"].includes(status));
  const readCents = (key: "oddsCents" | "probabilityCents"): { value: number | null; reason: string | null } => {
    if (raw[key] === null || raw[key] === undefined) return { value: null, reason: null };
    const parsed = typeof raw[key] === "number" ? raw[key] :
      typeof raw[key] === "string" && raw[key].trim() ? Number(raw[key]) : NaN;
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100)
      return { value: null, reason: `Invalid WaterX ${label}.${key}; value must be finite and within [0,100].` };
    return { value: parsed, reason: null };
  };
  const odds = readCents("oddsCents");
  const probability = readCents("probabilityCents");
  const availability = explicitlyLocked ? "locked"
    : explicitlyUnavailable || (odds.value === null && probability.value === null) ? "unavailable"
      : "reported";
  const reason = explicitlyLocked ? `WaterX ${label} side is locked.`
    : explicitlyUnavailable ? `WaterX ${label} side is unavailable.`
      : odds.reason ?? probability.reason ??
        (odds.value === null && probability.value === null ? `WaterX ${label} odds temporarily unavailable.` : null);
  return {
    oddsCents: odds.value,
    probabilityCents: probability.value,
    availability,
    reason,
    ...(raw.trade&&typeof raw.trade==="object"&&
      typeof (raw.trade as Record<string,unknown>).marketId==="string"&&
      /^0x[0-9a-f]{64}$/i.test((raw.trade as Record<string,string>).marketId)&&
      ["YES","NO"].includes(String((raw.trade as Record<string,unknown>).selection))?
      {trade:{marketId:(raw.trade as Record<string,string>).marketId.toLowerCase(),
        selection:(raw.trade as {selection:"YES"|"NO"}).selection}}:{}),
  };
}

function parseRound(value: unknown, slug: string, marketId: string): WaterxRound {
  const raw = object(value, "round");
  if (typeof raw.id !== "string" || !UUID.test(raw.id))
    throw new WaterxProviderError("Invalid WaterX round UUID");
  if (raw.marketId !== undefined && raw.marketId !== marketId)
    throw new WaterxProviderError("WaterX round marketId does not match its market");
  const startsAt = seconds(raw.startsAt, "round startsAt");
  const endsAt = seconds(raw.endsAt, "round endsAt");
  const expected = slug.endsWith("-5m") ? 300 : 900;
  if (Math.abs((endsAt - startsAt) - expected) > 0.001)
    throw new WaterxProviderError("WaterX round cadence does not match the requested interval");
  if (typeof raw.phase !== "string" || !raw.phase.trim() || raw.phase.length > 60)
    throw new WaterxProviderError("Invalid WaterX round phase");
  const parsedAnchor = raw.anchorPrice === null || raw.anchorPrice === undefined ? NaN :
    typeof raw.anchorPrice === "number" ? raw.anchorPrice :
      typeof raw.anchorPrice === "string" && raw.anchorPrice.trim() ? Number(raw.anchorPrice) : NaN;
  const anchorPrice = Number.isFinite(parsedAnchor) && parsedAnchor > 0 ? parsedAnchor : null;
  const anchorPriceConfirmed = raw.anchorPriceConfirmed === true && anchorPrice !== null;
  const referenceUnavailableReason = anchorPrice === null
    ? "WaterX reference price is missing or invalid."
    : raw.anchorPriceConfirmed !== true
      ? "WaterX reference price is provisional or unconfirmed."
      : null;
  const keyed = new Map<string, unknown>();
  const ambiguous = new Set<string>();
  if (Array.isArray(raw.sides)) for (const entry of raw.sides) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const parsed = entry as Record<string, unknown>;
    if (parsed.key !== "up" && parsed.key !== "down") continue;
    if (keyed.has(parsed.key)) {
      keyed.delete(parsed.key);
      ambiguous.add(parsed.key);
      continue;
    }
    if (!ambiguous.has(parsed.key)) keyed.set(parsed.key, entry);
  }
  const sides = {
    up: ambiguous.has("up") ? unavailableSide("up", "WaterX returned duplicate UP sides; odds are temporarily unavailable.")
      : side(keyed.get("up"), "up"),
    down: ambiguous.has("down") ? unavailableSide("down", "WaterX returned duplicate DOWN sides; odds are temporarily unavailable.")
      : side(keyed.get("down"), "down"),
  };
  let settlement: WaterxRound["settlement"] = null;
  if (raw.settlement !== null && raw.settlement !== undefined) {
    const candidate = object(raw.settlement, "settlement");
    const outcome = candidate.outcome === null || candidate.outcome === undefined
      ? null : typeof candidate.outcome === "string" ? candidate.outcome : null;
    if (candidate.outcome !== null && candidate.outcome !== undefined && outcome === null)
      throw new WaterxProviderError("Invalid WaterX settlement outcome");
    settlement = {
      outcome,
      settledAt: candidate.settledAt === null || candidate.settledAt === undefined
        ? null : seconds(candidate.settledAt, "settlement settledAt"),
    };
  }
  const settlePrice = raw.settlePrice === null || raw.settlePrice === undefined
    ? null : finiteNumber(raw.settlePrice, "settlePrice", Number.MIN_VALUE);
  const resolutionStatus = raw.resolutionStatus === null || raw.resolutionStatus === undefined
    ? null : typeof raw.resolutionStatus === "string" && raw.resolutionStatus.length <= 80
      ? raw.resolutionStatus : (() => { throw new WaterxProviderError("Invalid WaterX resolutionStatus"); })();
  return {
    id: raw.id, marketId, slug, startsAt, endsAt, phase: raw.phase.trim(),
    anchorPrice, anchorPriceConfirmed, referenceUnavailableReason, sides,
    settlement, settlePrice, resolutionStatus,
  };
}

export function parseWaterxResponse(payload: unknown, interval: WaterxInterval): WaterxDetail {
  if (interval !== 5 && interval !== 15)
    throw new WaterxProviderError("WaterX interval must be 5 or 15 minutes");
  const envelope = object(payload, "response");
  if (envelope.success !== true) throw new WaterxProviderError("WaterX response reports failure");
  const data = object(envelope.data, "data");
  const detail = object(data.detail, "detail");
  const market = object(detail.market, "market");
  const expectedSlug = waterxSlug(interval);
  if (market.slug !== expectedSlug) throw new WaterxProviderError("WaterX market slug mismatch");
  const marketId = market.marketId ?? market.id;
  if (typeof marketId !== "string" || !SAFE_MARKET_ID.test(marketId))
    throw new WaterxProviderError("Invalid WaterX marketId");
  const neighbors = object(detail.neighbors, "neighbors");
  if (!Array.isArray(neighbors.past) || !Array.isArray(neighbors.upcoming))
    throw new WaterxProviderError("Malformed WaterX neighbors");
  return {
    market: { slug: expectedSlug, marketId },
    round: parseRound(detail.round, expectedSlug, marketId),
    neighbors: { past: neighbors.past, upcoming: neighbors.upcoming },
  };
}

function candidateRounds(detail: WaterxDetail, interval: WaterxInterval): WaterxRound[] {
  const candidates = [detail.round];
  for (const neighbor of [...detail.neighbors.past, ...detail.neighbors.upcoming]) {
    if (!neighbor || typeof neighbor !== "object" || Array.isArray(neighbor)) continue;
    const item = neighbor as Record<string, unknown>;
    const rawRound = item.round && typeof item.round === "object" && !Array.isArray(item.round)
      ? item.round : item;
    try {
      candidates.push(parseRound(rawRound, detail.market.slug, detail.market.marketId));
    } catch {
      // Neighbor summaries may omit quote fields. Only fully validated round
      // records are eligible to determine the active/next round.
    }
  }
  const seen = new Set<string>();
  return candidates.filter(round => {
    const identity = `${round.id}:${round.startsAt}:${round.endsAt}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    const expectedSeconds = interval * 60;
    return round.endsAt - round.startsAt === expectedSeconds;
  });
}

async function readDetail(
  interval: WaterxInterval, epoch: number | undefined, signal: AbortSignal,
  onRequestReceived?: (at: string) => void,
): Promise<WaterxDetail> {
  const slug = waterxSlug(interval);
  const url = new URL(`${API}/${slug}`);
  url.searchParams.set("locale", "en");
  if (epoch !== undefined) url.searchParams.set("epoch", String(epoch));
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      signal,
    });
  } catch (error) {
    throw new WaterxProviderError(
      `WaterX request failed: ${error instanceof Error ? error.message : "network error"}`,
      null, null, signal.aborted ? "timeout" : "provider");
  }
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {});
    throw new WaterxProviderError("WaterX request was cancelled before response processing",
      null, null, "timeout");
  }
  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    const retryAt = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)
      ? Date.now() + Number(retryAfter) * 1000
      : retryAfter ? Date.parse(retryAfter) : NaN;
    const retryAfterMs = Number.isFinite(retryAt)
      ? Math.max(0, Math.min(5 * 60_000, retryAt - Date.now())) : null;
    throw new WaterxProviderError(
      `WaterX HTTP ${response.status}${response.status === 429 ? " (rate limited)" : ""}`,
      response.status, retryAfterMs);
  }
  const requestReceivedAt = new Date().toISOString();
  onRequestReceived?.(requestReceivedAt);
  let payload: unknown;
  const reader = response.body?.getReader();
  const cancelReader = () => {
    if (reader) void reader.cancel().catch(() => {});
  };
  if (reader) signal.addEventListener("abort", cancelReader, { once: true });
  try {
    if (!reader) payload = await response.json();
    else {
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new WaterxProviderError("WaterX response exceeded the 1MB limit");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      payload = JSON.parse(new TextDecoder().decode(bytes));
    }
  } catch (error) {
    if (error instanceof WaterxProviderError) throw error;
    if (signal.aborted)
      throw new WaterxProviderError("WaterX response read timed out or was cancelled",
        null, null, "timeout", requestReceivedAt);
    throw new WaterxProviderError("WaterX returned invalid JSON or an unreadable response",
      null, null, "parse", requestReceivedAt);
  } finally {
    if (reader) signal.removeEventListener("abort", cancelReader);
  }
  if (signal.aborted)
    throw new WaterxProviderError("WaterX response read timed out or was cancelled", null, null, "timeout");
  try {
    const detail = parseWaterxResponse(payload, interval);
    requestMetadata.set(detail, { receivedAt: requestReceivedAt, sourceTimestamp: null });
    return detail;
  } catch (error) {
    if (error instanceof WaterxProviderError)
      throw new WaterxProviderError(error.message, error.status, error.retryAfterMs, "parse", requestReceivedAt);
    throw error;
  }
}

function readDetailWithSignal(
  interval: WaterxInterval, epoch: number | undefined, signal: AbortSignal | undefined, timeoutMs: number,
  onRequestReceived?: (at: string) => void,
): Promise<WaterxDetail> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  if (requestSignal.aborted)
    return Promise.reject(new WaterxProviderError("WaterX request was cancelled", null, null, "timeout"));
  const sourceRead = readDetail(interval, epoch, requestSignal, onRequestReceived);
  let abortHandler: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortHandler = () => reject(new WaterxProviderError(
      "WaterX request was cancelled", null, null, "timeout"));
    requestSignal.addEventListener("abort", abortHandler, { once: true });
  });
  return Promise.race([sourceRead, aborted]).finally(() => {
    if (abortHandler) requestSignal.removeEventListener("abort", abortHandler);
  });
}

async function cachedDetail(
  interval: WaterxInterval, epoch?: number, signal?: AbortSignal, timeoutMs = TIMEOUT_MS,
  onRequestReceived?: (at: string) => void,
): Promise<WaterxDetail> {
  if (signal?.aborted)
    throw new WaterxProviderError("WaterX request was cancelled", null, null, "timeout");
  const now = Date.now();
  // Current reads are cached only within the scheduled round window. The
  // provider's public endpoint can briefly return the just-expired round at a
  // boundary; a single interval-wide "current" cache key would carry that
  // response across the rollover even though the round identity has changed.
  const cadenceSeconds = interval * 60;
  const roundStart = epoch === undefined
    ? Math.floor(now / 1000 / cadenceSeconds) * cadenceSeconds
    : null;
  const key = epoch === undefined
    ? `${interval}:round:${roundStart}`
    : `${interval}:epoch:${epoch}`;
  for (const [entryKey, entry] of Array.from(cache.entries()))
    if (entry.expiresAt <= now) cache.delete(entryKey);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.detail;
  const pending = inflight.get(key);
  if (pending) return pending;
  const request = readDetailWithSignal(interval, epoch, signal, timeoutMs, onRequestReceived).then(detail => {
    if (signal?.aborted) throw new WaterxProviderError("WaterX request was cancelled", null, null, "timeout");
    while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, { detail, expiresAt: Date.now() + CACHE_MS });
    return detail;
  });
  inflight.set(key, request);
  request.then(
    () => { if (inflight.get(key) === request) inflight.delete(key); },
    () => { if (inflight.get(key) === request) inflight.delete(key); },
  );
  return request;
}

export type CurrentRoundResult =
  | { status: "LIVE"; detail: WaterxDetail; sourceTimestamp: string | null; requestReceivedAt: string }
  | { status: "NO_ACTIVE_ROUND"; detail: WaterxDetail; sourceTimestamp: string | null; requestReceivedAt: string }
  | { status: "STALE"; detail: WaterxDetail; sourceTimestamp: string | null; requestReceivedAt: string };

export function classifyWaterxRound(
  detail: WaterxDetail,
  interval: WaterxInterval,
  nowMs: number,
): CurrentRoundResult {
  if (interval !== 5 && interval !== 15)
    throw new WaterxProviderError("WaterX interval must be 5 or 15 minutes");
  if (!Number.isFinite(nowMs)) throw new WaterxProviderError("Invalid WaterX classification time");
  const rounds = candidateRounds(detail, interval);
  const activePhases = new Set([
    "active", "open", "live", "trading", "ongoing", "running", "in_progress", "in-progress",
  ]);
  const inWindow = rounds.filter(round =>
    round.startsAt * 1000 <= nowMs && nowMs < round.endsAt * 1000);
  const active = inWindow.find(round => activePhases.has(round.phase.toLowerCase()));
  const round = active ?? rounds
    .filter(candidate => candidate.startsAt * 1000 > nowMs)
    .sort((a, b) => a.startsAt - b.startsAt)[0]
    ?? rounds.sort((a, b) => b.startsAt - a.startsAt)[0];
  if (!round) throw new WaterxProviderError("WaterX response has no valid round candidate");
  const selectedDetail = round === detail.round ? detail : { ...detail, round };
  const startsAtMs = round.startsAt * 1000;
  const endsAtMs = round.endsAt * 1000;
  if (Math.round(endsAtMs - startsAtMs) !== interval * 60_000)
    throw new WaterxProviderError("WaterX round cadence does not match the requested interval");
  const requestReceivedAt = requestMetadata.get(detail)?.receivedAt ?? new Date().toISOString();
  const sourceTimestamp = requestMetadata.get(detail)?.sourceTimestamp ?? null;
  if (active) return { status: "LIVE", detail: selectedDetail, sourceTimestamp, requestReceivedAt };
  if (startsAtMs > nowMs || !activePhases.has(round.phase.toLowerCase()))
    return { status: "NO_ACTIVE_ROUND", detail: selectedDetail, sourceTimestamp, requestReceivedAt };
  return { status: "STALE", detail: selectedDetail, sourceTimestamp, requestReceivedAt };
}

export async function getCurrentWaterxRound(
  interval: WaterxInterval,
  nowMs?: number,
  options: {
    signal?: AbortSignal; timeoutMs?: number; onRequestReceived?: (at: string) => void;
  } = {},
): Promise<CurrentRoundResult> {
  const detail = await cachedDetail(interval, undefined, options.signal,
    options.timeoutMs, options.onRequestReceived);
  if (options.signal?.aborted)
    throw new WaterxProviderError("WaterX request was cancelled", null, null, "timeout");
  try {
    return classifyWaterxRound(detail, interval, nowMs ?? Date.now());
  } catch (error) {
    if (error instanceof WaterxProviderError)
      throw new WaterxProviderError(error.message, error.status, error.retryAfterMs,
        "round_validation", requestMetadata.get(detail)?.receivedAt ?? null);
    throw error;
  }
}

export async function getWaterxRoundAtEpoch(
  interval: WaterxInterval,
  epochSeconds: number,
): Promise<WaterxDetail> {
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds <= 0)
    throw new WaterxProviderError("Invalid WaterX historical epoch");
  const detail = await cachedDetail(interval, epochSeconds);
  // WaterX's epoch selector identifies the closing boundary, not the
  // opening boundary. A query at the start returns the preceding round.
  if (detail.round.endsAt !== epochSeconds)
    throw new WaterxProviderError("WaterX historical round end does not match requested epoch");
  return detail;
}

export function verifiedHistoricalRound(
  detail: WaterxDetail,
  expectedRoundId: string,
  expectedEndSeconds: number,
): WaterxRound {
  if (detail.round.id !== expectedRoundId || detail.round.endsAt !== expectedEndSeconds)
    throw new WaterxProviderError("WaterX historical round identity or closing boundary changed");
  return detail.round;
}