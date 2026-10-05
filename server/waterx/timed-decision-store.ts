import {validWaterxProbabilityPair} from "../../shared/round-decision";
import {TIMED_STRATEGY,type TimedDecision,type TimedRound} from "../../shared/timed-decision";
import type {LockObservation} from "../../shared/lock-readiness";
import {type LockDb} from "./lock-store";
import {timedPool} from "./timed-db";
import {buildTimedDecision} from "./timed-decision-builder";
export type TimedInput=TimedRound&{receivedAtMs?:number;observedAt:string;probabilityUp:number|null;
  probabilityDown:number|null;discoveredAtMs?:number;anchorPrice?:number|null;anchorConfirmed?:boolean;features?:Record<string,unknown>};
const values=(r:TimedRound)=>["sui:mainnet",TIMED_STRATEGY,r.intervalMinutes,r.roundId];
const selectSaved=`SELECT d.decision,o.committed_ack_at_ms,o.worker_received_at_ms
 FROM waterx_timed_decisions d JOIN waterx_timed_outbox o ON o.decision_id=d.id`;
function unpack(row:Record<string,unknown>):TimedDecision{
  const d={...(row.decision as TimedDecision)},ack=row.committed_ack_at_ms==null?null:Number(row.committed_ack_at_ms);
  d.committedAtMs=ack;d.workerReceivedAtMs=row.worker_received_at_ms==null?null:Number(row.worker_received_at_ms);
  d.onTime=ack===null?null:ack<=d.hardDeadlineAtMs;
  d.operationalFailure=ack!==null&&ack>d.hardDeadlineAtMs?"COMMIT_AFTER_HARD_DEADLINE":null;
  return d;
}
export async function loadTimedDecision(round:TimedRound,db:LockDb=timedPool){
  const r=await db.query(`${selectSaved} WHERE d.network=$1 AND d.strategy_version=$2
    AND d.interval_minutes=$3 AND d.round_id=$4`,values(round));
  const saved=r.rows[0]?unpack(r.rows[0]):null;
  if(saved&&(saved.startMs!==round.startMs||saved.expiryMs!==round.expiryMs))throw new Error("Timed round identity mismatch");
  return saved;
}
/** Network reads never await this writer. The transaction serializes all instances by exact strategy/round. */
export async function captureTimedDecision(input:TimedInput,db=timedPool,onSelected?:()=>void){
  const received=input.receivedAtMs;
  if(!Number.isSafeInteger(received)||received!<input.startMs||received!>=input.expiryMs)
    throw new Error("Invalid timed source receipt");
  if(input.expiryMs-input.startMs!==input.intervalMinutes*60000)throw new Error("Invalid timed exact round");
  const acquireStarted=performance.now();
  const c=await db.connect();let committed=false,transactionStarted=false,saved:TimedDecision|null=null,inserted=false;
  const acquisitionMs=performance.now()-acquireStarted,preparationStarted=performance.now();
  try{
    // Prospective capture/preparation precedes the short serialized final write.
    // An observation surviving a failed decision transaction is evidence, not a lock.
    const now=Date.now();
    const discovered=input.discoveredAtMs??received!;
    if(!Number.isSafeInteger(discovered)||discovered<input.startMs||discovered>now)
      throw new Error("Invalid timed actual discovery clock");
    await c.query(`INSERT INTO waterx_timed_rounds(network,strategy_version,interval_minutes,round_id,
      start_ms,expiry_ms,discovered_at_ms) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [...values(input),input.startMs,input.expiryMs,discovered]);
    const identity=await c.query(`SELECT start_ms,expiry_ms,discovered_at_ms FROM waterx_timed_rounds
      WHERE network=$1 AND strategy_version=$2 AND interval_minutes=$3 AND round_id=$4`,values(input));
    const r=identity.rows[0];
    if(!r||Number(r.start_ms)!==input.startMs||Number(r.expiry_ms)!==input.expiryMs)
      throw new Error("Timed persisted exact round mismatch");
    saved=await loadTimedDecision(input,c);
    if(!saved){
      await c.query(`INSERT INTO waterx_timed_observations(network,strategy_version,interval_minutes,
        round_id,received_at_ms,input) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [...values(input),received,JSON.stringify(input)]);
      const data=await c.query(`SELECT input FROM waterx_timed_observations WHERE network=$1 AND strategy_version=$2
        AND interval_minutes=$3 AND round_id=$4 ORDER BY received_at_ms LIMIT 2001`,values(input));
      if(data.rows.length>2000)throw new Error("Timed observation explicit coverage bound exceeded");
      const all=data.rows.map(row=>row.input as TimedInput),latest=all.at(-1);
      const observations:LockObservation[]=all.filter(v=>validWaterxProbabilityPair(v.probabilityUp,v.probabilityDown))
        .map(v=>({atMs:v.receivedAtMs!,receivedAtMs:v.receivedAtMs!,providerSourceAtMs:null,
          probabilityUp:v.probabilityUp!,probabilityDown:v.probabilityDown!,sourceHealthy:true}));
      const decisionAtMs=Date.now(); // Real post-query time, never the queued event's old clock.
      const candidate=buildTimedDecision(input,observations,Number(r.discovered_at_ms),decisionAtMs,
        !!latest&&validWaterxProbabilityPair(latest.probabilityUp,latest.probabilityDown),
        {inputFailure:latest?.probabilityUp===null&&latest?.probabilityDown===null?"NO_PROBABILITY_INPUT":
          latest?.probabilityUp===null||latest?.probabilityDown===null?"MISSING_PROBABILITY_SIDE":"INVALID_PROBABILITY_PAIR",
          reference:latest?.anchorPrice??null,referenceConfirmed:latest?.anchorConfirmed??false,
          features:latest?.features??{},comparisonSettlementInference:false,
           discoveredAtMs:Number(r.discovered_at_ms),
           quote:"INDICATIVE_ONLY_NO_EXECUTABLE_FILL",observationHistory:all.map(v=>({
             receivedAtMs:v.receivedAtMs,probabilityUp:v.probabilityUp,probabilityDown:v.probabilityDown}))},true);
      if(candidate){
         onSelected?.();
         candidate.evidence.persistenceTiming={
           databaseAcquisitionMs:acquisitionMs,preparationMs:performance.now()-preparationStarted,
           preparedAtMs:decisionAtMs,transactionRequestedAtMs:Date.now(),
           definition:"Monotonic acquisition/preparation durations; ACK is recorded separately. No provider/browser latency inferred."};
         await c.query("BEGIN");
         transactionStarted=true;
         await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",[values(input).join(":")]);
        const result=await c.query(`INSERT INTO waterx_timed_decisions(id,network,strategy_version,
          interval_minutes,round_id,decision_at_ms,status,decision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT(network,strategy_version,interval_minutes,round_id) DO NOTHING RETURNING id`,
          [candidate.id,...values(input),candidate.decisionAtMs,candidate.status,JSON.stringify(candidate)]);
        inserted=result.rows.length>0;
        if(inserted){
          await c.query("INSERT INTO waterx_timed_outbox(decision_id) VALUES($1)",[candidate.id]);
          await c.query("SELECT pg_notify('bluewater_timed_decision',$1)",[candidate.id]);
        }
        saved=await loadTimedDecision(input,c);
      }
    }
    if(transactionStarted)await c.query("COMMIT");
    committed=true;
    if(inserted&&saved){
      const ack=Date.now();
      // Separate acknowledgement journal: never mutates the frozen prediction or outbox identity.
      await c.query(`UPDATE waterx_timed_outbox SET committed_ack_at_ms=$2
        WHERE decision_id=$1 AND committed_ack_at_ms IS NULL`,[saved.id,ack]).catch(()=>{});
      saved={...saved,committedAtMs:ack,onTime:ack<=saved.hardDeadlineAtMs,
        operationalFailure:ack>saved.hardDeadlineAtMs?"COMMIT_AFTER_HARD_DEADLINE":null};
    }
    return saved;
  }finally{if(transactionStarted&&!committed)await c.query("ROLLBACK").catch(()=>{});c.release();}
}
export async function consumeTimedDecisionReceipts(db:LockDb=timedPool){
  return db.query(`UPDATE waterx_timed_outbox SET worker_received_at_ms=floor(extract(epoch FROM clock_timestamp())*1000)::bigint
    WHERE decision_id IN(SELECT decision_id FROM waterx_timed_outbox
      WHERE worker_received_at_ms IS NULL ORDER BY created_at LIMIT 20)
    AND worker_received_at_ms IS NULL RETURNING decision_id`);
}
export async function timedHistory(interval:5|15,limit=50,db:LockDb=timedPool){
  const rows=await db.query(`${selectSaved} WHERE d.network='sui:mainnet' AND d.strategy_version=$1
    AND d.interval_minutes=$2 ORDER BY d.decision_at_ms DESC LIMIT $3`,[TIMED_STRATEGY,interval,limit]);
  const entries=rows.rows.map(unpack);
  return {strategyVersion:TIMED_STRATEGY,entries,metrics:{n:entries.length,
    onTimeLocks:entries.filter(d=>d.status==="LOCKED"&&d.onTime===true).length,
    deadlineLocks:entries.filter(d=>d.lockReason.startsWith("DEADLINE")).length,
    missed:entries.filter(d=>d.status==="MISSED_DEADLINE"||d.operationalFailure).length,
    noValidInput:entries.filter(d=>d.status==="NO_VALID_INPUT").length,settledN:0},
    qualification:"Research only; unverified settlement/quotes excluded. No model advantage claimed."};
}
