import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { supervise } from "./vm-production-supervisor.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "signal-desk-vm-"));
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "index.mjs"), "");
  await writeFile(path.join(root, "dist", "waterx-worker.mjs"), "");
  return root;
}

function child() {
  const process = new EventEmitter() as EventEmitter & {
    kill: (signal: string) => boolean;
    killSignals: string[];
  };
  process.killSignals = [];
  process.kill = signal => {
    process.killSignals.push(signal);
    setImmediate(() => process.emit("exit", null, signal));
    return true;
  };
  return process;
}

test("VM supervisor starts web only after worker lease readiness and fails both together", async () => {
  const root = await fixture();
  const signals = new EventEmitter();
  const worker = child();
  const web = child();
  let webStarted!: () => void;
  const webHasStarted = new Promise<void>(resolve => { webStarted = resolve; });
  try {
    const result = supervise({
      root,
      signals,
      startupTimeoutMs: 2_000,
      spawnWorker: (_path: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        assert.equal(options.env.NODE_ENV, "production");
        setImmediate(() => worker.emit("message", { type: "waterx-worker-ready" }));
        return worker;
      },
      spawnWeb: (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        assert.match(args[0], /dist\/index\.mjs$/);
        assert.equal(options.env.WATERX_EXTERNAL_COLLECTOR, "true");
        webStarted();
        return web;
      },
    });
    await webHasStarted;
    web.emit("exit", 1, null);
    assert.equal(await result, 1);
    assert.deepEqual(worker.killSignals, ["SIGTERM"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("VM supervisor never launches web when the lease-owning worker exits early", async () => {
  const root = await fixture();
  const signals = new EventEmitter();
  const worker = child();
  let webLaunches = 0;
  try {
    const result = supervise({
      root,
      signals,
      spawnWorker: () => {
        setImmediate(() => worker.emit("exit", 1, null));
        return worker;
      },
      spawnWeb: () => { webLaunches++; return child(); },
    });
    assert.equal(await result, 1);
    assert.equal(webLaunches, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});