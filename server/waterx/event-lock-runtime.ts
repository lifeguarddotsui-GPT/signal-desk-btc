import {EVENT_LOCK_STRATEGY,EVENT_FEATURE_VERSION,eventQualification,type EventObservation,type EventLockProjection} from "../../shared/event-lock";
import {validWaterxProbabilityPair} from "../../shared/round-decision";
import {provisionalLean} from "../../shared/provisional-lean";
import type {TimedRound,TimedDecision} from "../../shared/timed-decision";
import type {TimedInput} from "./timed-decision-store";
import {observationId} from "./observation-provenance";
import {eventIdentity,readEventLock,commitEventLock} from "./event-lock-store";
import {timedPool} from "./timed-db";
import {researchPool} from "./research-store";
import {recordEarlyDelivery} from "./early-delivery-metrics";
import {digestEarlySnapshot} from "./early-horizons";
import {decisionWriterAllowed} from "./decision-authority";

type ClientDb={query:typeof timedPool.query;connect:typeof timedPool.connect};
type Entry={round:TimedRound;pending:TimedInput[];observations:EventObservation[];latest:TimedInput;
  version:number;saved:TimedDecision|null;firstQualifiedAtMs:number|null;restored:boolean;
  persistence:EventLockProjection["persistence"];error:string|null;duplicates:number;outOfOrder:number;
  dropped:number;postLock:number;retryAfterMs:number;receipts:Map<number,string>;job:Promise<void>|null;
  lean:ReturnType<typeof provisionalLean>};
const key=(r:TimedRound)=>`${r.intervalMinutes}:${r.roundId}:${r.startMs}:${r.expiryMs}`;
const roundOf=(r:TimedRound):TimedRound=>({intervalMinutes:r.intervalMinutes,roundId:r.roundId,startMs:r.startMs,expiryMs:r.expiryMs});
const inputDigest=(i:TimedInput)=>digestEarlySnapshot({receipt:i.receivedAtMs,up:i.probabilityUp,down:i.probabilityDown,
  sourceFailure:i.features?.sourceFailure??null});
const observation=(input:TimedInput,availableAtMs:number,accepted:number|null,provenance:EventObservation["provenance"]):EventObservation=>({
  id:observationId(input.intervalMinutes,input.roundId,input.receivedAtMs!),atMs:input.receivedAtMs!,
  receivedAtMs:input.receivedAtMs!,availableAtMs,databaseAcceptedAtMs:accepted,providerSourceAtMs:null,
  probabilityUp:input.probabilityUp??NaN,probabilityDown:input.probabilityDown??NaN,
  sourceHealthy:!input.features?.sourceFailure&&validWaterxProbabilityPair(input.probabilityUp,input.probabilityDown),
  provenance,features:{...input.features}});

/** Loss-aware bounded FIFO. Only evaluation is coalesced: every retained distinct
 * receipt is written in the batch. Overflow resets qualification and is reported. */
