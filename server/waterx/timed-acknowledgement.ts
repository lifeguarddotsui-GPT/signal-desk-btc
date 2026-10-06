import {timedPool} from "./timed-db";
import type {LockDb} from "./lock-store";
type Pending={id:string;actualAck:number;attempts:number;nextAt:number};
const pending=new Map<string,Pending>();
let failures=0,retried=0,lastFailureAtMs:number|null=null;
/** Only retry the actual observed COMMIT response time. A lost process journal
 * stays UNKNOWN after restart; neither worker receipt nor restart time substitutes. */
export async function journalTimedAcknowledgement(id:string,actualAck:number,db:LockDb=timedPool){
  try{
    const written=await db.query(`UPDATE waterx_timed_outbox SET committed_ack_at_ms=$2
      WHERE decision_id=$1 AND committed_ack_at_ms IS NULL RETURNING committed_ack_at_ms`,[id,actualAck]);
    const stored=written.rows[0]??(await db.query("SELECT committed_ack_at_ms FROM waterx_timed_outbox WHERE decision_id=$1",[id])).rows[0];
    if(!stored||Number(stored.committed_ack_at_ms)!==actualAck)
      throw Object.assign(new Error("Acknowledgement journal not confirmed"),{code:"ACK_JOURNAL_UNCONFIRMED"});
    pending.delete(id);return true;
  }catch(error){
    failures++;lastFailureAtMs=Date.now();
    const old=pending.get(id),attempts=(old?.attempts??0)+1;
    if(pending.size<256||old)pending.set(id,{id,actualAck,attempts,nextAt:Date.now()+Math.min(30000,1000*2**Math.min(attempts,5))});
    console.error("[waterx-timed] ACK_JOURNAL_FAILURE",{
      decisionId:id,actualCommitResponseAtMs:actualAck,attempts,
      errorClass:(error as {code?:string}).code??"JOURNAL_WRITE_FAILED",
      recovery:"Bounded retry of actual acknowledgement; after process loss acknowledgement remains unknown."});
    return false;
  }
}
export async function retryTimedAcknowledgements(db:LockDb=timedPool,now=Date.now()){
  for(const p of Array.from(pending.values()).filter(p=>p.nextAt<=now).slice(0,20)){
    retried++;await journalTimedAcknowledgement(p.id,p.actualAck,db);
  }
}
export const timedAcknowledgementHealth=()=>({pending:pending.size,failures,retried,lastFailureAtMs,
  restartSemantics:"Unjournaled producer acknowledgements remain unknown; durable outbox delivery is independent."});
