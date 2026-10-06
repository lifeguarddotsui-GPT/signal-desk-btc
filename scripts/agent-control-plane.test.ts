import test from "node:test";
import assert from "node:assert/strict";
import {websiteControlPlaneStatus,assertWebsiteInvocationEnvironment,deploymentCredentialNames} from "../infrastructure/agent-signer/control-plane";
// @ts-expect-error operator helper is intentionally plain JavaScript
import {assertOperatorEnvironment,validateOperatorArtifact} from "./operator-environment.mjs";

test("every recognized administration credential blocks website signer invocation without revealing values",()=>{
  for(const key of deploymentCredentialNames){
    const env={[key]:"test-sensitive-value"};
    const status=websiteControlPlaneStatus(env);
    assert.equal(status.administrationCredentialPresent,true);
    assert.equal(JSON.stringify(status).includes("test-sensitive-value"),false);
    assert.throws(()=>assertWebsiteInvocationEnvironment(env),/deployment authority/);
  }
});
test("absence is not falsely promoted to verified isolation or funded authority",()=>{
  const status=websiteControlPlaneStatus({});
  assert.equal(status.separationVerified,false);
  assert.equal(status.fundedSigningAllowed,false);
});
test("invocation configuration is pinned to a dedicated Cloudflare pilot, not an admin API or arbitrary recipient",()=>{
  const env={AGENT_SIGNER_INVOKE_TOKEN:"x".repeat(64),AGENT_SIGNER_URL:"https://bluewater-single-wallet-executor.owner-admin.workers.dev"};
  assert.equal(assertWebsiteInvocationEnvironment(env),env.AGENT_SIGNER_URL);
  for(const url of ["http://localhost:5000","https://api.cloudflare.com","https://bluewater-single-wallet-executor.owner-admin.workers.dev/?token=x",
    "https://user:password@bluewater-single-wallet-executor.owner-admin.workers.dev"]){
    assert.throws(()=>assertWebsiteInvocationEnvironment({...env,AGENT_SIGNER_URL:url}));
  }
});
test("operator deployment refuses inherited Replit contexts even when owner-admin is set",()=>{
  const env={BLUEWATER_OPERATOR_CONTEXT:"owner-admin",BLUEWATER_OPERATOR_DEPLOY_TOKEN:"test-token"};
  assert.doesNotThrow(()=>assertOperatorEnvironment(env));
  for(const key of ["REPL_ID","REPLIT_DEPLOYMENT","REPLIT_DEV_DOMAIN","REPLIT_CONNECTORS_HOSTNAME","BLUEWATER_PUBLIC_WEB_RUNTIME"])
    assert.throws(()=>assertOperatorEnvironment({...env,[key]:"present"}),/outside Replit/);
});
test("operator mutation requires exact reviewed bytes and refuses namespace deletion or paid activation",()=>{
  const sha="a".repeat(64),m={script:"bluewater-single-wallet-executor",file:"executor.mjs",sha256:sha};
  assert.doesNotThrow(()=>validateOperatorArtifact(m,new Uint8Array([1]),sha,sha));
  for(const bad of [{...m,activatePaid:true},{...m,deleteNamespace:true},{...m,storageMigration:true},{...m,script:"other-worker"}])
    assert.throws(()=>validateOperatorArtifact(bad,new Uint8Array([1]),sha,sha));
  assert.throws(()=>validateOperatorArtifact(m,new Uint8Array([1]),sha,"b".repeat(64)));
});
