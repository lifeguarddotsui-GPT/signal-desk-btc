import {randomUUID} from "node:crypto";
import {validWaterxProbabilityPair} from "../../shared/round-decision";
import {TIMED_STRATEGY,timedWindow,GATE_MS,GATE_GRACE_MS,type TimedDecision,type TimedRound,type GateJournal} from "../../shared/timed-decision";
import type {LockObservation} from "../../shared/lock-readiness";
import {type LockDb} from "./lock-store";
import {timedPool} from "./timed-db";
import {buildTimedDecision,evaluateQualificationGate} from "./timed-decision-builder";
import {scoredTimedHistory} from "./timed-history";
import {journalTimedAcknowledgement,retryTimedAcknowledgements} from "./timed-acknowledgement";
import {recordEarlyDelivery} from "./early-delivery-metrics";
import {digestEarlySnapshot,freezeEarlyHorizon} from "./early-horizons";
import {enqueueGateResearch} from "./gate-research-queue";
import {decisionWriterAllowed} from "./decision-authority";
export type TimedInput=TimedRound&{receivedAtMs?:number;observedAt:string;probabilityUp:number|null;
 probabilityDown:number|null;discoveredAtMs?:number;anchorPrice?:number|null;anchorConfirmed?:boolean;features?:Record<string,unknown>};
const values=(r:TimedRound)=>["sui:mainnet",TIMED_STRATEGY,r.intervalMinutes,r.roundId];
type Progress={startMs:number;expiryMs:number;seen:Set<number>;saved:TimedDecision|null;lastGate:GateJournal|null;inputDigest:string};
const progressByDb=new WeakMap<object,Map<string,Progress>>();
const selectSaved=`SELECT d.decision,o.committed_ack_at_ms,o.worker_received_at_ms
 FROM waterx_timed_decisions d JOIN waterx_timed_outbox o ON o.decision_id=d.id`;
function unpack(row:Record<string,unknown>):TimedDecision{
 const d={...(row.decision as TimedDecision)},ack=row.committed_ack_at_ms==null?null:Number(row.committed_ack_at_ms);
 d.committedAtMs=ack;d.workerReceivedAtMs=row.worker_received_at_ms==null?null:Number(row.worker_received_at_ms);
 d.onTime=ack===null||d.status!=="LOCKED"?null:ack<=d.hardDeadlineAtMs;
 d.acknowledgementStatus=ack===null?"UNKNOWN":"JOURNALED";
 d.operationalFailure=d.onTime===false?d.strategyVersion===TIMED_STRATEGY?"COMMIT_AFTER_GATE_GRACE":"COMMIT_AFTER_HARD_DEADLINE":null;return d;
}
export async function loadTimedDecision(round:TimedRound,db:LockDb=timedPool){
 const r=await db.query(`${selectSaved} WHERE d.network=$1 AND d.strategy_version=$2 AND d.interval_minutes=$3 AND d.round_id=$4`,values(round));
 const saved=r.rows[0]?unpack(r.rows[0]):null;
 if(saved&&(saved.startMs!==round.startMs||saved.expiryMs!==round.expiryMs))throw new Error("Timed round identity mismatch");
 return saved;
}
export async function loadGateJournals(round:TimedRound,db:LockDb=timedPool){
 const r=await db.query(`SELECT journal FROM waterx_gate_journals WHERE network=$1 AND strategy_version=$2
 AND interval_minutes=$3 AND round_id=$4 ORDER BY gate_index`,values(round));return r.rows.map((r:Record<string,unknown>)=>r.journal as GateJournal);
}
function finalRecord(input:TimedInput,gates:GateJournal[],now:number):TimedDecision{
 const hadFailures=gates.some(g=>["WAIT_FRESH_DATA","MISSED_GATE","INVALID_ROUND"].includes(g.result));
 const worked=gates.length===input.intervalMinutes*2-1&&!hadFailures;
 const status=worked?"ABSTAINED_NO_QUALIFIED_SIGNAL":"DATA_FAILURE",w=timedWindow(input.intervalMinutes);
 return {id:randomUUID(),strategyVersion:TIMED_STRATEGY,network:"sui:mainnet",intervalMinutes:input.intervalMinutes,
 roundId:input.roundId,startMs:input.startMs,expiryMs:input.expiryMs,status,side:null,probabilityUp:null,probabilityDown:null,
 observationId:null,receivedAtMs:null,decisionAtMs:now,elapsedMs:now-input.startMs,
 targetAtMs:input.startMs+w.targetSeconds*1000,hardDeadlineAtMs:input.expiryMs,lockReason:status,earlyBlocker:status,
 ambiguous:false,coverage:{n:gates.length,firstAtMs:gates[0]?.scheduledAtMs??null,lastAtMs:gates.at(-1)?.scheduledAtMs??null,maxGapMs:null},
 committedAtMs:null,workerReceivedAtMs:null,onTime:null,operationalFailure:null,automaticExecutionAllowed:false,
  evidence:{gateResults:gates.map(g=>({gateIndex:g.gateIndex,result:g.result})),hadFailures,noForcedChoice:true,
    persistenceFailureCount:Number(input.features?.persistenceFailureCount??0)}};
}
/** One short serialized transaction commits the immutable gate, lock and outbox together.
 * Accepted-at is an independent DB timestamp: queued later data cannot enter an earlier gate. */
