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
  const enqueue = (input: T): void => {
    const interval = input.intervalMinutes;
    if (active.has(interval)) {
      pending.set(interval, input);
      return;
    }
    const job = run(input).catch(error => onFailure(interval, error)).finally(() => {
      if (active.get(interval) === job) active.delete(interval);
      const next = pending.get(interval);
      pending.delete(interval);
      if (next) enqueue(next);
    });
    active.set(interval, job);
  };
  return { enqueue, active, pending };
}