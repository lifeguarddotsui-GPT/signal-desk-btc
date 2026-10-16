/**
 * Process-local visible-browser leases. No database, queue, or background worker
 * is touched until a client explicitly sends a heartbeat.
 *
 * This is a cost control, not proof of a human: automated clients can imitate
 * browser requests. Never use visitor presence as trading authorization.
 */
export const VISITOR_LEASE_MS = 45_000;
export const VISITOR_SWEEP_MS = 5_000;
export const VISITOR_MAX_SESSIONS = 512;

export function validVisitorSessionId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

type GateOptions = {
  wake(): void;
  sleep(): void;
  now?: () => number;
  leaseMs?: number;
  maxSessions?: number;
  schedule?: typeof setInterval;
  unschedule?: typeof clearInterval;
};
export function createVisitorActivityGate(options: GateOptions) {
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? VISITOR_LEASE_MS;
  const maxSessions = options.maxSessions ?? VISITOR_MAX_SESSIONS;
  const sessions = new Map<string, number>();
  let running = false;
  let ready = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const prune = () => {
    const at = now();
    for (const [id, seen] of Array.from(sessions)) {
      if (at - seen >= leaseMs || at < seen) sessions.delete(id);
    }
  };
  const active = () => { prune(); return sessions.size > 0; };
  const reap = () => {
    prune();
    if (running && sessions.size === 0) {
      running = false;
      ready = false;
      options.sleep();
    }
  };
  const begin = () => {
    if (timer) return;
    const schedule = options.schedule ?? setInterval;
    timer = schedule(reap, VISITOR_SWEEP_MS);
    timer.unref?.();
  };
  const beat = (id: unknown) => {
    if (!validVisitorSessionId(id)) return "invalid" as const;
    prune();
    if (!sessions.has(id) && sessions.size >= maxSessions) return "at-capacity" as const;
    sessions.set(id, now());
    if (!running) {
      running = true;
      ready = false;
      try { options.wake(); }
      catch (error) {
        running = false;
        sessions.delete(id);
        throw error;
      }
    }
    return "accepted" as const;
  };
  const leave = (id: unknown) => {
    if (!validVisitorSessionId(id)) return false;
    const existed = sessions.delete(id);
    // A browser unloading does not justify cancelling a DB transaction mid-commit.
    // The next bounded sweep stops all future collectors.
    return existed;
  };
  const markReady = () => { if (running && active()) ready = true; };
  const status = () => {
    prune();
    return { activeVisitors: sessions.size, collecting: running && sessions.size > 0,
      ready: running && ready && sessions.size > 0, idle: sessions.size === 0 };
  };
  const close = () => {
    if (timer) (options.unschedule ?? clearInterval)(timer);
    timer = null; sessions.clear(); reap();
  };
  return { begin, beat, leave, reap, status, active, markReady, close };
}