export async function captureTimedDecision(input:TimedInput,db=timedPool,onSelected?:()=>void,
 onGate?:(gate:GateJournal)=>void){
 if(!decisionWriterAllowed())return null;
 const received=input.receivedAtMs,now=Date.now();
 if(!Number.isSafeInteger(received)||received!<input.startMs||received!>=input.expiryMs||received!>now)
   throw new Error("Invalid timed source receipt");
 if(input.expiryMs-input.startMs!==input.intervalMinutes*60000)throw new Error("Invalid timed exact round");
 const acquire=performance.now();
 const cache=progressByDb.get(db)??new Map<string,Progress>();progressByDb.set(db,cache);
 const cacheKey=values(input).join(":"),progress=cache.get(cacheKey);
 if(progress&&(progress.startMs!==input.startMs||progress.expiryMs!==input.expiryMs))
   throw new Error("Cached timed round identity mismatch");
  const client=await db.connect().catch(error=>{
   recordEarlyDelivery(input.intervalMinutes,input.roundId,"DATABASE_ACQUISITION",performance.now()-acquire,"error");
   throw error;
 });let committed=false,inserted:TimedDecision|null=null;
  const emitted:GateJournal[]=[];let saved:TimedDecision|null=null;
  const research:{seconds:number;frozen:ReturnType<typeof freezeEarlyHorizon>}[]=[];
  let transactionAt:number|null=null,phase="PREPARATION",began=false;
  const c:LockDb={query:async(sql,params)=>{
    const at=performance.now();let outcome:"ok"|"error"="ok";
    try{return await client.query(sql,params);}
    catch(error){outcome="error";throw error;}
    finally{recordEarlyDelivery(input.intervalMinutes,input.roundId,
      sql.includes("pg_advisory_xact_lock")?"DATABASE_LOCK_WAIT":`DATABASE_${phase}_QUERY`,
      performance.now()-at,outcome);}
  }};
 recordEarlyDelivery(input.intervalMinutes,input.roundId,"DATABASE_ACQUISITION",performance.now()-acquire,"ok");
 try{
 const discovered=input.discoveredAtMs??received!;
 if(!Number.isSafeInteger(discovered)||discovered<input.startMs||discovered>now)throw new Error("Invalid discovery clock");
 if(!progress){
 await c.query(`INSERT INTO waterx_timed_rounds(network,strategy_version,interval_minutes,round_id,start_ms,expiry_ms,discovered_at_ms)
 VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[...values(input),input.startMs,input.expiryMs,discovered]);
 const identity=(await c.query(`SELECT start_ms,expiry_ms FROM waterx_timed_rounds
 WHERE network=$1 AND strategy_version=$2 AND interval_minutes=$3 AND round_id=$4`,values(input))).rows[0];
 if(!identity||Number(identity.start_ms)!==input.startMs||Number(identity.expiry_ms)!==input.expiryMs)throw new Error("Persisted round identity mismatch");
 }
 // Evidence ingestion is independent of the final gate transaction and remains live after lock.
 const inputDigest=digestEarlySnapshot(input);
 if(progress?.inputDigest!==inputDigest){
 await c.query(`INSERT INTO waterx_timed_observations(network,strategy_version,interval_minutes,round_id,received_at_ms,input)
 VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[...values(input),received,JSON.stringify(input)]);
 if(progress)progress.inputDigest=inputDigest;
 }
  recordEarlyDelivery(input.intervalMinutes,input.roundId,"DATABASE_PREPARATION",performance.now()-acquire,"ok");
  const pendingDue=Math.min(input.intervalMinutes*2-1,Math.floor((Date.now()-input.startMs)/GATE_MS));
  // Immutable progress only skips already-committed gates. Every new accepted
  // observation above is still persisted with its database availability clock.
  // Restart starts empty and loads authoritative PostgreSQL records again.
  if(progress&&Date.now()<input.expiryMs&&
    Array.from({length:pendingDue},(_,i)=>i+1).every(i=>progress.seen.has(i))){
    if(progress.lastGate)onGate?.(progress.lastGate);
    recordEarlyDelivery(input.intervalMinutes,input.roundId,"COMMITTED_PROGRESS_REUSE",null,"ok");
    return progress.saved;
  }
  phase="GATE";transactionAt=performance.now();
  await c.query("BEGIN");
  began=true;
 await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",[values(input).join(":")]);
 saved=await loadTimedDecision(input,c);
 const existing=await loadGateJournals(input,c),seen=new Set(existing.map(g=>g.gateIndex));
 const due=Math.min(input.intervalMinutes*2-1,Math.floor((Date.now()-input.startMs)/GATE_MS));
  // Evaluate the only possibly on-time gate before recording older recovery
  // misses. Old misses cannot be prospective choices; serializing their writes
  // first used up the current gate's unchanged two-second grace.
  const liveDue=due>0&&Date.now()<=input.startMs+due*GATE_MS+GATE_GRACE_MS;
  // On-time gate/lock/outbox ACK must not wait for earlier recovery misses.
  // The next ordinary capture (outside a grace window) durably records them.
   const dueIndices=liveDue?[due]:Array.from({length:due},(_,i)=>i+1).reverse()
     .filter(index=>!seen.has(index)).slice(0,4);
  for(const index of dueIndices){
   if(seen.has(index))continue;
   const at=input.startMs+index*GATE_MS;
   const data:{rows:Record<string,unknown>[]}=Date.now()>at+GATE_GRACE_MS?{rows:[]}:
     await c.query(`SELECT input FROM waterx_timed_observations WHERE network=$1 AND strategy_version=$2
       AND interval_minutes=$3 AND round_id=$4 AND received_at_ms BETWEEN $5 AND $6
       AND accepted_at_ms<=$6 ORDER BY received_at_ms DESC LIMIT 513`,[...values(input),Math.max(input.startMs,at-75000),at]);
   if(data.rows.length>512)throw new Error("Gate evidence bound exceeded");
   const inputs=data.rows.map(r=>r.input as TimedInput).reverse(),latest=inputs.at(-1);
   const interruptedAt=inputs.filter(v=>!validWaterxProbabilityPair(v.probabilityUp,v.probabilityDown)).at(-1)?.receivedAtMs??-Infinity;
   const obs:LockObservation[]=inputs.filter(v=>v.receivedAtMs!>interruptedAt&&validWaterxProbabilityPair(v.probabilityUp,v.probabilityDown)).map(v=>({
     atMs:v.receivedAtMs!,receivedAtMs:v.receivedAtMs!,providerSourceAtMs:null,
     probabilityUp:v.probabilityUp!,probabilityDown:v.probabilityDown!,sourceHealthy:true}));
   const evaluatedAt=Date.now(),valid=!!latest&&validWaterxProbabilityPair(latest.probabilityUp,latest.probabilityDown);
   let gate=evaluateQualificationGate(input,obs,index,evaluatedAt,valid);
   const previouslyLocked=saved?.status==="LOCKED";
   const candidate=!saved&&gate.result==="QUALIFIED"?buildTimedDecision(input,obs,discovered,evaluatedAt,valid,
     {reference:latest?.anchorPrice??null,referenceConfirmed:latest?.anchorConfirmed??false,
       features:latest?.features??{},observationHistory:inputs,executionCutoffAtMs:null}):null;
   if(candidate){
      candidate.evidence={...candidate.evidence,persistenceFailureCount:Number(input.features?.persistenceFailureCount??0),
        modelVersion:null,calibrationVersion:null,probabilitySource:"WATERX_MARKET",
        projectionVersion:"waterx-current-strategy-v1"};
     onSelected?.();
     await c.query(`INSERT INTO waterx_timed_decisions(id,network,strategy_version,interval_minutes,round_id,decision_at_ms,status,decision)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[candidate.id,...values(input),candidate.decisionAtMs,candidate.status,JSON.stringify(candidate)]);
     await c.query("INSERT INTO waterx_timed_outbox(decision_id) VALUES($1)",[candidate.id]);
     await c.query("SELECT pg_notify('bluewater_timed_decision',$1)",[candidate.id]);saved=inserted=candidate;
   }
    const horizon=freezeEarlyHorizon(input,index*30,inputs,evaluatedAt,previouslyLocked);
    horizon.snapshot.gateEvaluation={result:candidate?"LOCKED":gate.result,reason:gate.reason,
      evaluatedAtMs:evaluatedAt,scheduledAtMs:at,primaryDecisionId:saved?.id??null};
    horizon.digest=digestEarlySnapshot(horizon.snapshot);
    const {snapshotDigest:_digest,...body}=gate;
    const frozen={...body,captureVersion:"atomic-gate-capture-v1",decisionId:candidate?.id??null,evidenceSnapshot:{
     schema:"waterx-gate-evidence-v1",availableByMs:at,observations:inputs,
     reference:latest?.anchorPrice??null,referenceConfirmed:latest?.anchorConfirmed??false,
     features:latest?.features??{},missingInput:!latest,latestInputValid:valid,
      inputReceiptSemantics:"Both HTTP receipt and database acceptance at or before scheduled gate",
      researchFreeze:horizon}};
   gate={...frozen,snapshotDigest:digestEarlySnapshot(frozen)};
   await c.query(`INSERT INTO waterx_gate_journals(network,strategy_version,interval_minutes,round_id,gate_index,
     scheduled_at_ms,evaluated_at_ms,evidence_cutoff_ms,result,decision_id,journal) VALUES($1,$2,$3,$4,$5,$6,$7,$6,$8,$9,$10)`,
     [...values(input),index,at,evaluatedAt,gate.result,gate.decisionId,JSON.stringify(gate)]);
   existing.push(gate);emitted.push(gate);
     // Freeze from the same availability-filtered evidence and original gate
     // clock. Persist optional research only after gate/decision/outbox commit.
     research.push({seconds:index*30,frozen:horizon});
 }
  if(!saved&&Date.now()>=input.expiryMs&&existing.length===input.intervalMinutes*2-1){
    const final=finalRecord(input,existing.sort((a,b)=>a.gateIndex-b.gateIndex),Date.now());
   await c.query(`INSERT INTO waterx_timed_decisions(id,network,strategy_version,interval_minutes,round_id,decision_at_ms,status,decision)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[final.id,...values(input),final.decisionAtMs,final.status,JSON.stringify(final)]);
   await c.query("INSERT INTO waterx_timed_outbox(decision_id) VALUES($1)",[final.id]);saved=inserted=final;
 }
 if(!decisionWriterAllowed()){await c.query("ROLLBACK");return null;}
 const commitAt=performance.now();await c.query("COMMIT");committed=true;
  recordEarlyDelivery(input.intervalMinutes,input.roundId,"DATABASE_TRANSACTION",performance.now()-transactionAt,"ok");
  transactionAt=null;phase="POSTCOMMIT";
 recordEarlyDelivery(input.intervalMinutes,input.roundId,"COMMIT_RESPONSE",performance.now()-commitAt,"ok");
 if(inserted){
   const ack=Date.now(),ok=await journalTimedAcknowledgement(inserted.id,ack,c);
   saved={...inserted,committedAtMs:ack,acknowledgementStatus:ok?"JOURNALED":"UNJOURNALED",
     onTime:inserted.status==="LOCKED"?ack<=inserted.hardDeadlineAtMs:null,
     operationalFailure:inserted.status==="LOCKED"&&ack>inserted.hardDeadlineAtMs?"COMMIT_AFTER_GATE_GRACE":null};
 }
  emitted.sort((a,b)=>a.gateIndex-b.gateIndex).forEach(g=>onGate?.(g));
  cache.set(cacheKey,{startMs:input.startMs,expiryMs:input.expiryMs,
    seen:new Set(existing.map(g=>g.gateIndex)),saved,lastGate:existing.sort((a,b)=>a.gateIndex-b.gateIndex).at(-1)??null,inputDigest});
  if(cache.size>32)cache.delete(cache.keys().next().value!);
  if(!emitted.length&&existing.length)onGate?.(existing.at(-1)!);return saved;
 }catch(error){cache.delete(cacheKey);recordEarlyDelivery(input.intervalMinutes,input.roundId,"CAPTURE_ATTEMPT",performance.now()-acquire,"error");throw error;}
  finally{
    if(transactionAt!==null)recordEarlyDelivery(input.intervalMinutes,input.roundId,"DATABASE_TRANSACTION",performance.now()-transactionAt,"error");
    if(began&&!committed)await c.query("ROLLBACK").catch(()=>{});
    client.release();
    if(committed)enqueueGateResearch(input,research,db===timedPool?undefined:db);
  }
}
export async function consumeTimedDecisionReceipts(db:LockDb=timedPool){
 await retryTimedAcknowledgements(db);
 return db.query(`UPDATE waterx_timed_outbox SET worker_received_at_ms=floor(extract(epoch FROM clock_timestamp())*1000)::bigint
 WHERE decision_id IN(SELECT decision_id FROM waterx_timed_outbox WHERE worker_received_at_ms IS NULL ORDER BY created_at LIMIT 20)
 AND worker_received_at_ms IS NULL RETURNING decision_id`);
}
export const timedHistory=(interval:5|15,limit=50,db:LockDb=timedPool)=>scoredTimedHistory({interval:String(interval),limit},Date.now(),db);
