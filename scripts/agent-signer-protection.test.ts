import test from "node:test";
import assert from "node:assert/strict";
import {Ed25519Keypair} from "@mysten/sui/keypairs/ed25519";
import {defaultAgentPolicy} from "../shared/agent-policy";
import {createProtectedDelegate,recoverProtectedDelegate,verifySignerPermit} from "../infrastructure/agent-signer/protection";

test("isolated key envelopes recover after restart and reject owner/ciphertext/wrapping-key substitution",async()=>{
  const wrapping=await crypto.subtle.generateKey({name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
  const owner=Ed25519Keypair.generate().toSuiAddress();
  const envelope=await createProtectedDelegate(owner,wrapping);
  const serialized=JSON.stringify(envelope);
  assert.doesNotMatch(serialized,/suiprivkey|privateKey|secretKey/);
  const restored=await recoverProtectedDelegate(JSON.parse(serialized),wrapping);
  assert.equal(restored.toSuiAddress(),envelope.delegateAddress);
  const otherOwner=Ed25519Keypair.generate().toSuiAddress();
  await assert.rejects(recoverProtectedDelegate({...envelope,owner:otherOwner},wrapping));
  const altered=structuredClone(envelope);altered.ciphertext[0]^=1;
  await assert.rejects(recoverProtectedDelegate(altered,wrapping));
  const wrong=await crypto.subtle.generateKey({name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
  await assert.rejects(recoverProtectedDelegate(envelope,wrong));
});
test("wallet login is not a trading permit; session authority binds the owner, strategy and exact reviewed limits",async()=>{
  const owner=Ed25519Keypair.generate(),other=Ed25519Keypair.generate(),now=Date.now();
  const permit={domain:"bluewater-mainnet-session-v1",network:"sui:mainnet",owner:owner.toSuiAddress(),
    accountId:"0x"+"2".padStart(64,"0"),delegateAddress:other.toSuiAddress(),nonce:"a".repeat(64),policyVersion:1,
    policy:{...defaultAgentPolicy,signalSource:"EXPERIMENTAL_QUALIFICATION_GATES",roundCollateralCents:1000,
      fixedCents:700,sessionGasBudgetMist:100000000},issuedAtMs:now-100,expiresAtMs:now+60000,
    experimentalConfirmed:true,compoundingConfirmed:false,pilotOneOrder:true};
  const message=new TextEncoder().encode(JSON.stringify(permit));
  const signed=await owner.signPersonalMessage(message);
  const verified=await verifySignerPermit(message,signed.signature,now);
  assert.equal(verified.policy.roundCollateralCents,1000);
  assert.equal(verified.accountId,"0x"+"2".padStart(64,"0"));
  const wrong=await other.signPersonalMessage(message);
  await assert.rejects(verifySignerPermit(message,wrong.signature,now));
  const edited=new TextEncoder().encode(JSON.stringify({...permit,policyVersion:2}));
  await assert.rejects(verifySignerPermit(edited,signed.signature,now));
  await assert.rejects(verifySignerPermit(message,signed.signature,now+60001));
  const login=new TextEncoder().encode("Bluewater Agent wallet verification");
  const loginSig=await owner.signPersonalMessage(login);
  await assert.rejects(verifySignerPermit(login,loginSig.signature,now));
});
