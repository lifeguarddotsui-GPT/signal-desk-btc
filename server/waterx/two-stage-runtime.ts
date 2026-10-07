import pg from "pg";
import type {TimedInput} from "./timed-decision-store";
import type {EventObservation} from "../../shared/event-lock";
import {TWO_STAGE_STRATEGY,stageRelationship,type StageInput,type StageLock,type TwoStageProjection,type StageState} from "../../shared/two-stage";
import {observationId} from "./observation-provenance";
import {validWaterxProbabilityPair} from "../../shared/round-decision";
import {decisionWriterAllowed} from "./decision-authority";
import {stageIdentity,readStageLocks,commitStage} from "./two-stage-store";
import {assessStage,accumulatedFeatures,type LearnedStagePolicy} from "./two-stage-policy";
type Db={query:pg.Pool["query"];connect:pg.Pool["connect"]};
type Entry={round:StageInput;queue:TimedInput[];version:number;observations:EventObservation[];
  early:StageState;confirmation:StageState;job:Promise<void>|null;restored:boolean;error:string|null};
const initial=():StageState=>({lock:null,persistence:"OBSERVING",reason:"BUILDING_EVIDENCE"});
const identity=(r:StageInput)=>stageIdentity(r).join(":")+`:${r.startMs}:${r.expiryMs}`;
// Dedicated SHADOW capacity: never contend for the benchmark's reserved pool.
let defaultPool:pg.Pool|undefined;
let idlePoolFailure:string|null=null;
function pool(){
  if(defaultPool)return defaultPool;
  defaultPool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,
  connectionTimeoutMillis:1000,query_timeout:1000,statement_timeout:1000,idleTimeoutMillis:10000,
  allowExitOnIdle:true,application_name:"bluewater-two-stage-shadow"});
  defaultPool.on("error",error=>{idlePoolFailure=error.message;
    console.error("Two-stage shadow connection unavailable; active strategy unchanged:",error.message);});
  return defaultPool;
}
export function createTwoStageRuntime(options:{db?:Db;now?:()=>number;policies?:()=>Partial<Record<"EARLY"|"CONFIRMATION",LearnedStagePolicy>>;
  provenance?:"PROSPECTIVE"|"SYNTHETIC"}={}){
  const now=options.now??Date.now,entries=new Map<number,Entry>();let failures=0,dropped=0,rejected=0,retryAfterMs=0;
  const db=()=>options.db??pool();
  function restoreLocks(e:Entry,locks:StageLock[]){
    for(const d of locks){
      const s=d.stage==="EARLY"?e.early:e.confirmation;s.lock=d;s.persistence="COMMITTED";s.reason="IMMUTABLE_SHADOW_LOCK";
    }
  }
  const parse=(input:TimedInput,availableAtMs:number):EventObservation=>({
    id:observationId(input.intervalMinutes,input.roundId,input.receivedAtMs!),atMs:input.receivedAtMs!,
    receivedAtMs:input.receivedAtMs!,availableAtMs,databaseAcceptedAtMs:null,providerSourceAtMs:null,
    probabilityUp:input.probabilityUp??NaN,probabilityDown:input.probabilityDown??NaN,
    sourceHealthy:!input.features?.sourceFailure&&validWaterxProbabilityPair(input.probabilityUp,input.probabilityDown),
    provenance:input.features?.synthetic===true?"SYNTHETIC":options.provenance??"PROSPECTIVE",features:{...input.features}});
  async function drain(e:Entry){
    const c=await db().connect();
    try{
      await c.query(`INSERT INTO waterx_two_stage_rounds(network,market_id,round_id,interval_minutes,strategy_version,start_ms,
        expiry_ms,discovered_at_ms,capture_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [...stageIdentity(e.round),e.round.startMs,e.round.expiryMs,now(),options.provenance??"PROSPECTIVE"]);
      restoreLocks(e,await readStageLocks(e.round,c));
      const batch=e.queue.slice(0,64),version=e.version,observations=batch.map(i=>parse(i,now()));
      await c.query(`INSERT INTO waterx_two_stage_observations(network,market_id,round_id,interval_minutes,strategy_version,
        observation_id,received_at_ms,available_at_ms,input)
        SELECT $1,$2,$3,$4,$5,v->>'id',(v->>'receivedAtMs')::bigint,(v->>'availableAtMs')::bigint,v
        FROM jsonb_array_elements($6::jsonb) v ON CONFLICT DO NOTHING`,[...stageIdentity(e.round),JSON.stringify(observations)]);
      const durableReceipts=new Set(batch.map(i=>i.receivedAtMs));
      e.queue=e.queue.filter(i=>!durableReceipts.has(i.receivedAtMs));
      // Reload the union after restart or a peer insert. Availability is never
      // backdated to the source's earlier timestamp or used for retrospective locks.
      const rows=await c.query(`SELECT input FROM waterx_two_stage_observations WHERE network=$1 AND market_id=$2
        AND round_id=$3 AND interval_minutes=$4 AND strategy_version=$5 ORDER BY received_at_ms,observation_id LIMIT 4096`,
        stageIdentity(e.round));
      e.observations=rows.rows.map(r=>r.input as EventObservation);e.restored=true;
      const current=()=>entries.get(e.round.intervalMinutes)===e&&e.version===version&&
        now()<e.round.expiryMs&&decisionWriterAllowed();
      for(const stage of ["EARLY","CONFIRMATION"] as const){
        const state=stage==="EARLY"?e.early:e.confirmation;if(state.lock)continue;
        const input={...e.round,observations:e.observations,nowMs:now()};
        const policy=options.policies?.()[stage]??null,assessment=assessStage(input,stage,e.early.lock,policy);
        state.reason=assessment.reason;
        await c.query(`INSERT INTO waterx_two_stage_assessments(network,market_id,round_id,interval_minutes,strategy_version,stage,at_ms,reason,data_failure)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(network,market_id,round_id,interval_minutes,strategy_version,stage)
          DO UPDATE SET at_ms=EXCLUDED.at_ms,reason=EXCLUDED.reason,
          data_failure=waterx_two_stage_assessments.data_failure OR EXCLUDED.data_failure`,
          [...stageIdentity(e.round),stage,now(),assessment.reason,!e.observations.at(-1)?.sourceHealthy]);
        if(!assessment.eligible||!current())continue;
        state.persistence="SAVING";
        try{
          const lock=await commitStage(input,stage,e.early.lock,policy,c,current,now);
          state.lock=lock;state.persistence=lock?"COMMITTED":"OBSERVING";
        }catch(error){
          state.persistence=(error as Error).message==="UNKNOWN_TWO_STAGE_COMMIT"?"UNKNOWN":"FAILED";throw error;
        }
      }
      e.error=null;
    }finally{c.release();}
  }
  function schedule(e:Entry){
    if(e.job)return e.job;
    if(now()<retryAfterMs)return Promise.resolve();
    e.job=drain(e).catch(error=>{
      failures++;e.error=(error as Error).message;retryAfterMs=now()+5000;
      for(const s of [e.early,e.confirmation])if(!s.lock&&s.persistence!=="UNKNOWN")s.persistence="FAILED";
    }).finally(()=>{e.job=null;if(!e.error&&e.queue.length&&entries.get(e.round.intervalMinutes)===e)void schedule(e);});
    return e.job;
  }
  function observe(input:TimedInput){
    const marketId=input.features?.marketId,at=input.receivedAtMs;
    if(typeof marketId!=="string"||!marketId||!input.roundId||![5,15].includes(input.intervalMinutes)||
      !Number.isSafeInteger(input.startMs)||!Number.isSafeInteger(at)||at!<input.startMs||at!>=input.expiryMs||
      at!>now()||now()>=input.expiryMs||input.expiryMs-input.startMs!==input.intervalMinutes*60000||
      !decisionWriterAllowed()){rejected++;return Promise.resolve();}
    const round:StageInput={intervalMinutes:input.intervalMinutes,roundId:input.roundId,startMs:input.startMs,
      expiryMs:input.expiryMs,marketId,observations:[],nowMs:now()};
    let e=entries.get(input.intervalMinutes);
    if(e&&identity(e.round)!==identity(round)&&round.startMs<=e.round.startMs){rejected++;return Promise.resolve();}
    if(!e||identity(e.round)!==identity(round)){
      e={round,queue:[],version:0,observations:[],early:initial(),confirmation:initial(),job:null,restored:false,error:null};
      entries.set(input.intervalMinutes,e);
    }
    const latest=e.queue.at(-1)?.receivedAtMs??e.observations.at(-1)?.receivedAtMs;
    if(latest!=null&&at!<=latest){rejected++;return e.job??Promise.resolve();}
    e.version++;e.queue.push(input);
    if(e.queue.length>64){e.queue.splice(0,e.queue.length-64);dropped++;
      e.queue[0]={...e.queue[0],features:{...e.queue[0].features,eventGapResetAtMs:at}};}
    return schedule(e);
  }
  function read(round:{roundId:string;startMs:number;expiryMs:number;intervalMinutes:5|15}):TwoStageProjection|null{
    const e=entries.get(round.intervalMinutes);if(!e||e.round.roundId!==round.roundId||e.round.startMs!==round.startMs||
      e.round.expiryMs!==round.expiryMs)return null;
    const input={...e.round,observations:e.observations,nowMs:now()},priceFeatures=accumulatedFeatures(input);
    const state=(stage:"EARLY"|"CONFIRMATION",s:StageState)=>({...s,reason:s.lock?s.reason:
      e.error??assessStage(input,stage,e.early.lock,options.policies?.()[stage]??null).reason});
    return {...round,marketId:e.round.marketId,strategyVersion:TWO_STAGE_STRATEGY,shadowOnly:true,automaticExecutionAllowed:false,
      early:state("EARLY",e.early),confirmation:state("CONFIRMATION",e.confirmation),
      relationship:stageRelationship(e.early.lock,e.confirmation.lock),priceFeatures,settlementRule:priceFeatures.settlementRule};
  }
  function unavailable(interval:5|15,atMs:number,reason:string){
    const e=entries.get(interval);if(!e||atMs>=e.round.expiryMs)return;
    void observe({...e.round,observedAt:new Date(atMs).toISOString(),receivedAtMs:atMs,
      probabilityUp:null,probabilityDown:null,features:{marketId:e.round.marketId,sourceFailure:reason}});
  }
  return {observe,read,unavailable,health:()=>({shadowOnly:true,failures,dropped,rejected,activeIntervals:entries.size,
    confirmationPolicy:"NOT_QUALIFIED",idlePoolFailure,lastError:Array.from(entries.values()).map(e=>e.error).filter(Boolean).at(-1)??null})};
}
export const twoStageRuntime=createTwoStageRuntime();
