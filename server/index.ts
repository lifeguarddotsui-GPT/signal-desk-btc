import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { exec } from "child_process";
import { startPriceLoop } from "./price-service";
import { tickMarket, getCandleHistory } from "./market-engine";
import { startTradingEngine } from "./engine/trading-engine";

process.on("unhandledRejection", (reason: any) => {
  console.error("[SAFETY] Unhandled promise rejection:", reason?.message ?? reason);
});

process.on("uncaughtException", (err: Error) => {
  if ((err as any).code === "EADDRINUSE") return;
  console.error("[SAFETY] Uncaught exception:", err.message, err.stack?.split("\n")[1]);
});

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      log(logLine);
    }
  });

  next();
});

function freePort(port: number): Promise<void> {
  return new Promise((resolve) => {
    exec(`fuser -k ${port}/tcp 2>/dev/null`, () => {
      setTimeout(resolve, 800);
    });
  });
}

(async () => {
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", timestamp: Date.now() });
  });

  startPriceLoop();

  // Prime the candle history immediately so the engine has candles on its first tick
  setTimeout(async () => {
    try { await tickMarket(); } catch {}
  }, 2000);

  setInterval(async () => {
    try {
      await tickMarket();
    } catch (err: any) {
      console.error("[MarketEngine] Tick error:", err?.message ?? err);
    }
  }, 10_000);

  startTradingEngine(() => getCandleHistory());

  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    console.error("Internal Server Error:", err);
    if (res.headersSent) return next(err);
    return res.status(status).json({ message });
  });

  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  const port = parseInt(process.env.PORT || "5000", 10);
  if (process.env.NODE_ENV !== "production") {
    await freePort(port);
  }

  httpServer.listen(
    { port, host: "0.0.0.0", reusePort: true },
    () => { log(`serving on port ${port}`); },
  );
})();
