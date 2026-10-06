import type { WaterxInterval } from "./types";

/**
 * Coalesce slow optional work per interval without keeping a market read open.
 * The earliest job finishes first; while it runs, retain only the newest
 * pending observation (including a round change), never parallel writes.
 */
export function createWaterxBackgroundQueue<T extends { intervalMinutes: WaterxInterval }>(
  run: (input: T) => Promise<void>,
  onFailure: (interval: WaterxInterval, error: unknown) => void,
) {
  const active = new Map<WaterxInterval, Promise<void>>();
  const pending = new Map<WaterxInterval, T>();
  const startedAt=new Map<WaterxInterval,number>();
  let completed=0,failures=0,coalesced=0,lastFailureAtMs:number|null=null;
  const enqueue = (input: T): void => {
    const interval = input.intervalMinutes;
    if (active.has(interval)) {
      coalesced++;
      pending.set(interval, input);
      return;
    }
    startedAt.set(interval,Date.now());
    const job = run(input).catch(error => {
      failures++;lastFailureAtMs=Date.now();onFailure(interval,error);
    }).finally(() => {
      completed++;startedAt.delete(interval);
      if (active.get(interval) === job) active.delete(interval);
      const next = pending.get(interval);
      pending.delete(interval);
      if (next) enqueue(next);
    });
    active.set(interval, job);
  };
  return { enqueue, active, pending,metrics:(now=Date.now())=>({
    active:active.size,pending:pending.size,depth:active.size+pending.size,
    oldestActiveAgeMs:startedAt.size?Math.max(...Array.from(startedAt.values(),at=>Math.max(0,now-at))):null,
    completed,failures,coalesced,lastFailureAtMs}) };
}