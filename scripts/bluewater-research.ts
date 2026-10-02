import fs from "node:fs";
import { researchPool } from "../server/waterx/research-store";
import { runExperiment, writeDailyResearchReport } from "../server/waterx/bluewater-experiments";
import { getBluewaterReport } from "../server/waterx/bluewater-report";
import { currentChampion } from "../server/waterx/bluewater-store";

// Owner-operated development CLI, not an HTTP endpoint or agent capability.
const args=process.argv.slice(2),value=(name:string)=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
async function main(){
  if(process.env.NODE_ENV!=="development")throw new Error("Development-only command; production is forbidden.");
  const interval=Number(value("interval"));if(interval!==5&&interval!==15)throw new Error("--interval=5|15 required.");
  if(args[0]==="report"){
    await writeDailyResearchReport(researchPool,interval);
    console.log(JSON.stringify(await getBluewaterReport(interval),null,2));
  }else if(args[0]==="experiment"){
    const file=value("request");if(!file||fs.statSync(file).size>8192)throw new Error("Bounded --request=JSON-file required.");
    console.log(JSON.stringify(await runExperiment(researchPool,JSON.parse(fs.readFileSync(file,"utf8"))),null,2));
  }else if(args[0]==="approve"||args[0]==="withdraw"){
    if(!args.includes("--manual-owner-approval"))throw new Error("Explicit --manual-owner-approval required.");
    const id=value("artifact"),reason=value("reason");
    if(!id||!/^[a-f0-9]{64}$/.test(id)||!reason||reason.length<10)throw new Error("Artifact digest and substantive approval reason required.");
    const client=await researchPool.connect();
    try{
      await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(76348,$1)",[interval]);
      const report=await getBluewaterReport(interval,null,client);
      const gate=report.promotion.reports.find(r=>(r as {artifactId:string}).artifactId===id) as {eligible:boolean}|undefined;
      if(args[0]==="approve"&&(!gate?.eligible||report.schemaStatus!=="available"))throw new Error("Deterministic promotion evidence insufficient.");
      if(args[0]==="withdraw"&&(await currentChampion(client,interval))?.artifact_id!==id)throw new Error("Withdrawal must name active champion.");
      await client.query(`INSERT INTO waterx_research_champion_events
        (interval_minutes,artifact_id,event_type,approval_source,approval_reason,promotion_report)
        VALUES($1,$2,$3,'development-owner-cli',$4,$5::jsonb)`,
      [interval,id,args[0]==="approve"?"ACTIVATE":"WITHDRAW",reason,JSON.stringify(gate??{withdrawal:true})]);
      await client.query("COMMIT");console.log(JSON.stringify({status:args[0]==="approve"?"APPROVED":"WITHDRAWN",interval,artifactId:id,developmentOnly:true}));
    }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
  }else throw new Error("Use report, experiment, approve or withdraw. No deployment or execution command exists.");
}
main().catch(e=>{console.error(e instanceof Error?e.message:"Research operation rejected");process.exitCode=1;})
  .finally(()=>researchPool.end());