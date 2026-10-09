import {randomUUID,createHash} from "node:crypto";
import pg from "pg";
import type {TimedInput} from "./timed-decision-store";
import type {TimedDecision,TimedRound} from "../../shared/timed-decision";
import type {EventObservation} from "../../shared/event-lock";
import {validWaterxProbabilityPair} from "../../shared/round-decision";
import {assessV4Confirmation,V4_CONFIRMATION_STRATEGY,V4_CONFIRMATION_POLICY,
  V4_MAX_OBSERVATIONS,type V4Result} from "../../shared/confirmation-v4";
import {decisionWriterAllowed,decisionDeploymentId} from "./decision-authority";

type Client={
  query:(sql:string,values?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>;release:()=>void
};
export type V4Database={connect:()=>Promise<Client>};
type Entry={round:TimedRound;observations:EventObservation[];receipts:Map<number,string>;
  version:number;latestAtMs:number;pending:Promise<void>|null;saved:TimedDecision|null;
  lastAssessment:V4Result|null;conflict:boolean;unknownCommit:boolean;error:string|null};
const roundOf=(r:TimedInput):TimedRound=>({intervalMinutes:r.intervalMinutes,roundId:r.roundId,
  startMs:r.startMs,expiryMs:r.expiryMs});
const key=(r:TimedRound)=>[r.intervalMinutes,r.roundId,r.startMs,r.expiryMs].join(":");
const identity=(r:TimedRound)=>["sui:mainnet",V4_CONFIRMATION_STRATEGY,r.intervalMinutes,r.roundId];
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
let defaultPool:pg.Pool|undefined;
const pool=():V4Database=>{
  if(!defaultPool){
    defaultPool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,
      connectionTimeoutMillis:1200,query_timeout:1200,statement_timeout:1200,
      idleTimeoutMillis:8000,allowExitOnIdle:true,application_name:"bluewater-v4-shadow"});
    defaultPool.on("error",()=>console.warn("[v4-shadow] isolated database pool is unavailable"));
  }
  return defaultPool as unknown as V4Database;
};
const storedDecision=async(r:TimedRound,c:Client):Promise<TimedDecision|null>=>{
  const response=await c.query("SELECT decision FROM waterx_timed_decisions WHERE network=$1 AND strategy_version=$2 AND interval_minutes=$3 AND round_id=$4",identity(r));
  const d=response.rows[0]?.decision as TimedDecision|undefined;
  if(!d)return null;
  if(d.strategyVersion!==V4_CONFIRMATION_STRATEGY||d.startMs!==r.startMs||
    d.expiryMs!==r.expiryMs||d.roundId!==r.roundId)throw new Error("V4_PERSISTED_IDENTITY_MISMATCH");
  return d;
};
/** Prototype is disabled by default. No provider polling, no autonomous orders,
 * and no DB access unless explicitly enabled in a future approved deployment.
 * Its only durable writes are a prospectively qualified choice + outbox/round. */
