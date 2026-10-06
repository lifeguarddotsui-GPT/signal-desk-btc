// Run ONLY on the owner's separate administrative workstation.
// No secret values, API response bodies, request headers or transaction bytes logged.
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {resolve} from "node:path";
import {assertOperatorEnvironment,validateOperatorArtifact} from "./operator-environment.mjs";

async function main() {
  assertOperatorEnvironment(process.env);
  const [action,account,directory,approvedHash,...extra]=process.argv.slice(2);
  if (!["verify","deploy","rollback"].includes(action) ||
      !/^[a-f0-9]{32}$/.test(account??"") || extra.length)
    throw new Error("Usage: operator-signer.mjs verify ACCOUNT_ID | deploy/rollback ACCOUNT_ID ARTIFACT_DIRECTORY REVIEWED_SHA256");
  if(action==="verify"&&(directory||approvedHash))throw new Error("Verify accepts only an account ID.");
  const api=async(path,options={})=>{
    const r=await fetch(`https://api.cloudflare.com/client/v4${path}`,{
      ...options,headers:{Authorization:`Bearer ${process.env.BLUEWATER_OPERATOR_DEPLOY_TOKEN}`},
      signal:AbortSignal.timeout(45000),
    });
    const result=await r.json().catch(()=>null);
    if(!r.ok||!result?.success)throw new Error(`Operator API rejected (${r.status}); inspect token scope securely. No response body logged.`);
    return result.result;
  };
  const subscriptions=await api(`/accounts/${account}/subscriptions`);
  if(!Array.isArray(subscriptions)||subscriptions.length)
    throw new Error("Free account not verified. No mutation allowed.");
  if(action==="verify"){
    const scripts=await api(`/accounts/${account}/workers/scripts`);
    console.log(JSON.stringify({freeAccountVerified:true,operatorReadAccess:true,
      pilotWorkerPresent:scripts.some(s=>s.id==="bluewater-single-wallet-executor"),
      deploymentWriteAccessVerified:false,recoveryVerified:false}));
    return;
  }
  if(!directory)throw new Error("Reviewed artifact directory required.");
  const folder=resolve(directory),manifest=JSON.parse(await readFile(resolve(folder,"manifest.json"),"utf8"));
  const bytes=await readFile(resolve(folder,"executor.mjs"));
  validateOperatorArtifact(manifest,bytes,approvedHash,createHash("sha256").update(bytes).digest("hex"));
  const form=new FormData();
  form.set("metadata",JSON.stringify({
    main_module:"executor.mjs",compatibility_date:"2026-09-30",
    compatibility_flags:["nodejs_compat"],keep_bindings:["secret_text"],
    bindings:[{type:"durable_object_namespace",name:"PILOT",class_name:"PilotExecutor"}],
    exports:{PilotExecutor:{type:"durable-object",storage:"sqlite"}},
    observability:{enabled:true,logs:{enabled:true,invocation_logs:true}},
  }));
  form.set("executor.mjs",new Blob([bytes],{type:"application/javascript+module"}),"executor.mjs");
  const result=await api(`/accounts/${account}/workers/scripts/bluewater-single-wallet-executor`,{method:"PUT",body:form});
  console.log(JSON.stringify({action,uploaded:true,reviewedArtifactSha256:approvedHash,
    startupTimeMs:result.startup_time_ms??null,storagePreserved:true,
    paidPlanActivated:false,fundedExecutionAuthorized:false,
    liveVersionAndRecoveryVerificationRequired:true}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
