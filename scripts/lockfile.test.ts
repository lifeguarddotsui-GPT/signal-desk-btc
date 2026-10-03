import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const npmrc = readFileSync(".npmrc", "utf8");
const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
  lockfileVersion: number;
  packages: Record<string, { version?: string; resolved?: string; integrity?: string }>;
};

test("npm remaps public registry URLs without double-rewriting checked mirror URLs", () => {
  const entries = Object.fromEntries(npmrc.split(/\r?\n/)
    .filter(line => line && !line.startsWith("#"))
    .map(line => {
      const split = line.indexOf("=");
      return [line.slice(0, split), line.slice(split + 1)];
    }));

  assert.equal(entries.registry, "https://registry.npmjs.org/");
  assert.equal(entries["replace-registry-host"], "npmjs");
});

test("every locked npm package has a public HTTPS tarball and integrity digest", () => {
  assert.equal(lock.lockfileVersion, 3);
  const packages = Object.entries(lock.packages).filter(([path, pkg]) => path && pkg.version);
  assert.ok(packages.length > 0);

  for (const [path, pkg] of packages) {
    assert.ok(pkg.resolved, `${path} has a resolved tarball URL`);
    const url = new URL(pkg.resolved!);
    assert.equal(url.protocol, "https:", `${path} uses HTTPS`);
    assert.equal(url.hostname, "registry.npmjs.org", `${path} uses the official npm registry`);
    assert.ok(pkg.integrity && /^(sha1|sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}(?:\s+(?:sha1|sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2})*$/.test(pkg.integrity),
      `${path} retains a valid Subresource Integrity digest`);
  }
});