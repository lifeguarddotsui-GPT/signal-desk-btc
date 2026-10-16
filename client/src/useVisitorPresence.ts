import { useEffect, useState } from "react";

type PresenceStatus = {
  mode?: string;
  ready?: boolean;
};

/**
 * A visible tab must acquire a server lease before mounting database-backed
 * charts, history, training pages or the Agent dashboard. Background tabs
 * relinquish their lease and stop requesting new history.
 */
export function useVisitorPresence(): { ready: boolean; pending: boolean } {
  const [state, setState] = useState<"probing" | "ready" | "waiting">("probing");
  useEffect(() => {
    let cancelled = false;
    let visitorMode = false;
    let busy = false;
    let nextHeartbeatDelayMs = 2_000;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const sessionId = crypto.randomUUID();
    const clearRetry = () => { if (retry) clearTimeout(retry); retry = undefined; };

    const leave = () => {
      clearRetry();
      if (!visitorMode) return;
      if (!cancelled) setState("waiting");
      const body = JSON.stringify({ sessionId });
      // Delivery may fail on mobile suspension. The server's expiring lease
      // still guarantees bounded shutdown if the leave request never arrives.
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/visitor/leave",
          new Blob([body], { type: "application/json" }));
      } else {
        void fetch("/api/visitor/leave", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body, keepalive: true, credentials: "same-origin",
        }).catch(() => {});
      }
    };
    const heartbeat = async () => {
      if (cancelled || busy || !visitorMode || document.visibilityState !== "visible") return;
      busy = true;
      try {
        const response = await fetch("/api/visitor/heartbeat", {
          method: "POST", headers: { "Content-Type": "application/json" },
          credentials: "same-origin", cache: "no-store",
          body: JSON.stringify({ sessionId }),
        });
        if (!response.ok) throw new Error("Visitor collection unavailable");
        const status = await response.json() as PresenceStatus;
        nextHeartbeatDelayMs = status.ready ? 15_000 : 2_000;
        if (!cancelled) setState(status.ready && document.visibilityState === "visible" ? "ready" : "waiting");
      } catch {
        nextHeartbeatDelayMs = 3_000;
        if (!cancelled) setState("waiting");
      } finally {
        busy = false;
        if (!cancelled && document.visibilityState === "visible")
          retry = setTimeout(() => { void heartbeat(); }, nextHeartbeatDelayMs);
      }
    };
    const updateVisibility = () => {
      if (document.visibilityState !== "visible") leave();
      else if (visitorMode) {
        clearRetry();
        void heartbeat();
      }
    };
    document.addEventListener("visibilitychange", updateVisibility);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", updateVisibility);
    // Probe costs zero database queries, and also maintains backwards
    // compatibility with deployments where visitor-only mode is not enabled.
    const probe = async () => {
      if (cancelled) return;
      try {
        const response = await fetch("/api/visitor/status", { cache: "no-store" });
        // Older app deployments without visitor mode do not expose this route.
        if (response.status === 404) {
          if (!cancelled) setState("ready");
          return;
        }
        if (!response.ok) throw new Error("Visitor mode probe unavailable");
        const status = await response.json() as PresenceStatus;
        if (cancelled) return;
        visitorMode = status.mode === "visitor-only";
        if (!visitorMode) setState("ready");
        else if (document.visibilityState === "visible") void heartbeat();
        else setState("waiting");
      } catch {
        // Never bypass visitor protection on a temporary network failure:
        // the server might be enforcing the visitor-only gate.
        if (!cancelled) {
          setState("waiting");
          retry = setTimeout(() => { void probe(); }, 3_000);
        }
      }
    };
    void probe();
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", updateVisibility);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", updateVisibility);
      leave();
      clearRetry();
    };
  }, []);
  return { ready: state === "ready", pending: state !== "ready" };
}
