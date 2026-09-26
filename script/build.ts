import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

async function clientFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async entry => {
    const filePath = path.join(directory, entry.name);
    return entry.isDirectory() ? clientFiles(filePath) : [filePath];
  }));
  return files.flat();
}

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

  // Identify the packaged output and locked external runtime dependencies;
  // this is deliberately not a workspace Git revision.
  const files = ["dist/index.mjs", ...(await clientFiles("dist/public")), "package-lock.json"]
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const relativePath = file === "package-lock.json" ? file :
      path.relative("dist", file).split(path.sep).join("/");
    const contents = await readFile(file);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(String(contents.byteLength));
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  await writeFile("dist/build-info.json", JSON.stringify({
    id: `sha256:${hash.digest("hex")}`,
    format: 1,
  }) + "\n");
}
main().catch(error => { console.error(error); process.exitCode = 1; });