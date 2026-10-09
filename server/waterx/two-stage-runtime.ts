import pg from "pg";
import type {TimedInput} from "./timed-decision-store";
import type {EventObservation} from "../../shared/event-lock";
import {TWO_STAGE_STRATEGY,stageRelationship,type StageInput,type StageLock,type TwoStageProjection,type StageState} from "../../shared/two-stage";
import {observationId} from "./observation-provenance";
import {validWaterxProbabilityPair} from "../../shared/round-decision";
import {decisionWriterAllowed,decisionDeploymentId} from "./decision-authority";
import {stageIdentity,readStageLocks,commitStage,candidateStillValid} from "./two-stage-store";
import {assessStage,accumulatedFeatures,type LearnedStagePolicy} from "./two-stage-policy";
import {researchPreference} from "./early-policy";
import {stagePolicyRegistry} from "./two-stage-registry";
import type {PricePoint} from "../../shared/price-area";
import type {ResearchPreference} from "../../shared/two-stage";
import {canonicalWaterxRoundKey} from "../../shared/waterx-round-identity";
type Db={query:pg.Pool["query"];connect:pg.Pool["connect"]};
type Entry={round:StageInput;queue:TimedInput[];version:number;observations:EventObservation[];
  early:StageState;confirmation:StageState;job:Promise<void>|null;restored:boolean;error:string|null;
  prices:Map<string,PricePoint>;priceQueue:Map<string,PricePoint>;lastReloadMs:number;lastReceiptMs:number;
  receivedAtMs:number;acceptedAtMs:number;acquisitionStartedAtMs:number|null;acquiredAtMs:number|null;
  candidates:Map<"EARLY"|"CONFIRMATION",StageInput>;deadlineRecorded:boolean};
