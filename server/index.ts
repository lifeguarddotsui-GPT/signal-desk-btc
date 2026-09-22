import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { exec } from "child_process";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "./db";
import { startSuipumpCollector } from "./services/suipumpCollector";

process.on("unhandledRejection", (reason: any) => {
  console.error("[Server] Unhandled rejection:", reason?.message ?? reason);
});

process.on("uncaughtException", (err: Error) => {
  if ((err as any).code === "EADDRINUSE") return;
  console.error("[Server] Uncaught exception:", err.message);
});

const app = express();
const httpServer = createServer(app);
const PgSessionStore = connectPgSimple(session);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.set("trust proxy", 1);
app.use(session({
  secret: process.env.SESSION_SECRET || "development-only-session-secret",
  resave: false,
  saveUninitialized: false,
  store: new PgSessionStore({
    pool,
    tableName: "accumulation_owner_sessions",
    createTableIfMissing: false,
  }),
  cookie: {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000,
  },
}));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      log(JSON.stringify({ method: req.method, path, statusCode: res.statusCode, durationMs: duration }));
    }
  });
  next();
});

function freePort(port: number): Promise<void> {
  return new Promise((resolve) => {
    exec(`fuser -k ${port}/tcp 2>/dev/null`, () => { setTimeout(resolve, 800); });
  });
}

(async () => {
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", timestamp: Date.now() });
  });

  await registerRoutes(httpServer, app);

  app.use("/api", (_req, res) => {
    res.status(404).json({ code: "API_ROUTE_NOT_FOUND", message: "This API route is not active." });
  });

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
  if (process.env.NODE_ENV !== "production") await freePort(port);

  httpServer.listen({ port, host: "0.0.0.0", reusePort: true }, () => {
    log(`serving on port ${port}`);
    startSuipumpCollector();
  });
})();
