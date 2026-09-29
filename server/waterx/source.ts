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

export class WaterxProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "WaterxProviderError";
  }
}

export function waterxSlug(interval: WaterxInterval): string {
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
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > Number.MAX_SAFE_INTEGER)
    throw new WaterxProviderError(`Invalid WaterX ${label}`);
  return parsed;
}

function side(value: unknown, label: string) {
  const raw = object(value, `${label} side`);
  const readCents = (key: "oddsCents" | "probabilityCents"): number | null => {
    if (raw[key] === null || raw[key] === undefined) return null;
    return finiteNumber(raw[key], `${label}.${key}`, 0, 100);
  };
  const result = { oddsCents: readCents("oddsCents"), probabilityCents: readCents("probabilityCents") };
  if (result.oddsCents === null && result.probabilityCents === null)
    throw new WaterxProviderError(`Missing WaterX ${label} odds and probability`);
  return result;
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
  const anchorPrice = finiteNumber(raw.anchorPrice, "anchorPrice", Number.MIN_VALUE);
  if (typeof raw.anchorPriceConfirmed !== "boolean")
    throw new WaterxProviderError("Invalid WaterX anchor confirmation state");
  if (!Array.isArray(raw.sides)) throw new WaterxProviderError("Malformed WaterX sides");
  const keyed = new Map<string, unknown>();
  for (const entry of raw.sides) {
    const parsed = object(entry, "side");
    if (parsed.key !== "up" && parsed.key !== "down")
      throw new WaterxProviderError("Unknown WaterX side");
    if (keyed.has(parsed.key)) throw new WaterxProviderError("Duplicate WaterX side");
    keyed.set(parsed.key, entry);
  }
  if (keyed.size !== 2) throw new WaterxProviderError("Incomplete WaterX sides");
  const sides = { up: side(keyed.get("up"), "up"), down: side(keyed.get("down"), "down") };
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
    anchorPrice, anchorPriceConfirmed: raw.anchorPriceConfirmed, sides,
    settlement, settlePrice, resolutionStatus,
  };
}

export function parseWaterxResponse(payload: unknown, interval: WaterxInterval): WaterxDetail {
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

async function readDetail(interval: WaterxInterval, epoch?: number): Promise<WaterxDetail> {
  const slug = waterxSlug(interval);
  const url = new URL(`${API}/${slug}`);
  url.searchParams.set("locale", "en");
  if (epoch !== undefined) url.searchParams.set("epoch", String(epoch));
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new WaterxProviderError(`WaterX request failed: ${error instanceof Error ? error.message : "network error"}`);
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
  let payload: unknown;
  try {
    const reader = response.body?.getReader();
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
    throw new WaterxProviderError("WaterX returned invalid JSON or an unreadable response");
  }
  return parseWaterxResponse(payload, interval);
}

async function cachedDetail(interval: WaterxInterval, epoch?: number): Promise<WaterxDetail> {
  const key = `${interval}:${epoch ?? "current"}`;
  const now = Date.now();
  for (const [entryKey, entry] of Array.from(cache.entries()))
    if (entry.expiresAt <= now) cache.delete(entryKey);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.detail;
  const pending = inflight.get(key);
  if (pending) return pending;
  const request = readDetail(interval, epoch).then(detail => {
    while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, { detail, expiresAt: Date.now() + CACHE_MS });
    return detail;
  }).finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}

export type CurrentRoundResult =
  | { status: "LIVE"; detail: WaterxDetail }
  | { status: "NO_ACTIVE_ROUND"; detail: WaterxDetail }
  | { status: "STALE"; detail: WaterxDetail };

export function classifyWaterxRound(
  detail: WaterxDetail,
  interval: WaterxInterval,
  nowMs: number,
): CurrentRoundResult {
  const round = detail.round;
  const startsAtMs = round.startsAt * 1000;
  const endsAtMs = round.endsAt * 1000;
  if (Math.round(endsAtMs - startsAtMs) !== interval * 60_000)
    throw new WaterxProviderError("WaterX round cadence does not match the requested interval");
  if (!["active", "open", "live", "trading", "ongoing", "running", "in_progress", "in-progress"].includes(round.phase.toLowerCase()))
    return { status: "NO_ACTIVE_ROUND", detail };
  if (startsAtMs <= nowMs && nowMs < endsAtMs) return { status: "LIVE", detail };
  if (nowMs < startsAtMs) return { status: "NO_ACTIVE_ROUND", detail };
  return { status: "STALE", detail };
}

export async function getCurrentWaterxRound(
  interval: WaterxInterval,
  nowMs?: number,
): Promise<CurrentRoundResult> {
  const detail = await cachedDetail(interval);
  return classifyWaterxRound(detail, interval, nowMs ?? Date.now());
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