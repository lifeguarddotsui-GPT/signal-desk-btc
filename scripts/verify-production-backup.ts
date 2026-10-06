import pg from "pg";
import {execFileSync} from "node:child_process";
import {mkdtemp,chmod,readFile,writeFile,stat} from "node:fs/promises";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";

// READ ONLY source; credentials never enter stdout/stderr or a workspace file.
// Restore only to a new loopback-only disposable cluster in this same process.
const evidencePath=".local/evidence/round-repair-backup-restore.json";
const root=await mkdtemp(join(tmpdir(),"bluewater-private-backup-"));
await chmod(root,0o700);
const cluster=join(root,"cluster"),socket=join(root,"socket"),archive=join(root,"production.dump");
const port="5697";
let stage="verify-source",started=false,source:pg.Client|undefined,target:pg.Client|undefined;
const run=(command:string,args:string[])=>execFileSync(command,args,{stdio:"ignore",timeout:240000});
const quote=(s:string)=>`"${s.replaceAll('"','""')}"`;
async function tables(db:pg.Client){
  const {rows}=await db.query(`SELECT n.nspname AS schema,c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN('r','p')
    AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
    ORDER BY n.nspname,c.relname`);
  return rows as {schema:string;name:string}[];
}
async function inventory(db:pg.Client){
  const result:{schema:string;table:string;rows:string;rowHash:string}[]=[];
  for(const t of await tables(db)){
    const r=await db.query(`SELECT count(*)::text AS n,
      md5(coalesce(string_agg(h,'' ORDER BY h),'')) AS hash
      FROM(SELECT md5(row_to_json(x)::text) AS h FROM ${quote(t.schema)}.${quote(t.name)} x) q`);
    result.push({schema:t.schema,table:t.name,rows:r.rows[0].n,rowHash:r.rows[0].hash});
  }
  return result;
}
try{
  const expected=JSON.parse(await readFile(".local/evidence/round-repair-backup-source.json","utf8"));
  if(!process.env.PRODUCTION_BACKUP_DATABASE_URL)throw new Error("Missing private backup connection.");
  source=new pg.Client({connectionString:process.env.PRODUCTION_BACKUP_DATABASE_URL,
    connectionTimeoutMillis:10000,query_timeout:180000,options:"-c default_transaction_read_only=on"});
  await source.connect();
  await source.query("SET TIME ZONE 'UTC'");
  await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const verified=await source.query(`SELECT count(*) AS rounds,
    md5(string_agg(concat_ws('|',interval_minutes,round_id,start_ms,expiry_ms),','
      ORDER BY interval_minutes,round_id,start_ms,expiry_ms)) AS identity_hash
    FROM waterx_learning_rounds WHERE expiry_ms<=$1`,[expected.cutoff]);
  const [count,hash]=String(expected.rows).trim().split("\n").at(-1)!.split(",");
  if(String(verified.rows[0].rounds)!==count||verified.rows[0].identity_hash!==hash)
    throw new Error("Source does not match production read-only identity facts.");
  const before=await inventory(source);
  const snapshot=(await source.query("SELECT pg_export_snapshot() AS id")).rows[0].id;
  const at=new Date().toISOString();
  stage="full-export";
  run("pg_dump",["--dbname",process.env.PRODUCTION_BACKUP_DATABASE_URL,"--format=custom",
    "--no-owner","--no-privileges",`--snapshot=${snapshot}`,`--file=${archive}`]);
  await chmod(archive,0o600);
  await source.query("COMMIT");
  await source.end();source=undefined;
  stage="isolated-restore";
  run("mkdir",["-p",socket]);
  run("initdb",["-D",cluster,"-A","trust","--no-locale"]);
  run("pg_ctl",["-D",cluster,"-l",join(root,"local-postgres.log"),"-o",`-h 127.0.0.1 -k ${socket} -p ${port}`,"start"]);
  started=true;
  const user=process.env.USER??"runner";
  run("createdb",["-h",socket,"-p",port,"-U",user,"rehearsal"]);
  run("pg_restore",["-h",socket,"-p",port,"-U",user,"-d","rehearsal","--no-owner","--no-privileges",archive]);
  target=new pg.Client({host:socket,port:Number(port),user,database:"rehearsal",query_timeout:180000});
  await target.connect();await target.query("SET TIME ZONE 'UTC'");
  stage="verify-every-table";
  const after=await inventory(target);
  if(JSON.stringify(before)!==JSON.stringify(after))throw new Error("Restored inventory does not match source snapshot.");
  const bytes=await readFile(archive);
  const report={verified:true,at,source:"Verified against production read-only exact-round identity facts.",
    privateArchive:archive,archiveBytes:(await stat(archive)).size,
    archiveSha256:createHash("sha256").update(bytes).digest("hex"),
    tables:after,restore:"Complete custom-format export restored in new isolated PostgreSQL cluster; all user-table counts and row hashes match.",
    productionMutations:false,offWorkspaceRetentionConfirmed:false,
    rollback:"Code rollback does not roll back production data. Preserve this private archive externally; any real production restore requires separate approval."};
  await writeFile(evidencePath,JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify({verified:true,tables:after.length,archiveBytes:report.archiveBytes,
    archiveSha256:report.archiveSha256,evidencePath,offWorkspaceRetentionConfirmed:false}));
}catch{
  // Do not print connector/child-process errors: they can contain the URI.
  await writeFile(evidencePath,JSON.stringify({verified:false,stage,
    reason:"Backup or isolated verification failed. Private connection/process errors suppressed; production remained read-only.",
    productionMutations:false},null,2)+"\n");
  console.error(`Backup verification failed at ${stage}; private error details withheld.`);
  process.exitCode=1;
}finally{
  await source?.end().catch(()=>{});await target?.end().catch(()=>{});
  if(started)try{run("pg_ctl",["-D",cluster,"stop","-m","fast"]);}catch{}
}