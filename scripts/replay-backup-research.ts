import pg from "pg";
import {readFile,mkdtemp,writeFile,mkdir} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {runResearchTrainingDay} from "../server/waterx/research-training";

const proof=JSON.parse(await readFile(".local/evidence/round-repair-backup-restore.json","utf8"));
if(proof.verified!==true)throw new Error("Verified backup required.");
const bytes=await readFile(proof.privateArchive);
if(createHash("sha256").update(bytes).digest("hex")!==proof.archiveSha256)throw new Error("Archive integrity mismatch.");
const root=await mkdtemp(join(tmpdir(),"bluewater-offline-replay-"));
const cluster=join(root,"cluster"),socket=join(root,"socket"),port="5699";
const run=(cmd:string,args:string[])=>execFileSync(cmd,args,{stdio:"ignore",timeout:240000});
let started=false,db:pg.Client|undefined;
try{
  await mkdir(socket);
  run("initdb",["-D",cluster,"-A","trust","--no-locale"]);
  run("pg_ctl",["-D",cluster,"-l",join(root,"postgres.log"),"-o",`-h 127.0.0.1 -k ${socket} -p ${port}`,"start"]);
  started=true;
  const user=process.env.USER??"runner";
  run("createdb",["-h",socket,"-p",port,"-U",user,"replay"]);
  run("pg_restore",["-h",socket,"-p",port,"-U",user,"-d","replay","--no-owner","--no-privileges",proof.privateArchive]);
  db=new pg.Client({host:socket,port:Number(port),user,database:"replay"});await db.connect();
  // Only the disposable restored clone: retain the production archive and all
  // frozen choices. Re-evaluate today's batch without changing production jobs.
  await db.query("DELETE FROM waterx_research_daily_runs WHERE scheduled_day=CURRENT_DATE");
  await db.query("DELETE FROM waterx_research_agent_reports WHERE scheduled_day=CURRENT_DATE");
  const jobs=[];
  for(const interval of [5,15] as const)jobs.push(await runResearchTrainingDay(db,interval));
  const phases=await db.query(`SELECT interval_minutes,scheduled_day,status,dataset_count,phases,reason
    FROM waterx_research_daily_runs WHERE scheduled_day=CURRENT_DATE ORDER BY interval_minutes`);
  await writeFile(".local/evidence/round-repair-offline-daily-jobs.json",JSON.stringify({
    mode:"OFFLINE RESTORED PRODUCTION SNAPSHOT — NOT A PRODUCTION RUN OR PROSPECTIVE FORECAST",
    at:new Date().toISOString(),archiveSha256:proof.archiveSha256,jobs,phases:phases.rows,
    productionMutations:false,promoted:false},null,2)+"\n");
  console.log(JSON.stringify(jobs.map(j=>({interval:j.intervalMinutes,outcome:j.outcome,
    datasetCount:j.datasetCount,reason:j.reason})),null,2));
}finally{
  await db?.end();
  if(started)run("pg_ctl",["-D",cluster,"stop","-m","fast"]);
}
process.exit(0);