export function createV4ConfirmationShadow(options:{
  enabled?:boolean;now?:()=>number;db?:V4Database
}={}){
  const enabled=options.enabled??process.env.WATERX_V4_SHADOW_ENABLED==="true";
  const now=options.now??Date.now;
  const entries=new Map<5|15,Entry>();
  const metrics={acceptedReceipts:0,qualifiedAttempts:0,committed:0,persistenceFailures:0,
    duplicates:0,outOfOrder:0,sourceInterruptions:0,conflicts:0,lateDecisions:0};
  const getDb=()=>options.db??pool();
  const latestIsCurrent=(e:Entry,version:number)=>entries.get(e.round.intervalMinutes)===e&&
    !e.conflict&&!e.saved&&!e.unknownCommit&&e.version===version&&
    decisionWriterAllowed()&&now()<e.round.expiryMs-30_000&&
    (e.lastAssessment?.eligible??false);
  async function commit(e:Entry,version:number,assessment:V4Result){
    if(!latestIsCurrent(e,version)||!assessment.eligible||!assessment.side)return;
    metrics.qualifiedAttempts++;
    const frozen=e.observations.map(o=>({
      receivedAtMs:o.receivedAtMs,availableAtMs:o.availableAtMs,
      probabilityUp:o.probabilityUp,probabilityDown:o.probabilityDown,healthy:o.sourceHealthy,
      provenance:o.provenance,observationId:o.id
    }));
    const evidence={policy:V4_CONFIRMATION_POLICY,shadowOnly:true,originalObservationCount:frozen.length,
      observations:frozen,evidenceDigest:digest(frozen),modelVersion:null,calibrationVersion:null,
      probabilitySource:"WATERX_MARKET_NOT_CALIBRATED",availabilityBasis:"APP_RECEIPT",
      capturedBeforeExpiry:true,decisionDeploymentId};
    const decisionAtMs=assessment.evaluatedAtMs,receipt=e.observations.at(-1)!;
    const d:TimedDecision={id:randomUUID(),network:"sui:mainnet",...e.round,
      strategyVersion:V4_CONFIRMATION_STRATEGY,status:"LOCKED",side:assessment.side,
      probabilityUp:assessment.probabilityUp,probabilityDown:1-assessment.probabilityUp!,
      observationId:receipt.id,receivedAtMs:receipt.receivedAtMs,
      decisionAtMs,elapsedMs:decisionAtMs-e.round.startMs,
      targetAtMs:decisionAtMs,hardDeadlineAtMs:e.round.expiryMs-30_000,
      lockReason:"FIRST_PROSPECTIVE_EVENT_QUALIFICATION",earlyBlocker:"CONDITIONS_SATISFIED",
      ambiguous:false,coverage:{n:frozen.length,firstAtMs:frozen[0]?.receivedAtMs??null,
        lastAtMs:receipt.receivedAtMs,maxGapMs:null},
      committedAtMs:null,workerReceivedAtMs:null,onTime:null,operationalFailure:null,
      automaticExecutionAllowed:false,evidence};
    const c=await getDb().connect();
    let began=false,commitAttempted=false;
    try{
      // Insert parent before BEGIN, with exact-round immutable identity.
      await c.query("INSERT INTO waterx_timed_rounds(network,strategy_version,interval_minutes,round_id,start_ms,expiry_ms,discovered_at_ms) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
        [...identity(e.round),e.round.startMs,e.round.expiryMs,now()]);
      await c.query("BEGIN");began=true;
      const lock=await c.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired",
        [identity(e.round).join(":")]);
      if(!lock.rows[0]?.acquired){await c.query("ROLLBACK");began=false;return;}
      const canonical=await c.query("SELECT start_ms,expiry_ms FROM waterx_timed_rounds WHERE network=$1 AND strategy_version=$2 AND interval_minutes=$3 AND round_id=$4 FOR SHARE",identity(e.round));
      if(Number(canonical.rows[0]?.start_ms)!==e.round.startMs||
        Number(canonical.rows[0]?.expiry_ms)!==e.round.expiryMs)throw new Error("V4_ROUND_IDENTITY_MISMATCH");
      const previous=await storedDecision(e.round,c);
      if(previous){e.saved=previous;await c.query("ROLLBACK");began=false;return;}
      if(!latestIsCurrent(e,version)||!assessV4Confirmation(e.round,e.observations,now()).eligible){
        await c.query("ROLLBACK");began=false;return;
      }
      await c.query("INSERT INTO waterx_timed_decisions(id,network,strategy_version,interval_minutes,round_id,decision_at_ms,status,decision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [d.id,...identity(e.round),d.decisionAtMs,d.status,JSON.stringify(d)]);
      await c.query("INSERT INTO waterx_timed_outbox(decision_id) VALUES($1)",[d.id]);
      if(!latestIsCurrent(e,version)||!assessV4Confirmation(e.round,e.observations,now()).eligible){
        await c.query("ROLLBACK");began=false;return;
      }
      commitAttempted=true;await c.query("COMMIT");began=false;
      d.committedAtMs=now();d.onTime=d.committedAtMs<=d.hardDeadlineAtMs;
      d.acknowledgementStatus="UNJOURNALED";e.saved=d;metrics.committed++;
      if(!d.onTime)metrics.lateDecisions++;
      await c.query("UPDATE waterx_timed_outbox SET committed_ack_at_ms=COALESCE(committed_ack_at_ms,$2) WHERE decision_id=$1",
        [d.id,d.committedAtMs]).then(()=>{d.acknowledgementStatus="JOURNALED";}).catch(()=>{});
    }catch(error){
      if(began)await c.query("ROLLBACK").catch(()=>{});
      if(commitAttempted){
        // An uncertain COMMIT must never generate an alternative new decision.
        try{e.saved=await storedDecision(e.round,c);}
        catch{e.unknownCommit=true;throw new Error("V4_UNKNOWN_COMMIT", {cause:error});}
        if(e.saved)return;
      }
      throw error;
    }finally{c.release();}
  }
  function observe(input:TimedInput):Promise<void>{
    if(!enabled||!decisionWriterAllowed())return Promise.resolve();
    const time=now(),r=roundOf(input),received=input.receivedAtMs;
    if(!r.roundId||!(r.intervalMinutes===5||r.intervalMinutes===15)||
      !Number.isSafeInteger(r.startMs)||!Number.isSafeInteger(r.expiryMs)||
      r.expiryMs-r.startMs!==r.intervalMinutes*60000||!Number.isSafeInteger(received)||
      received!<r.startMs||received!>=r.expiryMs||received!>time||time>=r.expiryMs)
      return Promise.resolve();
    let e=entries.get(r.intervalMinutes);
    if(e&&(r.startMs<e.round.startMs||r.startMs===e.round.startMs&&key(r)!==key(e.round))){
      metrics.outOfOrder++;return e.pending??Promise.resolve();
    }
    if(!e||key(e.round)!==key(r)){
      e={round:r,observations:[],receipts:new Map(),version:0,latestAtMs:-1,pending:null,
        saved:null,lastAssessment:null,conflict:false,unknownCommit:false,error:null};
      entries.set(r.intervalMinutes,e);
    }
    const hash=digest({received,up:input.probabilityUp,down:input.probabilityDown,
      sourceFailure:input.features?.sourceFailure??null});
    if(e.receipts.has(received!)){
      if(e.receipts.get(received!)!==hash){metrics.conflicts++;e.conflict=true;
        e.lastAssessment=null;e.observations=[];e.version++;}
      else metrics.duplicates++;
      return e.pending??Promise.resolve();
    }
    if(received!<=e.latestAtMs){metrics.outOfOrder++;return e.pending??Promise.resolve();}
    e.receipts.set(received!,hash);
    if(e.receipts.size>256)e.receipts.delete(e.receipts.keys().next().value!);
    e.latestAtMs=received!;e.version++;metrics.acceptedReceipts++;
    const healthy=!input.features?.sourceFailure&&validWaterxProbabilityPair(input.probabilityUp,input.probabilityDown);
    if(!healthy){metrics.sourceInterruptions++;e.observations=[];}
    const o:EventObservation={
      id:[r.intervalMinutes,r.roundId,received].join(":"),atMs:received!,
      receivedAtMs:received!,availableAtMs:time,databaseAcceptedAtMs:null,providerSourceAtMs:null,
      probabilityUp:healthy?input.probabilityUp!:NaN,probabilityDown:healthy?input.probabilityDown!:NaN,
      sourceHealthy:healthy,provenance:"PROSPECTIVE",
      features:healthy?{}:{sourceFailure:true}
    };
    e.observations.push(o);
    e.observations=e.observations.filter(row=>row.receivedAtMs>=time-75_000).slice(-V4_MAX_OBSERVATIONS);
    e.lastAssessment=assessV4Confirmation(r,e.observations,time);
    if(e.conflict||e.unknownCommit||e.saved||!e.lastAssessment.eligible)
      return e.pending??Promise.resolve();
    if(e.pending)return e.pending; // next fresh event may retry
    const version=e.version,assessed=e.lastAssessment;
    const job=commit(e,version,assessed).catch(error=>{
      metrics.persistenceFailures++;e!.error=error instanceof Error?error.message:"V4_DATABASE_FAILURE";
    }).finally(()=>{if(e!.pending===job)e!.pending=null;});
    e.pending=job;return job;
  }
  return {observe,enabled,read:(interval:5|15)=>entries.get(interval)??null,
    health:()=>({enabled,shadowOnly:true,executionAllowed:false,
      strategyVersion:V4_CONFIRMATION_STRATEGY,activeV3Unchanged:true,
      noAdditionalPolling:true,noPerTickDatabaseWrites:true,
      ...metrics,roundsInMemory:entries.size})};
}
export const v4ConfirmationShadow=createV4ConfirmationShadow();