export function createEventLockRuntime(options:{
  db?:ClientDb;archiveDb?:{query:typeof timedPool.query};now?:()=>number;
  provenance?:EventObservation["provenance"];onSaving?:(round:TimedRound)=>void;
}={}){
  const db=options.db??timedPool,now=options.now??Date.now;
  // Resolve the optional archive pool only when work runs. Its module graph
  // imports projections, so eager global default capture can fail on cold imports.
  const archive={query:((sql:string,params?:unknown[])=>(options.archiveDb??researchPool).query(sql,params)) as typeof researchPool.query};
  const provenance=options.provenance??"PROSPECTIVE",entries=new Map<number,Entry>();
  const metrics={failures:0,reconciliations:0,archiveFailures:0,recoveries:0,accepted:0,lastError:null as string|null};
  const MAX_PENDING=128,MAX_WORKING=256;
  function create(input:TimedInput):Entry{
    return {round:roundOf(input),pending:[],observations:[],latest:input,version:0,saved:null,
      firstQualifiedAtMs:null,restored:false,persistence:"OBSERVING",error:null,duplicates:0,outOfOrder:0,
      dropped:0,postLock:0,retryAfterMs:0,receipts:new Map(),job:null,lean:provisionalLean([],now(),input.startMs)};
  }
  async function restore(e:Entry,c:{query:typeof timedPool.query}){
    await c.query(`INSERT INTO waterx_timed_rounds(network,strategy_version,interval_minutes,round_id,
      start_ms,expiry_ms,discovered_at_ms) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [...eventIdentity(e.round),e.round.startMs,e.round.expiryMs,now()]);
    const identity=(await c.query(`SELECT start_ms,expiry_ms FROM waterx_timed_rounds WHERE network=$1
      AND strategy_version=$2 AND interval_minutes=$3 AND round_id=$4`,eventIdentity(e.round))).rows[0];
    if(!identity||Number(identity.start_ms)!==e.round.startMs||Number(identity.expiry_ms)!==e.round.expiryMs)
      throw new Error("Event round identity mismatch");
    e.saved=await readEventLock(e.round,c);
    if(e.saved&&typeof e.saved.evidence.firstQualifiedAtMs==="number")e.firstQualifiedAtMs=e.saved.evidence.firstQualifiedAtMs;
    const rows=await c.query(`SELECT input,accepted_at_ms FROM waterx_timed_observations WHERE network=$1
      AND strategy_version=$2 AND interval_minutes=$3 AND round_id=$4 AND received_at_ms >= $5
      ORDER BY received_at_ms DESC LIMIT 256`,[...eventIdentity(e.round),now()-75000]);
    // Restart cannot invent old application availability. Unknown ACK times are
    // available now, not backdated; no historical evaluation is run here.
    e.observations=rows.rows.reverse().map(row=>{
      const input=row.input as TimedInput;
      const ack=Number(input.features?.eventDurableAvailableAtMs);
        return observation(input,Number.isSafeInteger(ack)&&ack>=input.receivedAtMs!&&ack<=now()?ack:now(),
         Number(row.accepted_at_ms),input.features?.eventCaptureMode==="PROSPECTIVE"?"PROSPECTIVE":"SYNTHETIC");
    });
    e.restored=true;
    if(e.saved)e.persistence="COMMITTED";
  }
  async function drain(e:Entry){
    const acquire=performance.now();
    const c=await db.connect().catch(error=>{
      recordEarlyDelivery(e.round.intervalMinutes,e.round.roundId,"EVENT_POOL_ACQUISITION",performance.now()-acquire,"error");
      throw error;
    });
    recordEarlyDelivery(e.round.intervalMinutes,e.round.roundId,"EVENT_POOL_ACQUISITION",performance.now()-acquire,"ok");
    try{
      if(!e.restored)await restore(e,c);
      // After any uncertain outcome, read back the unique identity before another write.
      if(e.persistence==="UNKNOWN"){metrics.reconciliations++;e.saved=await readEventLock(e.round,c);e.persistence=e.saved?"COMMITTED":"OBSERVING";}
      let batches=0;
      while(e.pending.length&&batches++<2){
        const batch=e.pending.splice(0,MAX_PENDING),batchVersion=e.version;
        const prepared=batch.map(input=>({...input,features:{...input.features,
          eventCaptureMode:input.features?.synthetic===true?"SYNTHETIC":provenance,
          eventFeatureVersion:EVENT_FEATURE_VERSION,eventModelVersion:null,eventCalibrationVersion:null,
          eventProbabilitySource:"WaterX market",missingProbabilityInputs:input.probabilityUp==null||input.probabilityDown==null}}));
        const inserted=await c.query(`INSERT INTO waterx_timed_observations
          (network,strategy_version,interval_minutes,round_id,received_at_ms,input)
          SELECT $1,$2,$3,$4,(v->>'receivedAtMs')::bigint,v FROM jsonb_array_elements($5::jsonb) v
          ON CONFLICT DO NOTHING RETURNING received_at_ms,accepted_at_ms`,[...eventIdentity(e.round),JSON.stringify(prepared)]).catch(error=>{
             const retained=[...batch,...e.pending],lost=Math.max(0,retained.length-MAX_PENDING);
             e.dropped+=lost;e.pending=retained.slice(-MAX_PENDING);
             if(lost&&e.pending.length)e.pending[0]={...e.pending[0],features:{...e.pending[0].features,
               eventGapResetAtMs:e.pending[0].receivedAtMs}};
             throw error;
          });
        const ack=now(),accepted=new Map<number,number>(inserted.rows.map(row=>[Number(row.received_at_ms),Number(row.accepted_at_ms)]));
        const durable=prepared.filter(input=>accepted.has(input.receivedAtMs!));
        for(const input of durable){
          const inputProvenance=input.features?.eventCaptureMode==="SYNTHETIC"?
            "SYNTHETIC":provenance;
          const o=observation(input,ack,accepted.get(input.receivedAtMs!)!,inputProvenance);
          e.observations.push(o);metrics.accepted++;if(e.saved)e.postLock++;
        }
         // Multiple writers may split successful inserts of the very same
         // receipts. Evaluate the durable union, not only this writer's rows.
         // Unknown peer ACKs become available now, never backdated.
         if(durable.length&&!e.saved){
           const shared=await c.query(`SELECT input,accepted_at_ms FROM waterx_timed_observations
             WHERE network=$1 AND strategy_version=$2 AND interval_minutes=$3 AND round_id=$4
               AND received_at_ms >= $5 ORDER BY received_at_ms DESC LIMIT 256`,
             [...eventIdentity(e.round),now()-75000]);
           e.observations=shared.rows.reverse().map(row=>{
             const source=row.input as TimedInput,stored=Number(source.features?.eventDurableAvailableAtMs);
             const available=accepted.has(source.receivedAtMs!)?ack:(
               Number.isSafeInteger(stored)&&stored>=source.receivedAtMs!&&stored<=now()?stored:now());
             return observation(source,available,Number(row.accepted_at_ms),
               source.features?.eventCaptureMode==="PROSPECTIVE"?"PROSPECTIVE":"SYNTHETIC");
           });
         }else e.observations=e.observations.filter(o=>o.receivedAtMs>=now()-75000).slice(-MAX_WORKING);
        const state=eventQualification(e.round,e.observations,now());
        const isCurrent=()=>entries.get(e.round.intervalMinutes)===e&&e.version===batchVersion&&
          key(e.latest)===key(e.round)&&decisionWriterAllowed()&&now()<e.round.expiryMs&&!e.latest.features?.sourceFailure&&
          validWaterxProbabilityPair(e.latest.probabilityUp,e.latest.probabilityDown)&&
          now()-e.latest.receivedAtMs!<=10000;
        if(!e.saved&&durable.length&&state.qualified&&isCurrent()){
          e.firstQualifiedAtMs??=now();
          e.saved=await commitEventLock(e.round,e.observations,c,isCurrent,now,()=>{
            e.persistence="SAVING";options.onSaving?.(e.round);
          },e.firstQualifiedAtMs);
          e.persistence=e.saved?"COMMITTED":"OBSERVING";
        }
        // Archive the real application ACK after the decision path. Failure makes
        // those rows ineligible for learned timing, not retrospectively available.
        if(durable.length)void archive.query(`UPDATE waterx_timed_observations o SET input=
          jsonb_set(jsonb_set(o.input,'{features,eventDurableAvailableAtMs}',to_jsonb($5::bigint),true),
          '{features,eventBatchEvaluation}',$7::jsonb,true) WHERE network=$1
           AND strategy_version=$2 AND interval_minutes=$3 AND round_id=$4 AND received_at_ms=ANY($6::bigint[])`,
           [...eventIdentity(e.round),ack,durable.map(i=>i.receivedAtMs!),JSON.stringify({
             evaluatedAtMs:ack,lastReceiptAtMs:durable.at(-1)!.receivedAtMs,qualification:state,
             firstQualifiedAtMs:e.firstQualifiedAtMs,saveOutcome:e.saved?"COMMITTED":e.persistence,
             savedDecisionId:e.saved?.id??null,coalescedBatchSize:durable.length})]).catch(()=>{metrics.archiveFailures++;});
      }
       e.error=null;e.retryAfterMs=0;
    }finally{c.release();}
  }
  function kick(e:Entry):Promise<void>{
    if(e.job)return e.job;
    const job=drain(e).catch(error=>{
      metrics.failures++;metrics.lastError=e.error=error instanceof Error?error.message:"EVENT_STORAGE_FAILURE";
      e.persistence=e.error.includes("UNKNOWN_EVENT_COMMIT")?"UNKNOWN":e.saved?"COMMITTED":"FAILED";
      // An insertion may have succeeded before a connection failed. Restore both
      // evidence and the unique decision identity before any subsequent attempt.
      e.restored=false;e.observations=[];e.retryAfterMs=now()+5000;
      recordEarlyDelivery(e.round.intervalMinutes,e.round.roundId,"EVENT_STORAGE",null,"error");
    }).finally(()=>{
      e.job=null;
      if(e.pending.length&&!e.error)void kick(e);
    });
    e.job=job;return job;
  }
  function observe(input:TimedInput):Promise<void>{
    const at=now(),received=input.receivedAtMs;
    if(!input.roundId||![5,15].includes(input.intervalMinutes)||!Number.isSafeInteger(input.startMs)||
      input.expiryMs-input.startMs!==input.intervalMinutes*60000||!Number.isSafeInteger(received)||
      received!<input.startMs||received!>=input.expiryMs||received!>at||at>=input.expiryMs)return Promise.resolve();
    let e=entries.get(input.intervalMinutes);
    if(e&&(input.startMs<e.round.startMs||input.startMs===e.round.startMs&&key(input)!==key(e.round))){
      e.outOfOrder++;return Promise.resolve();
    }
    if(!e||key(e.round)!==key(input)){e=create(input);entries.set(input.intervalMinutes,e);}
    const digest=inputDigest(input),old=e.receipts.get(received!);
    if(old!==undefined){e.duplicates++;if(old!==digest){e.error="CONFLICTING_RECEIPT_IDENTITY";e.version++;e.observations=[];}return e.job??Promise.resolve();}
    if(received!<e.latest.receivedAtMs!){e.outOfOrder++;return Promise.resolve();}
    e.receipts.set(received!,digest);
    if(e.receipts.size>2048)e.receipts.delete(e.receipts.keys().next().value!);
    e.latest=input;e.version++;
    const o=observation(input,at,null,provenance);
    if(o.sourceHealthy)e.lean=provisionalLean([o],at,input.startMs,e.lean);
    else e.lean=provisionalLean([],at,input.startMs);
    if(e.pending.length>=MAX_PENDING){
      e.dropped+=e.pending.length;e.pending=[];e.observations=[];
      input={...input,features:{...input.features,eventGapResetAtMs:received}};
      e.error="OBSERVATION_BUFFER_OVERFLOW";
    }
    e.pending.push(input);
    return kick(e);
  }
  return {
    observe,
    unavailable(interval:5|15,at:number,reason:string){
      const e=entries.get(interval);if(!e||at>=e.round.expiryMs)return;
      void observe({...e.latest,receivedAtMs:at,observedAt:new Date(at).toISOString(),
        probabilityUp:null,probabilityDown:null,features:{...e.latest.features,
          sourceFailure:{reason,failureObservedAtMs:at,providerQuoteReceivedAtMs:null}}});
    },
    read(round:TimedRound,at=now()):EventLockProjection|null{
      const e=entries.get(round.intervalMinutes);if(!e||key(e.round)!==key(round))return null;
      const qualification=eventQualification(round,e.observations,at);
       if(e.observations.at(-1)?.receivedAtMs!==e.latest.receivedAtMs){
         qualification.qualified=false;qualification.blocker="WAIT_DURABLE_CURRENT_INPUT";
         qualification.remainingRequirement="Waiting for current input persistence";
       }
      const healthy=!e.latest.features?.sourceFailure&&validWaterxProbabilityPair(e.latest.probabilityUp,e.latest.probabilityDown)&&
        at-e.latest.receivedAtMs!<=10000;
      const lean=healthy?e.lean.side:null;
      const state=at>=round.expiryMs?"ROUND_COMPLETE":e.saved?(e.saved.side==="UP"?"LOCKED_UP":"LOCKED_DOWN"):
        ["SAVING","UNKNOWN"].includes(e.persistence)?"SAVING":lean==="UP"?"LEANING_UP":lean==="DOWN"?"LEANING_DOWN":"WATCHING";
      return {...round,strategyVersion:EVENT_LOCK_STRATEGY,benchmarkVersion:"waterx-qualification-gates-v3",
        shadowOnly:true,activePolicyChanged:false,automaticExecutionAllowed:false,state,qualification,saved:e.saved,
        firstQualifiedAtMs:e.firstQualifiedAtMs,persistence:e.persistence,
        blocker:e.error??(!healthy?"Waiting for fresh market probabilities":qualification.remainingRequirement??qualification.blocker),
         acceptedObservations:e.observations.length,duplicateDeliveries:e.duplicates,outOfOrderInputs:e.outOfOrder,
        droppedInputs:e.dropped,postLockObservations:e.postLock};
    },
    async recover(){
      const rows=await archive.query(`SELECT x.input FROM waterx_timed_rounds r JOIN LATERAL
        (SELECT input FROM waterx_timed_observations o WHERE o.network=r.network AND o.strategy_version=r.strategy_version
        AND o.interval_minutes=r.interval_minutes AND o.round_id=r.round_id ORDER BY received_at_ms DESC LIMIT 1) x ON true
        WHERE r.strategy_version=$1 AND r.start_ms<=$2 AND r.expiry_ms>$2 ORDER BY r.start_ms DESC LIMIT 2`,
        [EVENT_LOCK_STRATEGY,now()]);
      for(const row of rows.rows){
        const input=row.input as TimedInput,old=entries.get(input.intervalMinutes);
        if(old&&old.round.startMs>=input.startMs){
           if(old.pending.length&&old.error&&now()>=old.retryAfterMs&&decisionWriterAllowed())void kick(old);
          if(key(old.round)===key(input)&&!old.saved){
            const saved=await readEventLock(old.round,archive);
            if(saved){old.saved=saved;old.persistence="COMMITTED";metrics.reconciliations++;}
          }
          continue;
        }
        const e=create(input);entries.set(input.intervalMinutes,e);
        const c=await db.connect();try{await restore(e,c);metrics.recoveries++;}finally{c.release();}
        // Restore does not evaluate old data or advertise it as a new observation.
      }
    },
    async idle(){while(Array.from(entries.values()).some(e=>e.job))await Promise.all(Array.from(entries.values()).map(e=>e.job));},
    health:()=>({...metrics,strategyVersion:EVENT_LOCK_STRATEGY,shadowOnly:true,activePolicyChanged:false,
      maximumPendingPerInterval:MAX_PENDING,maximumWorkingPerInterval:MAX_WORKING,
       maximumBatchesPerAcquisition:2,
      writerSerialization:"PostgreSQL nonblocking per exact strategy/round identity",
      productionWorkerVerified:false,learnedPolicyPromotion:"RETAIN_30_SECOND_BENCHMARK"}),
  };
}
export const eventLockRuntime=createEventLockRuntime();
