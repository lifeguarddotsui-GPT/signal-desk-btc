import express from "express";
import { createVisitorActivityGate } from "./visitor-activity";
import { registerVisitorPresence } from "./visitor-routes";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerRoutes } from "./routes";
import { initializeStore } from "./btc/store";
import { startPriceCapture } from "./btc/chart";
import {startTwoStageSupport} from "./waterx/two-stage-support";
import { startWaterxCapture } from "./waterx/service";
import { startResearchSchedule } from "./waterx/research-training";
import { startResearchMaintenance } from "./waterx/research-maintenance";
import { serveStatic } from "./static";
import { protocolStatus } from "./agent/protocol";

type VisitorGate = ReturnType<typeof createVisitorActivityGate>;

export function createApp(visitorGate?: VisitorGate) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  if (visitorGate) registerVisitorPresence(app, visitorGate);
  registerRoutes(app);
  app.use("/api/{*path}", (_req, res) => res.status(404).json({ error: "Not found" }));
  return app;
}

export function startStoreInitializationRecovery(
  initialize: () => Promise<unknown>,
  onReady: () => void,
  options: {
    initialDelayMs?: number;
    maxDelayMs?: number;
    onFailure?: (error: unknown, retryDelayMs: number) => void;
  } = {},
): () => void {
  const initialDelayMs = Math.max(1, options.initialDelayMs ?? 1_000);
  const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? 60_000);
  let stopped = false;
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;

  const attempt = async (): Promise<void> => {
    try {
      await initialize();
    } catch (error) {
      if (stopped) return;
      failures += 1;
      const retryDelayMs = Math.min(maxDelayMs,
        initialDelayMs * 2 ** Math.min(failures - 1, 30));
      options.onFailure?.(error, retryDelayMs);
      timer = setTimeout(() => { void attempt(); }, retryDelayMs);
      return;
    }
    if (!stopped) onReady();
  };

  void attempt();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

async function main() {
  // Read-only verification. Failure withholds owner account operations rather
  // than falling back to staging/testnet or enabling an order adapter.
  if(process.env.NODE_ENV==="development"){
    const identity=await protocolStatus();
    console.log(`WaterX mainnet account identity: ${identity.status}; trading release remains DISABLED.`);
  }
  const visitorOnly = process.env.WATERX_VISITOR_ONLY_MODE === "true";
  let cancelInitialization: (() => void) | null = null;
  let activeStops: Array<() => void> = [];
  let gate: VisitorGate | undefined;
  if (visitorOnly) {
    gate = createVisitorActivityGate({
      wake: () => {
        // An independent VM or worker may still keep PostgreSQL alive. Refuse
        // a false cost-saving claim rather than silently running two owners.
        if (process.env.WATERX_EXTERNAL_COLLECTOR === "true")
          throw new Error("Stop the external Replit collector before visitor-only activation");
        cancelInitialization = startStoreInitializationRecovery(initializeStore, () => {
          if (!gate?.active()) return;
          const stops: Array<() => void> = [];
          try {
            stops.push(startTwoStageSupport());
            stops.push(startPriceCapture());
            stops.push(startWaterxCapture({
              onStalled: (interval, ageMs) => {
                console.error(`[waterx-${interval}m] visitor-only capture stalled for ${ageMs}ms`);
              },
            }));
            stops.push(startResearchMaintenance());
            stops.push(startResearchSchedule({ mode: "opportunistic-existing-process" }));
            activeStops = stops;
            gate.markReady();
            console.log("Visible visitor activated WaterX collectors.");
          } catch (error) {
            for (const stop of stops.reverse()) { try { stop(); } catch { /* continue */ } }
            console.error("Visitor collectors failed to start:", error);
          }
        }, {
          onFailure: (error, delay) =>
            console.warn(`Visitor database initialization retry in ${delay}ms: ${error instanceof Error ? error.message : "unknown"}`),
        });
      },
      sleep: () => {
        cancelInitialization?.();
        cancelInitialization = null;
        for (const stop of activeStops.reverse()) {
          try { stop(); } catch (error) { console.error("Visitor collector stop failed:", error); }
        }
        activeStops = [];
        console.log("No active visitor; collector timers and live feeds stopped.");
      },
    });
    gate.begin();
  }
  const app = createApp(gate);
  const server = createServer(app);
  if (process.env.NODE_ENV === "production") serveStatic(app);
  else {
    const { setupVite } = await import("./vite");
    await setupVite(server, app);
  }
  const port = Number(process.env.PORT || 5000);
  server.listen(port, "0.0.0.0", () => {
    console.log(`Signal Desk listening on ${port} (manual/read-only)`);
    // Serve first: database availability must not gate the homepage or liveness.
    // In visitor-only mode startup is deliberately passive: no database
    // initialization, collectors, history scans or chart persistence.
    if (visitorOnly) {
      console.log("Visitor-only mode: awaiting visible-browser heartbeat.");
      return;
    }
    // Store checks retry serially with capped backoff, without touching schema.
    startStoreInitializationRecovery(initializeStore, () => {
      console.log("Signal Desk store initialization recovered.");
      // In an approved continuously running deployment the leased worker owns
      // BOTH collectors. The web process must not duplicate the BTC stream.
      if (process.env.WATERX_EXTERNAL_COLLECTOR === "true") return;
      startTwoStageSupport();
      startPriceCapture();
      startWaterxCapture({
        onStalled: (interval, ageMs) => {
          console.error(`[waterx-${interval}m] web-only fault isolation: read stalled at ${ageMs}ms; ` +
            "the server remains available, but WaterX must not be treated as LIVE until a fresh observation.");
        },
      });
      // Uses only the existing process and an exclusive per-job DB lease.
      // Autoscale sleep can miss days; neither timer creates an always-on host.
      startResearchMaintenance();
      startResearchSchedule({ mode: "opportunistic-existing-process" });
    }, {
      onFailure: (error, retryDelayMs) => {
        console.error("Store initialization unavailable; web server remains available and will retry in " +
          `${retryDelayMs}ms:`, error instanceof Error ? error.message : "unknown error");
      },
    });
  });
}

const launchedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (launchedDirectly) {
  main().catch(error => {
    console.error("Cannot start Signal Desk:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  });
}