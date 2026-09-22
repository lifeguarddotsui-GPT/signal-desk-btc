import assert from "node:assert/strict";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:5000";

async function authenticate(keypair) {
  const address = keypair.toSuiAddress();
  const challengeResponse = await fetch(`${base}/api/auth/challenge?address=${address}`);
  assert.equal(challengeResponse.status, 200);
  const challengeCookie = challengeResponse.headers.get("set-cookie")?.split(";")[0];
  const challenge = await challengeResponse.json();
  const signed = await keypair.signPersonalMessage(new TextEncoder().encode(challenge.message));
  const body = JSON.stringify({ address, signature: signed.signature });
  const verified = await fetch(`${base}/api/auth/verify`, {
    method: "POST", headers: { cookie: challengeCookie, "content-type": "application/json" }, body,
  });
  assert.equal(verified.status, 200);
  const sessionCookie = verified.headers.get("set-cookie")?.split(";")[0];
  const replay = await fetch(`${base}/api/auth/verify`, {
    method: "POST", headers: { cookie: challengeCookie, "content-type": "application/json" }, body,
  });
  assert.equal(replay.status, 401);
  return { address, cookie: sessionCookie };
}

const ownerA = await authenticate(new Ed25519Keypair());
const ownerB = await authenticate(new Ed25519Keypair());
const created = await fetch(`${base}/api/agents`, {
  method: "POST", headers: { cookie: ownerA.cookie, "content-type": "application/json" }, body: JSON.stringify({ mode: "PAPER" }),
});
assert.equal(created.status, 201);
const agent = await created.json();
assert.equal(agent.ownerAddress, ownerA.address);
assert.equal("signerKeyReference" in agent, false);

const reads = ["", "/decisions", "/orders", "/fills", "/positions", "/ledger"];
for (const suffix of reads) {
  const response = await fetch(`${base}/api/agents/${agent.id}${suffix}`, { headers: { cookie: ownerB.cookie } });
  assert.equal(response.status, 404, `cross-wallet read ${suffix || "/"} must be hidden`);
}
const controls = [
  ["arm", {}], ["mode", { mode: "PAPER" }], ["pause", {}], ["resume", {}], ["withdraw", {}],
];
for (const [action, payload] of controls) {
  const response = await fetch(`${base}/api/agents/${agent.id}/${action}`, {
    method: "POST", headers: { cookie: ownerB.cookie, "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  assert.equal(response.status, 404, `cross-wallet ${action} must be hidden`);
}
const invalidMode = await fetch(`${base}/api/agents/${agent.id}/mode`, {
  method: "POST", headers: { cookie: ownerA.cookie, "content-type": "application/json" }, body: JSON.stringify({ mode: "LIVE" }),
});
assert.equal(invalidMode.status, 400);
console.log(JSON.stringify({ passed: true, replayProtected: true, isolatedRoutes: reads.length + controls.length, invalidModeRejected: true }));