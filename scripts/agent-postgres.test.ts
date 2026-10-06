import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { readFileSync } from "node:fs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { defaultAgentPolicy } from "../shared/agent-policy";
const url=process.env.AGENT_TEST_DATABASE_URL;
const safe=(()=>{try{const u=new URL(url!);return ["127.0.0.1","localhost"].includes(u.hostname)&&u.pathname==="/bluewater_agent_test";}catch{return false;}})();
test("isolated Agent PostgreSQL: wallet signatures, replay/CSRF/isolation, versioning, pause, targets, append-only, duplicate worker",{
  skip:safe?false:"Explicit disposable loopback bluewater_agent_test database required",
},async()=>{
  process.env.NODE_ENV="development";process.env.DATABASE_URL=url;
  const db=new pg.Client({connectionString:url});await db.connect();
  await db.query(readFileSync("migrations/bluewater-agent-development.sql","utf8"));
  await db.query(readFileSync("migrations/bluewater-agent-development.sql","utf8"));
  await db.query(readFileSync("migrations/agent-durable-auth.sql","utf8"));
  const controlBefore=(await db.query("SELECT singleton,disabled FROM bluewater_agent_execution_control")).rows;
  await db.query(readFileSync("migrations/bluewater-agent-control-check-development.sql","utf8"));
  await db.query(readFileSync("migrations/bluewater-agent-control-check-development.sql","utf8"));
  assert.deepEqual((await db.query("SELECT singleton,disabled FROM bluewater_agent_execution_control")).rows,controlBefore);
  const predicate=(await db.query(`SELECT pg_get_expr(conbin,conrelid) AS expression FROM pg_constraint
    WHERE conrelid='bluewater_agent_execution_control'::regclass AND contype='c'`)).rows[0].expression;
  assert.match(predicate,/singleton IS TRUE/);
  await assert.rejects(db.query("INSERT INTO bluewater_agent_execution_control(singleton) VALUES(false)"),
    (e:{code?:string})=>e.code==="23514");
  await assert.rejects(db.query("INSERT INTO bluewater_agent_execution_control(singleton) VALUES(NULL)"),
    (e:{code?:string})=>e.code==="23502");
  await assert.rejects(db.query("INSERT INTO bluewater_agent_execution_control(singleton) VALUES(true)"),
    (e:{code?:string})=>e.code==="23505");
  await db.query(`CREATE TABLE waterx_research_choices(interval_minutes int,round_id text,start_ms bigint,expiry_ms bigint,
    decision_at_ms bigint,side text,probability_up numeric,state text)`);
  // This auth/owner-isolation fixture has no adaptive candidates. Create the
  // empty FK parent for the real receipt migration, not the research pipeline.
  await db.query(`CREATE TABLE bluewater_lock_candidates(interval_minutes smallint,round_id text,
    checkpoint_seconds smallint,PRIMARY KEY(interval_minutes,round_id,checkpoint_seconds))`);
  for(const file of ["bluewater-early-outbox.sql","waterx-timed-decisions.sql"])
    await db.query(readFileSync(`migrations/${file}`,"utf8"));
  const {createApp}=await import("../server/index");
  const {agentPool}=await import("../server/agent/store");
  const {shadowWorkerTick}=await import("../server/agent/worker");
  const server=createApp().listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
  const site=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const call=async(path:string,body?:unknown,cookie="",origin=site)=>{
    const r=await fetch(`${site}/api/agent${path}`,{method:body===undefined?"GET":"POST",
      headers:{Origin:origin,...(body!==undefined?{"Content-Type":"application/json"}:{}),...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,body:await r.json(),cookie:r.headers.get("set-cookie")?.split(";")[0]??""};
  };
  const login=async(k:Ed25519Keypair)=>{
    const ch=await call("/challenge",{address:k.toSuiAddress(),chain:"sui:mainnet"});assert.equal(ch.status,200);
    const signed=await k.signPersonalMessage(new TextEncoder().encode(ch.body.message));
    const r=await call("/auth",{message:ch.body.message,signature:signed.signature,chain:"sui:mainnet"});assert.equal(r.status,200);assert.ok(r.cookie);
    assert.equal((await call("/auth",{message:ch.body.message,signature:signed.signature,chain:"sui:mainnet"})).status,400);
    return r;
  };
  try{
    const a=Ed25519Keypair.generate(),b=Ed25519Keypair.generate();
    assert.equal((await call("/state")).status,401);
    assert.equal((await call("/challenge",{address:a.toSuiAddress(),chain:"sui:testnet"})).status,400);
    assert.equal((await call("/challenge",{address:a.toSuiAddress()},"","https://evil.invalid")).status,403);
    const ac=await login(a),bc=await login(b);
    assert.equal(ac.body.network,"mainnet");assert.equal(ac.body.mainnetEnabled,false);
    assert.ok(ac.body.walletSessionExpiresAtMs>Date.now());
    assert.ok(ac.body.walletSessionExpiresAtMs<=Date.now()+15*60000);
    const wrongOwner=await call("/challenge",{address:a.toSuiAddress(),chain:"sui:mainnet"});
    const wrongSignature=await b.signPersonalMessage(new TextEncoder().encode(wrongOwner.body.message));
    assert.equal((await call("/auth",{message:wrongOwner.body.message,signature:wrongSignature.signature,chain:"sui:mainnet"})).status,400);
    assert.equal((await call("/delegate",{},ac.cookie)).status,409);
    const policy={...defaultAgentPolicy,frequency:"EVERY_ELIGIBLE_ROUND",edgeEnabled:false,dailyTurnoverCents:500,reserveCents:0,targetCents:5000};
    assert.equal((await call("/policy",{policy:{...policy,dailyTurnoverCents:null}},ac.cookie)).status,400);
    const saved=await call("/policy",{owner:b.toSuiAddress(),policy,acknowledged:true},ac.cookie);assert.equal(saved.status,200);assert.equal(saved.body.owner,a.toSuiAddress());assert.equal(saved.body.policyVersion,2);
    assert.equal((await call("/state",undefined,bc.cookie)).body.policyVersion,1);
    assert.equal((await call("/policy",{policy:{...policy,privateKey:"not allowed"}},ac.cookie)).status,400);
    assert.equal((await call("/control",{action:"ARM_SHADOW",paperCapitalCents:1000,acknowledged:true},ac.cookie)).status,400);
    const armed=await call("/control",{action:"ARM_SHADOW",paperCapitalCents:1000,acknowledged:true,edgeOffConfirmed:true,zeroReserveConfirmed:true},ac.cookie);
    assert.equal(armed.status,200);assert.equal(armed.body.status,"SHADOW");assert.equal(armed.body.paper.availableCents,1000);
    assert.equal((await call("/control",{action:"LIVE",acknowledged:true},ac.cookie)).status,400);
    const now=Date.now();
    await db.query("INSERT INTO waterx_research_choices VALUES(5,'isolated-fixture',$1,$2,$3,'UP',.7,'FROZEN')",[now-240000,now+60000,now]);
    await shadowWorkerTick();await shadowWorkerTick();
    const seen=await call("/state",undefined,ac.cookie);
    assert.equal(seen.body.ledger.filter((r:{event:string})=>r.event==="EXECUTION_CANDIDATE").length,1);
    assert.equal(seen.body.ledger.filter((r:{event:string})=>r.event==="WOULD_HOLD").length,1);
    assert.equal(seen.body.paper.availableCents,1000);assert.equal(seen.body.paper.turnoverCents,0);
    assert.equal((await call("/state",undefined,bc.cookie)).body.ledger.length,0);
    assert.equal((await call("/control",{action:"PAUSE"},ac.cookie)).body.status,"PAUSED");
    const previous=await db.query("SELECT count(*)::int AS n FROM bluewater_agent_ledger WHERE owner=$1",[a.toSuiAddress()]);
    await shadowWorkerTick();assert.equal((await db.query("SELECT count(*)::int AS n FROM bluewater_agent_ledger WHERE owner=$1",[a.toSuiAddress()])).rows[0].n,previous.rows[0].n);
    for(const table of ["bluewater_agent_policies","bluewater_agent_ledger"]){
      await assert.rejects(db.query(`UPDATE ${table} SET owner=owner`),/append-only/);
      await assert.rejects(db.query(`DELETE FROM ${table}`),/append-only/);
    }
    assert.equal((await call("/control",{action:"STOP_GOAL"},ac.cookie)).status,200);
    assert.equal((await call("/policy",{policy:{...defaultAgentPolicy,targetCents:1000},acknowledged:true},ac.cookie)).status,200);
    assert.equal((await call("/control",{action:"ARM_SHADOW",paperCapitalCents:1000,acknowledged:true},ac.cookie)).status,200);
    await shadowWorkerTick();
    const reached=await call("/state",undefined,ac.cookie);assert.equal(reached.body.status,"TARGET_REACHED");
    assert.ok(reached.body.ledger.some((r:{event:string})=>r.event==="GOAL_CANCELLED"));
    assert.equal((await call("/logout",{},ac.cookie)).status,200);assert.equal((await call("/state",undefined,ac.cookie)).status,401);
    assert.equal((await call("/state",undefined,bc.cookie)).status,200);
    const serial=JSON.stringify(reached.body);assert.doesNotMatch(serial,/privateKey|secretKey|seedPhrase|token_hash/);
  }finally{await new Promise<void>(r=>server.close(()=>r()));await agentPool.end();await db.end();}
});