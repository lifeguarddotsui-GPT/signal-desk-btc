import express from "express";
import { createServer } from "node:http";
import { registerRoutes } from "./routes";
import { initializeStore } from "./btc/store";
import { startPriceCapture } from "./btc/chart";
import { startWaterxCapture } from "./waterx/service";
import { serveStatic } from "./static";

async function main() {
  // Existing databases and legacy tables are deliberately left untouched.
  await initializeStore();
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  const server = createServer(app);
  registerRoutes(app);
  app.use("/api/{*path}", (_req, res) => res.status(404).json({ error: "Not found" }));
  if (process.env.NODE_ENV === "production") serveStatic(app);
  else {
    const { setupVite } = await import("./vite");
    await setupVite(server, app);
  }
  const port = Number(process.env.PORT || 5000);
  server.listen(port, "0.0.0.0", () => {
    console.log(`Signal Desk listening on ${port} (manual/read-only)`);
    // In an approved continuously running deployment the leased worker owns
    // BOTH collectors. The web process must not duplicate the BTC stream.
    if (process.env.WATERX_EXTERNAL_COLLECTOR !== "true") {
      startPriceCapture();
      startWaterxCapture({ onStalled: () => { process.exit(1); } });
    }
  });
}
main().catch(error => {
  console.error("Cannot start Signal Desk:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});