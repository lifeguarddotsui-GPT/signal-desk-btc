import test from "node:test";
import assert from "node:assert/strict";
import {assessV4Confirmation,V4_CONFIRMATION_STRATEGY} from "../shared/confirmation-v4";
import type {EventObservation} from "../shared/event-lock";
import type {TimedInput} from "../server/waterx/timed-decision-store";
import {createV4ConfirmationShadow,type V4Database} from "../server/waterx/confirmation-v4-shadow";
import {v4Comparison} from "../server/waterx/confirmation-v4-compare";
const points=(interval:5|15)=>interval===5?[50000,56000,62000,68000,74000]:
  [191000,200000,209000,218000,227000,232000,236000];
const round=(interval:5|15)=>({intervalMinutes:interval,roundId:"v4-test-"+interval,
  startMs:0,expiryMs:interval*60000});
const observation=(at:number,prob=.8):EventObservation=>({
  id:String(at),atMs:at,receivedAtMs:at,availableAtMs:at+100,databaseAcceptedAtMs:null,
  providerSourceAtMs:null,probabilityUp:prob,probabilityDown:1-prob,sourceHealthy:true,
  provenance:"PROSPECTIVE",features:{decisionClockDomain:"test-process"}
});
const input=(interval:5|15,at:number,prob=.8):TimedInput=>({
  ...round(interval),observedAt:new Date(at).toISOString(),
  receivedAtMs:at,probabilityUp:prob,probabilityDown:1-prob,
  features:{decisionClockDomain:"test-process"}
});
class FakeDb {
  calls=0;stored:unknown=null;parent:{start_ms:number;expiry_ms:number}|null=null;
  pending:unknown=null;commits=0;rollbacks=0;locks=0;
  async connect(){
    return {query:async(sql:string,params?:unknown[])=>{
      this.calls++;
      if(sql.startsWith("INSERT INTO waterx_timed_rounds")){
        this.parent={start_ms:Number(params?.[4]),expiry_ms:Number(params?.[5])};
        return {rows:[]};
      }
      if(sql==="BEGIN")return {rows:[]};
      if(sql.startsWith("SELECT pg_try_advisory")){this.locks++;return {rows:[{acquired:true}]};}
      if(sql.startsWith("SELECT start_ms,expiry_ms"))return {rows:this.parent?[this.parent]:[]};
      if(sql.startsWith("SELECT decision FROM"))return {rows:this.stored?[{decision:this.stored}]:[]};
      if(sql.startsWith("INSERT INTO waterx_timed_decisions")){
        this.pending=JSON.parse(String(params?.[7]));return {rows:[]};
      }
      if(sql.startsWith("INSERT INTO waterx_timed_outbox"))return {rows:[]};
      if(sql==="COMMIT"){this.stored=this.pending;this.pending=null;this.commits++;return {rows:[]};}
      if(sql==="ROLLBACK"){this.pending=null;this.rollbacks++;return {rows:[]};}
      if(sql.startsWith("UPDATE waterx_timed_outbox"))return {rows:[]};
      throw new Error("Unrecognised query in fake DB");
    },release:()=>{}};
  }
}
test("V4 requires prospective, available, fresh receipts and V3-strength stability on both markets",()=>{
  for(const interval of [5,15] as const){
    const r=round(interval),p=points(interval),rows=p.map(at=>observation(at));
    const success=assessV4Confirmation(r,rows,p.at(-1)!+100);
    assert.equal(success.eligible,true);
    assert.equal(success.side,"UP");
    assert.equal(success.automaticExecutionAllowed,false);
    assert.equal(success.shadowOnly,true);
    assert.equal(assessV4Confirmation(r,rows,p.at(-1)!+11001).eligible,false);
    assert.equal(assessV4Confirmation(r,rows.map(o=>({...o,provenance:"SYNTHETIC"})),p.at(-1)!+100).eligible,false);
    assert.equal(assessV4Confirmation(r,rows.map(o=>({...o,availableAtMs:p.at(-1)!+1000})),p.at(-1)!+100).eligible,false);
    assert.equal(assessV4Confirmation(r,[...rows,rows.at(-1)!],p.at(-1)!+100).eligible,false);
    assert.equal(assessV4Confirmation(r,[...rows,{...observation(p.at(-1)!+1000,.2)}],p.at(-1)!+1100).eligible,false);
    assert.equal(assessV4Confirmation(r,[...rows,{...observation(p.at(-1)!+1000),sourceHealthy:false}],p.at(-1)!+1100).eligible,false);
    assert.equal(assessV4Confirmation(r,rows,r.expiryMs-10000).blocker,"RESEARCH_ENTRY_WINDOW_CLOSED");
    assert.equal(assessV4Confirmation(r,[],p.at(-1)!+100).blocker,"NO_PROSPECTIVE_OBSERVATIONS");
  }
});
test("V4 disabled by default creates no DB calls, timers, orders or durable history",async()=>{
  const db=new FakeDb();let at=100000;
  const runtime=createV4ConfirmationShadow({enabled:false,now:()=>at,db:db as unknown as V4Database});
  for(const t of points(5)){at=t+100;await runtime.observe(input(5,t));}
  assert.equal(db.calls,0);assert.equal(runtime.health().enabled,false);
  assert.equal(runtime.health().noAdditionalPolling,true);
});
test("V4 saves one atomic qualified prospective decision/outbox per round on 5m and 15m",async()=>{
  for(const interval of [5,15] as const){
    const db=new FakeDb();let at=100;
    const runtime=createV4ConfirmationShadow({enabled:true,now:()=>at,db:db as unknown as V4Database});
    const times=points(interval);
    for(const t of times){at=t+100;await runtime.observe(input(interval,t));}
    assert.equal(db.commits,1);assert.equal(db.rollbacks,0);
    const saved=db.stored as {strategyVersion:string;status:string;automaticExecutionAllowed:boolean;
      evidence:{shadowOnly:boolean;observations:{receivedAtMs:number}[];clockDomain:string}};
    assert.equal(saved.strategyVersion,V4_CONFIRMATION_STRATEGY);
    assert.equal(saved.status,"LOCKED");assert.equal(saved.automaticExecutionAllowed,false);
    assert.equal(saved.evidence.shadowOnly,true);assert.equal(saved.evidence.clockDomain,"test-process");
    assert.equal(saved.evidence.observations.at(-1)?.receivedAtMs,times.at(-1));
    at+=1;await runtime.observe(input(interval,times.at(-1)!));
    assert.equal(db.commits,1);assert.equal(runtime.health().duplicates,1);
    assert.equal(runtime.health().committed,1);
  }
});
test("Outage invalidates evidence and late/reversed/duplicate conflict never fabricates a V4 lock",async()=>{
  const db=new FakeDb();let at=100;
  const r=createV4ConfirmationShadow({enabled:true,now:()=>at,db:db as unknown as V4Database});
  const times=points(5);
  for(let i=0;i<3;i++){at=times[i]+100;await r.observe(input(5,times[i]));}
  at=times[3]+100;
  await r.observe({...input(5,times[3]),probabilityUp:null,probabilityDown:null,
    features:{sourceFailure:{reason:"network outage"}}});
  at=times[4]+100;await r.observe(input(5,times[4]));
  assert.equal(db.commits,0);
  assert.equal(r.health().sourceInterruptions,1);
  at+=500;await r.observe(input(5,times[4]-1));assert.equal(r.health().outOfOrder,1);
  await r.observe({...input(5,times[4]),probabilityUp:.21,probabilityDown:.79});
  assert.equal(r.health().conflicts,1);assert.equal(db.commits,0);
});
test("V3/V4 comparison reports verified accuracy and locks separately; no retrospective scoring",async()=>{
  const example={round_id:"one",interval_minutes:5,start_ms:0,expiry_ms:300000,verified:true,outcome:"UP",
    v3:{status:"LOCKED",side:"DOWN",decisionAtMs:90000,evidence:{features:{decisionClockDomain:"same"}}},
    v4:{status:"LOCKED",side:"UP",decisionAtMs:76000,evidence:{clockDomain:"same"}}};
  const mock={query:async()=>({rows:[example,{...example,round_id:"two",verified:false,v3:null,v4:null}]})};
  const report=await v4Comparison({interval:"5",window:"24h"},300001,mock);
  assert.equal(report.status,"OK");
  if(report.status!=="OK")throw Error("Unexpected report");
  assert.equal(report.v4.locks,1);assert.equal(report.v4.scoredN,1);assert.equal(report.v4.correct,1);
  assert.equal(report.v4.noSavedLock,1);assert.equal(report.v3.incorrect,1);
  assert.equal(report.paired.v4OnlyCorrect,1);
  assert.equal(report.paired.v4LeadGainSecondsP50,14);
  assert.equal(report.readyForProduction,false);
});