const initial=():StageState=>({lock:null,persistence:"OBSERVING",reason:"BUILDING_EVIDENCE"});
const identity=(r:StageInput)=>`${r.marketId}:${canonicalWaterxRoundKey(r)}`;
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
export function createTwoStageRuntime(options:{db?:Db;now?:()=>number;policies?:(interval:5|15)=>Partial<Record<"EARLY"|"CONFIRMATION",LearnedStagePolicy>>;
  preference?:ResearchPreference;earlyPolicyVersion?:string;provenance?:"PROSPECTIVE"|"SYNTHETIC"}={}){
  const now=options.now??Date.now,entries=new Map<number,Entry>();let failures=0,dropped=0,rejected=0,retryAfterMs=0;
  const retired=new Map<string,Entry>();
  const rawPrices=new Map<string,PricePoint>();let priceRejected=0,priceArchiveFailures=0,optionalFailures=0;
  let priceStreamTicks=0,lastStreamSourceAt:number|null=null,lastCapturedSourceAt:number|null=null;
  const sourceCadence:number[]=[],receiptLatency:number[]=[];
  const restoreJobs=new Map<string,Promise<void>>();
  const restoreRetry=new Map<string,number>();
  const newEntry=(round:StageInput):Entry=>({round,queue:[],version:0,observations:[],
    early:initial(),confirmation:initial(),job:null,restored:false,error:null,prices:new Map(),priceQueue:new Map(),
    lastReceiptMs:-1,lastReloadMs:0,receivedAtMs:now(),acceptedAtMs:now(),
    acquisitionStartedAtMs:null,acquiredAtMs:null,candidates:new Map(),deadlineRecorded:false});
  const policyFor=(input:StageInput,stage:"EARLY"|"CONFIRMATION")=>options.policies?
    options.policies(input.intervalMinutes)[stage]??null:
      stage==="CONFIRMATION"?stagePolicyRegistry.policy(input,stage):null;
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
     provenance:input.features?.synthetic===true?"SYNTHETIC":options.provenance??"PROSPECTIVE",
     features:{...input.features,...(!validWaterxProbabilityPair(input.probabilityUp,input.probabilityDown)&&
       !input.features?.sourceFailure?{sourceFailure:"INVALID_OR_UNAVAILABLE_PROBABILITY_PAIR"}:{})}});
  function attachPrices(e:Entry){
    const latest=e.observations.at(-1);
    if(typeof latest?.features.reference!=="number")return;
    for(const p of Array.from(rawPrices.values()))if(p.atMs>=e.round.startMs&&p.atMs<e.round.expiryMs&&
      p.availableAtMs<=now()&&!e.prices.has(p.id)){
      const bound={...p,reference:latest.features.reference,
        availableAtMs:Math.max(p.availableAtMs,latest.availableAtMs)};
      e.prices.set(p.id,bound);e.priceQueue.set(p.id,bound);
    }
  }
  const frame=(e:Entry):StageInput=>({...e.round,observations:e.observations.slice(),
    priceObservations:Array.from(e.prices.values()).sort((a,b)=>a.atMs-b.atMs),nowMs:now()});
  function freezeCandidates(e:Entry){
    const observations=new Map(e.observations.map(o=>[o.id,o]));
    for(const i of e.queue){const o=parse(i,Number(i.features?.shadowAcceptedAtMs??now()));observations.set(o.id,o);}
    const input={...frame(e),observations:Array.from(observations.values()).sort((a,b)=>a.receivedAtMs-b.receivedAtMs)};
    for(const stage of ["EARLY","CONFIRMATION"] as const){
      const state=stage==="EARLY"?e.early:e.confirmation;if(state.lock)continue;
      const policy=policyFor(input,stage),assessment=assessStage(input,stage,e.early.lock,policy);
      const existing=e.candidates.get(stage);
      if(existing){
        const old=assessStage(existing,stage,e.early.lock,policy),last=input.observations.at(-1);
         if(!last||!assessment.eligible||assessment.side!==old.side||
           now()-existing.observations.at(-1)!.receivedAtMs>5000||
          !candidateStillValid(existing,last,now()))e.candidates.delete(stage);
      }
      if(!e.candidates.has(stage)&&assessment.eligible){
        e.candidates.set(stage,input);state.persistence="SAVING";state.reason=assessment.reason;
        state.diagnostics=assessment.diagnostics;
        const latest=input.observations.at(-1)!;
        state.timing={receivedAtMs:latest.receivedAtMs,acceptedAtMs:latest.availableAtMs,
          qualifiedAtMs:input.nowMs,acquisitionStartedAtMs:null,acquiredAtMs:null,
          commitAcknowledgedAtMs:null,projectionAtMs:null};
      }
    }
  }
  async function drain(e:Entry){
    e.acquisitionStartedAtMs=now();
    const c=await db().connect();
    e.acquiredAtMs=now();
    try{
      await c.query(`INSERT INTO waterx_two_stage_rounds(network,market_id,round_id,interval_minutes,strategy_version,start_ms,
         expiry_ms,discovered_at_ms,capture_mode,capture_build_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
         [...stageIdentity(e.round),e.round.startMs,e.round.expiryMs,e.round.nowMs,options.provenance??"PROSPECTIVE",
           decisionDeploymentId]);
       const restore=!e.restored;restoreLocks(e,await readStageLocks(e.round,c));
       for(const [stage,state] of [["EARLY",e.early],["CONFIRMATION",e.confirmation]] as const)
         if(!state.lock)state.persistence=e.candidates.has(stage)?"SAVING":"OBSERVING";
       const batch=e.queue.slice(0,64),observations=batch.map(i=>parse(i,
         typeof i.features?.shadowAcceptedAtMs==="number"?i.features.shadowAcceptedAtMs:now()));
       for(const o of observations)o.features={...o.features,shadowAcquisitionStartedAtMs:e.acquisitionStartedAtMs,
         shadowAcquiredAtMs:e.acquiredAtMs};
      await c.query(`INSERT INTO waterx_two_stage_observations(network,market_id,round_id,interval_minutes,strategy_version,
        observation_id,received_at_ms,available_at_ms,input)
        SELECT $1,$2,$3,$4,$5,v->>'id',(v->>'receivedAtMs')::bigint,(v->>'availableAtMs')::bigint,v
        FROM jsonb_array_elements($6::jsonb) v ON CONFLICT DO NOTHING`,[...stageIdentity(e.round),JSON.stringify(observations)]);
      const durableReceipts=new Set(batch.map(i=>i.receivedAtMs));
      e.queue=e.queue.filter(i=>!durableReceipts.has(i.receivedAtMs));
      // Reload the union after restart or a peer insert. Availability is never
      // backdated to the source's earlier timestamp or used for retrospective locks.
       const rows=await c.query(`SELECT input FROM waterx_two_stage_observations WHERE network=$1 AND market_id=$2
         AND round_id=$3 AND interval_minutes=$4 AND strategy_version=$5 AND received_at_ms>$6
         ORDER BY received_at_ms,observation_id LIMIT 4096`,
         [...stageIdentity(e.round),restore?-1:e.lastReceiptMs]);
       const union=new Map(e.observations.map(o=>[o.id,o]));
       for(const r of rows.rows){const o=r.input as EventObservation;union.set(o.id,o);}
       e.observations=Array.from(union.values()).sort((a,b)=>a.receivedAtMs-b.receivedAtMs);
       e.lastReceiptMs=e.observations.at(-1)?.receivedAtMs??e.lastReceiptMs;
       e.lastReloadMs=now();
       if(restore){
         const prices=await c.query(`SELECT point FROM waterx_two_stage_prices WHERE network=$1 AND market_id=$2
           AND round_id=$3 AND interval_minutes=$4 AND strategy_version=$5 ORDER BY source_at_ms LIMIT 25000`,stageIdentity(e.round));
         for(const row of prices.rows){const p=row.point as PricePoint;e.prices.set(p.id,p);}
       }
       e.restored=true;attachPrices(e);
      for(const stage of ["EARLY","CONFIRMATION"] as const){
        const state=stage==="EARLY"?e.early:e.confirmation;if(state.lock)continue;
         const candidate=e.candidates.get(stage);
         const durable=new Map(e.observations.map(o=>[o.id,o]));
         if(candidate&&candidate.observations.some(o=>!durable.has(o.id)))continue;
         const input=candidate?{...candidate,observations:candidate.observations.map(o=>durable.get(o.id)!)}:frame(e);
         const policy=policyFor(input,stage),assessment=assessStage(input,stage,e.early.lock,policy);
         const current=()=>{
           if(entries.get(e.round.intervalMinutes)!==e||now()>=e.round.expiryMs||!decisionWriterAllowed())return false;
           const pending=e.queue.filter(o=>o.receivedAtMs!>input.observations.at(-1)!.receivedAtMs);
           const parsed=pending.map(o=>parse(o,
             typeof o.features?.shadowAcceptedAtMs==="number"?o.features.shadowAcceptedAtMs:now()));
           if(parsed.some(o=>!candidateStillValid(input,o,now())||
             o.features.reference!==input.observations.at(-1)!.features.reference))return false;
           const latest=parsed.at(-1)??e.observations.at(-1)!;
           if(latest?.features.reference!==input.observations.at(-1)?.features.reference)return false;
           return candidateStillValid(input,latest,now());
         };
         const priorReason=state.reason;
         state.reason=assessment.reason;
         if(now()>=e.round.expiryMs&&!state.lock){
           state.reason=/POLICY_NOT_QUALIFIED/.test(priorReason)?"ABSTAINED_CONFIRMATION_POLICY_NOT_QUALIFIED":
             e.error?"MISSED_DEADLINE_DATABASE_FAILURE":
             !e.observations.at(-1)?.sourceHealthy?"NO_VALID_INPUT":
             e.round.expiryMs-e.observations.at(-1)!.receivedAtMs>5000?"SOURCE_STALE":
             /BELOW_POLICY|PERSISTENCE_INCOMPLETE|STABILITY_WINDOW|SEPARATION|ADDITIONAL_EVIDENCE|ABSTAINED|NO_QUALIFYING|CALIBRATED_DIRECTION_CONFLICT/.test(priorReason)?
               priorReason.startsWith("ABSTAINED_")?priorReason:`ABSTAINED_${priorReason}`:"MISSED_DEADLINE_NO_QUALIFIED_LOCK";
         }
         state.diagnostics=assessment.diagnostics;
         if(!assessment.eligible||!current()){e.candidates.delete(stage);state.persistence="OBSERVING";continue;}
        state.persistence="SAVING";
          const frozenReceipt=input.observations.at(-1)!;
          state.timing={receivedAtMs:frozenReceipt.receivedAtMs,acceptedAtMs:frozenReceipt.availableAtMs,qualifiedAtMs:input.nowMs,
           acquisitionStartedAtMs:e.acquisitionStartedAtMs,acquiredAtMs:e.acquiredAtMs,
           commitAcknowledgedAtMs:null,projectionAtMs:null};
        try{
          const lock=await commitStage(input,stage,e.early.lock,policy,c,current,now);
           state.lock=lock;state.persistence=lock?"COMMITTED":"SAVING";
           if(lock)e.candidates.delete(stage);
        }catch(error){
          state.persistence=(error as Error).message==="UNKNOWN_TWO_STAGE_COMMIT"?"UNKNOWN":"FAILED";throw error;
        }
      }
       // Optional diagnostics and continuous price archival are outside the lock
       // transaction. Their failures cannot undo a durably committed prediction.
       let assessmentsSaved=true;
       for(const stage of ["EARLY","CONFIRMATION"] as const){
         const state=stage==="EARLY"?e.early:e.confirmation;
         await c.query(`INSERT INTO waterx_two_stage_assessments(network,market_id,round_id,interval_minutes,strategy_version,stage,at_ms,reason,data_failure)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(network,market_id,round_id,interval_minutes,strategy_version,stage)
           DO UPDATE SET at_ms=EXCLUDED.at_ms,reason=EXCLUDED.reason,
           data_failure=waterx_two_stage_assessments.data_failure OR EXCLUDED.data_failure`,
           [...stageIdentity(e.round),stage,now(),state.reason,!e.observations.at(-1)?.sourceHealthy])
           .catch(()=>{optionalFailures++;assessmentsSaved=false;});
       }
       if(now()>=e.round.expiryMs&&assessmentsSaved)e.deadlineRecorded=true;
       if(e.deadlineRecorded)retired.delete(identity(e.round));
       const priceBatch=Array.from(e.priceQueue.values()).slice(0,1000);
       if(priceBatch.length)try{
         await c.query(`INSERT INTO waterx_two_stage_prices(network,market_id,round_id,interval_minutes,strategy_version,
           point_id,source_at_ms,available_at_ms,point) SELECT $1,$2,$3,$4,$5,p->>'id',
           (p->>'atMs')::bigint,(p->>'availableAtMs')::bigint,p FROM jsonb_array_elements($6::jsonb) p
           ON CONFLICT DO NOTHING`,[...stageIdentity(e.round),JSON.stringify(priceBatch)]);
         for(const p of priceBatch)e.priceQueue.delete(p.id);
       }catch{priceArchiveFailures++;}
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
       expiryMs:input.expiryMs,marketId,observations:[],nowMs:now(),
       researchPreference:options.preference??researchPreference,earlyPolicyVersion:options.earlyPolicyVersion};
    let e=entries.get(input.intervalMinutes);
    if(e&&identity(e.round)!==identity(round)&&round.startMs<=e.round.startMs){rejected++;return Promise.resolve();}
    if(!e||identity(e.round)!==identity(round)){
       if(e&&!e.deadlineRecorded&&now()>=e.round.expiryMs){
         retired.set(identity(e.round),e);
         // Bounded buffer. Durable restart recovery exposes missing finalizations
         // if an outage exceeds this capacity; never invent a dropped choice.
         if(retired.size>64)retired.delete(retired.keys().next().value!);
         void schedule(e);
       }
       e=newEntry(round);
      entries.set(input.intervalMinutes,e);
    }
    const latest=e.queue.at(-1)?.receivedAtMs??e.observations.at(-1)?.receivedAtMs;
    if(latest!=null&&at!<=latest){rejected++;return e.job??Promise.resolve();}
     e.version++;e.receivedAtMs=at!;e.acceptedAtMs=now();
     e.queue.push({...input,features:{...input.features,shadowAcceptedAtMs:e.acceptedAtMs}});
    if(e.queue.length>64){e.queue.splice(0,e.queue.length-64);dropped++;
      e.queue[0]={...e.queue[0],features:{...e.queue[0].features,eventGapResetAtMs:at}};}
     freezeCandidates(e);
    return schedule(e);
  }
  function read(round:{roundId:string;startMs:number;expiryMs:number;intervalMinutes:5|15}):TwoStageProjection|null{
    const e=entries.get(round.intervalMinutes);
    if(!e||(!decisionWriterAllowed()&&now()-e.lastReloadMs>1500))void restore(round);
    if(!e||e.round.roundId!==round.roundId||e.round.startMs!==round.startMs||
      e.round.expiryMs!==round.expiryMs)return null;
     attachPrices(e);const input=frame(e),priceFeatures=accumulatedFeatures(input);
    const state=(stage:"EARLY"|"CONFIRMATION",s:StageState)=>({...s,reason:s.lock?s.reason:
       e.error??assessStage(input,stage,e.early.lock,policyFor(input,stage)).reason,
       diagnostics:s.lock?s.lock.diagnostics:assessStage(input,stage,e.early.lock,policyFor(input,stage)).diagnostics,
       timing:s.lock?.timing?{...s.lock.timing,commitAcknowledgedAtMs:s.lock.committedAtMs,projectionAtMs:now()}:s.timing});
    return {...round,marketId:e.round.marketId,strategyVersion:TWO_STAGE_STRATEGY,shadowOnly:true,automaticExecutionAllowed:false,
      early:state("EARLY",e.early),confirmation:state("CONFIRMATION",e.confirmation),
       relationship:stageRelationship(e.early.lock,e.confirmation.lock),priceFeatures,settlementRule:priceFeatures.settlementRule,
       researchPreference:e.round.researchPreference,policyRegistry:stagePolicyRegistry.health(),researchActivated:false};
  }
  function unavailable(interval:5|15,atMs:number,reason:string){
    const e=entries.get(interval);if(!e||atMs>=e.round.expiryMs)return;
    void observe({...e.round,observedAt:new Date(atMs).toISOString(),receivedAtMs:atMs,
      probabilityUp:null,probabilityDown:null,features:{marketId:e.round.marketId,sourceFailure:reason}});
  }
  /** Read-only recovery also works for the website when an existing external
   * leased collector is the sole writer. Never backfill a prediction on restore. */
  function restore(round:Pick<StageInput,"roundId"|"startMs"|"expiryMs"|"intervalMinutes">){
    const key=`${round.intervalMinutes}:${round.roundId}:${round.startMs}:${round.expiryMs}`;
    const existing=restoreJobs.get(key);if(existing)return existing;
    if(now()<retryAfterMs||now()<(restoreRetry.get(key)??0))return Promise.resolve();
    const job=(async()=>{
      try{
        const found=await db().query(`SELECT market_id FROM waterx_two_stage_rounds WHERE strategy_version=$1
          AND interval_minutes=$2 AND round_id=$3 AND start_ms=$4 AND expiry_ms=$5 AND network='sui:mainnet' LIMIT 2`,
          [TWO_STAGE_STRATEGY,round.intervalMinutes,round.roundId,round.startMs,round.expiryMs]);
        if(found.rows.length!==1){
          restoreRetry.set(key,now()+1500);
          if(restoreRetry.size>64)restoreRetry.delete(restoreRetry.keys().next().value!);
          return;
        }
        const old=entries.get(round.intervalMinutes);
        if(old&&(old.job||old.round.startMs>round.startMs))return;
        const input:StageInput={...round,marketId:String(found.rows[0].market_id),observations:[],nowMs:now(),
          researchPreference:options.preference??researchPreference,earlyPolicyVersion:options.earlyPolicyVersion};
        const entry=old&&identity(old.round)===identity(input)?old:newEntry(input);
        const locks=await readStageLocks(input,db());
        const observations=await db().query(`SELECT input FROM waterx_two_stage_observations WHERE network=$1
          AND market_id=$2 AND round_id=$3 AND interval_minutes=$4 AND strategy_version=$5
          ORDER BY received_at_ms,observation_id LIMIT 4096`,stageIdentity(input));
        const prices=await db().query(`SELECT point FROM waterx_two_stage_prices WHERE network=$1 AND market_id=$2
          AND round_id=$3 AND interval_minutes=$4 AND strategy_version=$5 ORDER BY source_at_ms LIMIT 25000`,stageIdentity(input));
        if(entries.get(round.intervalMinutes)!==old)return;
        restoreLocks(entry,locks);entry.observations=observations.rows.map(r=>r.input as EventObservation);
        for(const row of prices.rows){const p=row.point as PricePoint;entry.prices.set(p.id,p);}
        entry.restored=true;entry.lastReceiptMs=entry.observations.at(-1)?.receivedAtMs??-1;entry.lastReloadMs=now();
        entries.set(round.intervalMinutes,entry);
      }catch{failures++;retryAfterMs=now()+5000;}
    })().finally(()=>{restoreJobs.delete(key);});
    restoreJobs.set(key,job);return job;
  }
  function observePrice(point:PricePoint){
    if(!Number.isFinite(point.price)||point.price<=0||!Number.isSafeInteger(point.atMs)||
      !Number.isSafeInteger(point.availableAtMs)||point.availableAtMs>now()||point.atMs>point.availableAtMs||
      rawPrices.has(point.id)){priceRejected++;return;}
    priceStreamTicks++;
    if(lastStreamSourceAt!=null&&point.atMs>lastStreamSourceAt)sourceCadence.push(point.atMs-lastStreamSourceAt);
    if(point.receivedAtMs!=null)receiptLatency.push(point.receivedAtMs-point.atMs);
    if(sourceCadence.length>256)sourceCadence.shift();if(receiptLatency.length>256)receiptLatency.shift();
    lastStreamSourceAt=Math.max(lastStreamSourceAt??point.atMs,point.atMs);
    // Independent 3-second source-time samples reuse the existing chart minimum
    // capture cadence. Keep the 5-second interpolation veto, including outages.
    if(lastCapturedSourceAt!=null&&point.atMs-lastCapturedSourceAt<3000)return;
    lastCapturedSourceAt=point.atMs;
    rawPrices.set(point.id,point);
    for(const [id,p] of Array.from(rawPrices))if(p.atMs<now()-15*60000)rawPrices.delete(id);
    while(rawPrices.size>25000)rawPrices.delete(rawPrices.keys().next().value!);
    for(const e of Array.from(entries.values()))if(now()<e.round.expiryMs){
      attachPrices(e);
      freezeCandidates(e);
      if(e.priceQueue.size&&!e.job)void schedule(e);
    }
  }
  function tick(){
    if(!decisionWriterAllowed())return;
    for(const e of [...Array.from(entries.values()),...Array.from(retired.values())]){
      if(now()>=e.round.expiryMs){
        if(!e.deadlineRecorded&&!e.job)void schedule(e);
        continue;
      }
      // Retry valid frozen candidates independently of the next provider tick.
      // No new input or changed deadline is synthesized by this clock.
      freezeCandidates(e);
      if((e.candidates.size||e.queue.length||e.priceQueue.size)&&!e.job)void schedule(e);
    }
  }
  return {observe,observePrice,read,restore,unavailable,tick,health:()=>({shadowOnly:true,failures,dropped,rejected,activeIntervals:entries.size,
    retiredPendingN:retired.size,
    priceRejected,priceArchiveFailures,optionalFailures,independentPricePointN:rawPrices.size,
    priceCapture:{upstreamTicks:priceStreamTicks,captureMinimumSourceSpacingMs:3000,maximumInterpolationGapMs:5000,
      recentSourceCadenceMs:sourceCadence.slice(),recentSourceToReceiptLatencyMs:receiptLatency.slice()},
    confirmationPolicy:stagePolicyRegistry.health(),researchPreference:options.preference??researchPreference,
    idlePoolFailure,lastError:Array.from(entries.values()).map(e=>e.error).filter(Boolean).at(-1)??null})};
}
export const twoStageRuntime=createTwoStageRuntime();
