// Isolated Free-tier probe only. Never prints/persists provider credentials,
// control tokens, wrapping keys, private signing keys or signed transaction bytes.
import {build} from "esbuild";
import {randomBytes,createHmac} from "node:crypto";
import {mkdir,writeFile} from "node:fs/promises";
const SCRIPT="waterx-execution-feasibility",API="https://api.cloudflare.com/client/v4";
const headers=()=>({"X-Auth-Key":process.env.CLOUDFLARE_API_KEY,"X-Auth-Email":process.env.CLOUDFLARE_EMAIL});
const control=()=>createHmac("sha256",process.env.CLOUDFLARE_API_KEY).update("execution-feasibility-control-v1").digest("hex");
async function api(path,opts={}){
  const r=await fetch(API+path,{...opts,headers:{...headers(),...opts.headers},signal:AbortSignal.timeout(45000)});
  const j=await r.json();if(!r.ok||!j.success)throw new Error(`Cloudflare API ${r.status}: ${JSON.stringify(j.errors?.map(x=>({code:x.code,message:x.message})))}`);
  return j.result;
}
const accounts=await api("/accounts?per_page=50");
if(accounts.length!==1)throw new Error("Expected one authorized account");
const id=accounts[0].id;
if((await api(`/accounts/${id}/subscriptions`)).length)throw new Error("Refusing resource mutation: verify the account plan first");
const action=process.argv[2];
const exists=(await api(`/accounts/${id}/workers/scripts`)).some(x=>x.id===SCRIPT);
const base=`/accounts/${id}/workers/scripts/${SCRIPT}`;
const out=".local/execution-feasibility";
await mkdir(out,{recursive:true});
if(action==="--deploy"||action==="--restart"){
  if(action==="--deploy"&&exists)throw new Error("Probe already exists; refusing to overwrite evidence");
  if(action==="--restart"&&!exists)throw new Error("No probe exists to restart");
  const buildId=randomBytes(12).toString("hex");
  const bundled=await build({entryPoints:["edge/execution-feasibility.ts"],bundle:true,write:false,
    format:"esm",platform:"browser",target:"es2022",external:["node:*"],define:{__PROBE_BUILD__:JSON.stringify(buildId)}});
  const form=new FormData();
  form.set("metadata",JSON.stringify({main_module:"probe.mjs",compatibility_date:"2026-09-30",
    compatibility_flags:["nodejs_compat"],keep_bindings:["secret_text"],
    bindings:[{type:"durable_object_namespace",name:"EXECUTION_PROBE",class_name:"ExecutionProbe"}],
    exports:{ExecutionProbe:{type:"durable-object",storage:"sqlite"}},
    observability:{enabled:true,head_sampling_rate:1,logs:{enabled:true,invocation_logs:true,head_sampling_rate:1}},
    annotations:{"workers/message":"31-minute isolated unfunded full-path feasibility probe; no submission capability"}}));
  // Version change forces a new isolate; stored evidence/key envelope survives.
  form.set("probe.mjs",new Blob([bundled.outputFiles[0].text+`\n// isolate version ${Date.now()}\n`],
    {type:"application/javascript+module"}),"probe.mjs");
  const uploaded=await api(base,{method:"PUT",body:form});
  if(action==="--deploy"){
    for(const [name,text] of [["PROBE_AUTH",control()],["WRAPPING_KEY_HEX",randomBytes(32).toString("hex")]])
      await api(base+"/secrets",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,text,type:"secret_text"})});
    await api(base+"/subdomain",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled:true,previews_enabled:false})});
  }
  console.log(JSON.stringify({action,script:SCRIPT,buildId,bundleBytes:bundled.outputFiles[0].contents.byteLength,
    startupTimeMs:uploaded.startup_time_ms??null,paidPlanActivated:false,submissionEnabled:false}));
} else if(action==="--telemetry"){
  const now=Date.now(),timeframe={from:now-3600000,to:now};
  const prefix=`/accounts/${id}/workers/observability/telemetry`;
  const json=body=>({method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const keys=await api(prefix+"/keys",json({timeframe}));
  const discovered=JSON.stringify(keys);
  if(!discovered.includes("$metadata.service"))throw new Error("Service filter key not discovered; refusing unscoped log query");
  const result=await api(prefix+"/query",json({queryId:"execution-feasibility-read-only",timeframe,
    view:"invocations",limit:1000,dry:true,parameters:{filters:[{key:"$metadata.service",
      operation:"eq",type:"string",value:SCRIPT}],filterCombination:"and"}}));
  // Allowlisted fields only; never export raw logs, headers or request bodies.
  const invocations=result.invocations??result.events??[];
  const groups=Array.isArray(invocations)?invocations:invocations.items??invocations.events??Object.values(invocations);
  const rows=groups.flatMap(v=>Array.isArray(v)?v:[v]);
  const evidence={checkedAt:new Date().toISOString(),timeframe,script:SCRIPT,
    responseKeys:Object.keys(result),containerType:Array.isArray(invocations)?"array":"invocation_map",
    count:rows.length,possiblyTruncated:rows.length>=1000,
    rows:rows.map(r=>({timestamp:r.timestamp,metadata:r.$metadata?
      {service:r.$metadata.service,trigger:r.$metadata.trigger,message:r.$metadata.message}:undefined,
      workers:r.$workers?{cpuTimeMs:r.$workers.cpuTimeMs,wallTimeMs:r.$workers.wallTimeMs,
        outcome:r.$workers.outcome,eventType:r.$workers.eventType,scriptName:r.$workers.scriptName}:undefined,
      cpuTimeMs:r.cpuTimeMs,wallTimeMs:r.wallTimeMs,outcome:r.outcome}))};
  await writeFile(`${out}/telemetry-${now}.json`,JSON.stringify(evidence,null,2),{mode:0o600});
  console.log(JSON.stringify(evidence,null,2));
} else {
  if(!exists)throw new Error("Probe not deployed");
  const subdomain=(await api(`/accounts/${id}/workers/subdomain`)).subdomain;
  const url=`https://${SCRIPT}.${subdomain}.workers.dev`;
  const path={"--start":"/start","--sdk":"/sdk","--codec":"/codec","--crypto":"/crypto","--report":"/report","--recovery":"/recovery","--stop":"/stop"}[action];
  if(!path)throw new Error("Choose --deploy, --start, --sdk, --restart, --recovery, --report or --stop");
  const begin=Date.now(),r=await fetch(url+path,{headers:{Authorization:`Bearer ${control()}`},signal:AbortSignal.timeout(90000)});
  const text=await r.text();let body;try{body=JSON.parse(text);}catch{body={status:r.status,error:"Non-JSON runtime response",excerpt:text.slice(0,150)};}
  const evidence={at:new Date().toISOString(),action,httpStatus:r.status,requestWallMs:Date.now()-begin,...body};
  await writeFile(`${out}/${action.slice(2)}-${begin}.json`,JSON.stringify(evidence,null,2),{mode:0o600});
  console.log(JSON.stringify(evidence,null,2));
  if(!r.ok)process.exitCode=1;
}
