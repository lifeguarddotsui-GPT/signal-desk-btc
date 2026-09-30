import { fork, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Run the leased collector and web server as one fail-closed VM unit. */
export async function supervise({
  root = projectRoot,
  spawnWorker = fork,
  spawnWeb = spawn,
  startupTimeoutMs = 30_000,
  shutdownTimeoutMs = 8_000,
  signals = process,
} = {}) {
  const workerPath = path.join(root, "dist", "waterx-worker.mjs");
  const webPath = path.join(root, "dist", "index.mjs");
  await Promise.all([access(workerPath), access(webPath)]);
  return new Promise(resolve => {
    let worker;
    let web;
    let readyTimer;
    let killTimer;
    let stopping = false;
    let result = 0;
    const exited = new Set();

    const live = child => child && !exited.has(child);
    const finish = () => {
      if (!stopping || (live(worker) || live(web))) return;
      if (readyTimer) clearTimeout(readyTimer);
      if (killTimer) clearTimeout(killTimer);
      signals.removeListener("SIGTERM", onSigterm);
      signals.removeListener("SIGINT", onSigint);
      resolve(result);
    };
    const shutdown = (code, signal = "SIGTERM") => {
      if (stopping) return;
      stopping = true;
      result = code;
      if (readyTimer) clearTimeout(readyTimer);
      for (const child of [worker, web]) {
        if (live(child)) child.kill(signal);
      }
      killTimer = setTimeout(() => {
        for (const child of [worker, web]) {
          if (live(child)) child.kill("SIGKILL");
        }
      }, shutdownTimeoutMs);
      killTimer.unref?.();
      finish();
    };
    const onSigterm = () => shutdown(0, "SIGTERM");
    const onSigint = () => shutdown(0, "SIGINT");
    const childExited = child => {
      exited.add(child);
      if (!stopping) shutdown(1);
      finish();
    };

    signals.once("SIGTERM", onSigterm);
    signals.once("SIGINT", onSigint);
    worker = spawnWorker(workerPath, [], {
      cwd: root,
      env: { ...process.env, NODE_ENV: "production" },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    worker.once("message", message => {
      if (stopping || message?.type !== "waterx-worker-ready" || web) return;
      if (readyTimer) clearTimeout(readyTimer);
      web = spawnWeb(process.execPath, [webPath], {
        cwd: root,
        env: {
          ...process.env,
          NODE_ENV: "production",
          WATERX_EXTERNAL_COLLECTOR: "true",
        },
        stdio: "inherit",
      });
      web.once("exit", () => childExited(web));
      web.once("error", error => {
        console.error("Cannot launch Signal Desk web process:", error);
        childExited(web);
      });
    });
    worker.once("exit", () => childExited(worker));
    worker.once("error", error => {
      console.error("Cannot launch WaterX worker:", error);
      childExited(worker);
    });
    readyTimer = setTimeout(() => {
      console.error("WaterX worker did not acquire its lease before startup timed out.");
      shutdown(1);
    }, startupTimeoutMs);
    readyTimer.unref?.();
  });
}

if (process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  supervise().then(code => { process.exitCode = code; }).catch(error => {
    console.error("Cannot start single-VM production mode:", error);
    process.exitCode = 1;
  });
}