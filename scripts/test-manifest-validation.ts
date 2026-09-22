import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { manifestAuthorizesCheckpoint, validatedManifests } from "../server/services/operationalApi";

const pkg = `0x${"a".repeat(64)}`;
const defining = `0x${"b".repeat(64)}`;
const digests = ["1".repeat(44), "2".repeat(44), "3".repeat(44), "4".repeat(44)];
function row(overrides: Record<string, unknown> = {}) {
  const manifest = {
    enabled: true, packageId: pkg, definingPackageId: defining, packageVersion: "1", module: "curve",
    buyFunctionTarget: `${pkg}::curve::buy`, sellFunctionTarget: `${pkg}::curve::sell`,
    buyEventType: `${pkg}::curve::Buy`, sellEventType: `${pkg}::curve::Sell`,
    curveObjectType: `${pkg}::curve::Curve`,
    evidenceTransactions: [
      { kind: "BUY", digest: digests[0] }, { kind: "BUY", digest: digests[1] },
      { kind: "SELL", digest: digests[2] }, { kind: "SELL", digest: digests[3] },
    ],
  };
  return {
    id: "manifest-test", network: "mainnet", packageId: pkg, definingPackageId: defining,
    version: "1", manifest, checksum: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    status: "VERIFIED_ON_CHAIN", validFromCheckpoint: "100", evidenceDigests: digests,
    verifiedAt: new Date(), createdAt: new Date(), ...overrides,
  } as any;
}
const valid = validatedManifests([row()]);
assert.equal(valid.size, 1);
assert.equal(manifestAuthorizesCheckpoint(valid, pkg, "99"), false);
assert.equal(manifestAuthorizesCheckpoint(valid, pkg, "100"), true);
assert.equal(validatedManifests([row({ status: "DISABLED" })]).size, 0);
assert.equal(validatedManifests([row({ evidenceDigests: [...digests, "5".repeat(44)] })]).size, 0);
const duplicate = row();
duplicate.manifest.evidenceTransactions[1].digest = digests[0];
duplicate.checksum = createHash("sha256").update(JSON.stringify(duplicate.manifest)).digest("hex");
assert.equal(validatedManifests([duplicate]).size, 0);
const reused = row();
reused.manifest.evidenceTransactions[2].digest = digests[0];
reused.checksum = createHash("sha256").update(JSON.stringify(reused.manifest)).digest("hex");
assert.equal(validatedManifests([reused]).size, 0);
console.log(JSON.stringify({ passed: true, cases: ["valid", "pre-validity", "revoked", "padded", "duplicate", "cross-side-reuse"] }));