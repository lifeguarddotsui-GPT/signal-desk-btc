/** Convert browser coordinates into the chart's actual plot-time domain. */
export function pointerTimestamp(
  clientX: number,
  boundsLeft: number,
  boundsWidth: number,
  plotStartFraction: number,
  plotEndFraction: number,
  domainStart: number,
  domainEnd: number,
): number | null {
  if (
    ![clientX, boundsLeft, boundsWidth, plotStartFraction, plotEndFraction, domainStart, domainEnd].every(Number.isFinite) ||
    boundsWidth <= 0 ||
    plotEndFraction <= plotStartFraction ||
    domainEnd <= domainStart
  ) return null;
  const xFraction = (clientX - boundsLeft) / boundsWidth;
  const plotFraction = Math.min(1, Math.max(0, (xFraction - plotStartFraction) / (plotEndFraction - plotStartFraction)));
  return domainStart + plotFraction * (domainEnd - domainStart);
}

/** Comparison prices are usable only when timestamped inside this live round. */
export function isFreshRoundComparison(
  asOf: string | number | null | undefined,
  roundStartMs: number,
  serverTimeMs: number,
  nowMs: number,
  maxAgeMs = 14_000,
): boolean {
  const sampleMs = typeof asOf === "number" ? asOf : typeof asOf === "string" ? Date.parse(asOf) : NaN;
  return Number.isFinite(sampleMs) &&
    Number.isFinite(roundStartMs) &&
    Number.isFinite(serverTimeMs) &&
    Number.isFinite(nowMs) &&
    sampleMs >= roundStartMs &&
    sampleMs <= nowMs + 1_000 &&
    nowMs - sampleMs >= -1_000 &&
    nowMs - sampleMs <= maxAgeMs;
}

export type ComparisonPoint = {
  at: number;
  price: number | null;
  gap?: boolean;
  reason?: string;
  sourceAt?: string | number | null;
  eventId?: string | number;
  streamId?: string | number;
};

/** An inspected observation stays selected as new stream samples arrive. */
export function inspectedPointKey(point: { at: number | string; price: number | null; gap?: boolean; eventId?: string | number; streamId?: string | number }): string {
  const identity = point.eventId ?? point.streamId;
  if (identity != null) return `event:${typeof identity}:${String(identity)}`;
  return `sample:${point.at}:${point.price == null || point.gap ? "gap" : point.price}`;
}

function pointTimestamp(point: ComparisonPoint): number {
  return typeof point.sourceAt === "number"
    ? point.sourceAt
    : typeof point.sourceAt === "string" ? Date.parse(point.sourceAt) : NaN;
}

function pointIdentity(point: ComparisonPoint): string | null {
  const identity = point.eventId ?? point.streamId;
  return identity == null ? null : `${typeof identity}:${String(identity)}`;
}

function pointObservationKey(point: ComparisonPoint): string {
  const timestamp = pointTimestamp(point);
  const at = Number.isFinite(timestamp) ? timestamp : point.at;
  return point.gap || point.price === null
    ? `gap:${at}:${point.reason ?? ""}`
    : `tick:${at}:${point.price}`;
}

/** Merge archive and stream samples without conflating identified same-time trades. */
export function mergeComparisonPoints<T extends ComparisonPoint>(
  history: readonly T[],
  stream: readonly T[],
): T[] {
  const identified = new Map<string, T>();
  for (const point of [...history, ...stream]) {
    const identity = pointIdentity(point);
    if (identity) identified.set(identity, point);
  }
  const identityObservations = new Set(
    Array.from(identified.values(), pointObservationKey),
  );
  const anonymous = new Map<string, T>();
  for (const point of [...history, ...stream]) {
    if (pointIdentity(point)) continue;
    const key = pointObservationKey(point);
    if (identityObservations.has(key)) continue;
    if (!anonymous.has(key)) anonymous.set(key, point);
  }
  return [...Array.from(identified.values()), ...Array.from(anonymous.values())]
    .filter(point => Number.isFinite(point.at))
    .sort((a, b) => a.at - b.at);
}

export type RoundTick<T extends ComparisonPoint> = { point: T; roundId: string };

/** Pick a fresh source-stamped tick only for the matching active round. */
export function chooseLatestRoundTick<T extends ComparisonPoint>(
  current: RoundTick<T> | null,
  candidate: T | null,
  candidateRoundId: string | null,
  activeRoundId: string | null,
  roundStartMs: number,
  serverTimeMs: number,
  nowMs: number,
  maxAgeMs = 14_000,
  roundEndMs = Infinity,
): RoundTick<T> | null {
  if (!candidate || !candidateRoundId || candidateRoundId !== activeRoundId ||
      candidate.gap || candidate.price == null || !Number.isFinite(candidate.price) ||
      candidate.price <= 0 ||
      pointTimestamp(candidate) > roundEndMs ||
      !isFreshRoundComparison(pointTimestamp(candidate), roundStartMs, serverTimeMs, nowMs, maxAgeMs)) return null;
  if (current?.roundId === activeRoundId) {
    const currentAt = pointTimestamp(current.point);
    const candidateAt = pointTimestamp(candidate);
    if (Number.isFinite(currentAt) && currentAt > candidateAt &&
        isFreshRoundComparison(currentAt, roundStartMs, serverTimeMs, nowMs, maxAgeMs)) return current;
  }
  return { point: candidate, roundId: candidateRoundId };
}