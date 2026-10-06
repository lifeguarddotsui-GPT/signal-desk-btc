// Best-effort workspace watcher; the Cloudflare alarm owns the actual cutoff.
// This never restarts a stopped probe, submits transactions or enables billing.
import {readdir,readFile,writeFile} from "node:fs/promises";
import {execFile as exec} from "node:child_process";
import {promisify} from "node:util";
import {setTimeout as sleep} from "node:timers/promises";
const execFile=promisify(exec),dir=".local/execution-feasibility";
const names=(await readdir(dir)).filter(n=>/^start-\d+\.json$/.test(n)).sort();
if(names.length!==1)throw new Error("Expected exactly one bounded-pass start receipt");
const start=JSON.parse(await readFile(`${dir}/${names[0]}`,"utf8"));
if(!Number.isSafeInteger(start.stopMs)||start.stopMs-start.startMs!==31*60000)
  throw new Error("Invalid bounded trial receipt");
console.log(`Waiting until ${new Date(start.stopMs+20000).toISOString()} for automatic cutoff.`);
await sleep(Math.max(0,start.stopMs+20000-Date.now()));
for(const [name,args] of [
  ["final-runtime",["scripts/cloudflare-execution-feasibility.mjs","--report"]],
  ["final-analytics",["scripts/cloudflare-waterx-metrics.mjs","--execution-probe",
    "--from",new Date(start.startMs).toISOString(),"--to",new Date(start.stopMs).toISOString()]],
  ["final-invocations",["scripts/cloudflare-execution-feasibility.mjs","--telemetry"]],
]){
  try {
    const {stdout}=await execFile(process.execPath,args,{timeout:180000,maxBuffer:16000000});
    await writeFile(`${dir}/${name}.json`,stdout,{mode:0o600});
    console.log(`${name} evidence saved.`);
  }catch(e){console.log(`${name} unavailable (${e.code??e.name}); do not infer zero usage.`);}
}
console.log("BOUNDED_EXECUTION_FEASIBILITY_WINDOW_FINISHED");
