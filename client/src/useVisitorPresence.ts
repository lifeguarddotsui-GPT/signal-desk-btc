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
    let retry: ReturnType<typeof setTimeout> | undefined;
    const sessionId = crypto.randomUUID();
    const clearRetry = () => { if (retry) clearTimeout(retry); retry = undefined; };

    const leave = () => {
      clearRetry();
      if (!visitorMode) return;
      setState("waiting");
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
        if (!cancelled) setState(status.ready ? "ready" : "waiting");
      } catch {
        if (!cancelled) setState("waiting");
      } finally {
        busy = false;
        if (!cancelled && document.visibilityState === "visible")
          retry = setTimeout(() => { void heartbeat(); }, state === "ready" ? 15_000 : 2_000);
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
    // Probe costs zero database queries, and also maintains backwards
    // compatibility with deployments where visitor-only mode is not enabled.
    void fetch("/api/visitor/status", { cache: "no-store" })
      .then(async response => response.ok ? response.json() as Promise<PresenceStatus> : null)
      .then(status => {
        if (cancelled) return;
        visitorMode = status?.mode === "visitor-only";
        if (!visitorMode) setState("ready");
        else if (document.visibilityState === "visible") void heartbeat();
        else setState("waiting");
      }).catch(() => { if (!cancelled) setState("ready"); });
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", updateVisibility);
      window.removeEventListener("pagehide", leave);
      leave();
      clearRetry();
    };
  }, []);
  return { ready: state === "ready", pending: state !== "ready" };
}
