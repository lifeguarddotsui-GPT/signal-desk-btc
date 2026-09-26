import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm } from "node:fs/promises";

async function main() {
  await rm("dist", { recursive: true, force: true });
  await viteBuild();
  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "esm",
    outfile: "dist/index.mjs",
    packages: "external",
    target: "node22",
    logLevel: "info",
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });