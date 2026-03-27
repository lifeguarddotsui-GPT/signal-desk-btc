import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { startSentimentFlowEngine } from "./sentiment-flow-engine";
import { serveStatic } from "./static";
import { createServer } from "http";
import { exec } from "child_process";

// Global safety net: log unhandled promise rejections instead of crashing
process.on("unhandledRejection", (reason: any) => {
  console.error("[SAFETY] Unhandled promise rejection:", reason?.message ?? reason);
});

// Global safety net: log uncaught exceptions but keep the process alive
// unless it's a fatal startup error
process.on("uncaughtException", (err: Error) => {
  if ((err as any).code === "EADDRINUSE") {
    // Handled below — let the freePort logic deal with it
    return;
  }
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

/** Kill any process holding the given port, then wait for the OS to release it. */
function freePort(port: number): Promise<void> {
  return new Promise((resolve) => {
    exec(`fuser -k ${port}/tcp 2>/dev/null`, () => {
      // Give the OS 800ms to fully release the port after SIGKILL
      setTimeout(resolve, 800);
    });
  });
}

(async () => {
  startSentimentFlowEngine();
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);

  // Free the port BEFORE attempting to listen — this prevents EADDRINUSE
  // from crashing the Vite WebSocket server that shares the same port.
  await freePort(port);

  httpServer.listen(
    { port, host: "0.0.0.0", reusePort: true },
    () => { log(`serving on port ${port}`); }
  );
})();
