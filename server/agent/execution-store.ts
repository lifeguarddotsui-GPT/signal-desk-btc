import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {agentPolicySchema} from "../../shared/agent-policy";
import {agentPool} from "./store";
import {loadTimedDecision} from "../waterx/timed-decision-store";
import {experimentalFinalSignal} from "./final-signal";
import type {TimedRound} from "../../shared/timed-decision";

/** One wallet lock spans accounts, policies, intervals, processes and sessions.
 * UNKNOWN continues consuming every limit. Only a proven zero-spend outcome
 * releases a reservation; fills/settlement never reset round/session turnover. */
export async function reserveExecution(input:{owner:string;sessionId:string;round:TimedRound;decisionId:string;
  collateralCents:number;gasMist:number},db:Pool=agentPool) {
  if(!Number.isSafeInteger(input.collateralCents)||input.collateralCents<1||
    !Number.isSafeInteger(input.gasMist)||input.gasMist<1)throw new Error("Invalid reservation limits");
  const c=await db.connect();
  try{
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",["agent-wallet:"+input.owner]);
    const old=(await c.query("SELECT * FROM bluewater_execution_intents WHERE owner=$1 AND decision_id=$2",
      [input.owner,input.decisionId])).rows[0];
    if(old){await c.query("COMMIT");return {created:false,intent:old};}
    const session=(await c.query(`SELECT s.*,a.account_id AS current_account,a.policy_version AS current_policy
      FROM bluewater_execution_sessions s JOIN bluewater_agents a USING(owner)
      WHERE s.id=$1 AND s.owner=$2 FOR UPDATE OF s,a`,[input.sessionId,input.owner])).rows[0];
    if(!session||session.status!=="ARMED"||Number(session.expires_at_ms)<=Date.now()||
      session.current_account!==session.account_id||Number(session.current_policy)!==Number(session.policy_version))
      throw new Error("Current unexpired owner-authorized session required");
    const p=agentPolicySchema.parse(session.policy);
    if(p.network!=="mainnet"||p.signalSource!=="EXPERIMENTAL_QUALIFICATION_GATES"||
      !p.intervals.includes(input.round.intervalMinutes)||!session.signer_permit_ref)
      throw new Error("Strategy, interval or isolated signer permit not authorized");
    const saved=await loadTimedDecision(input.round,c);
    if(!saved||saved.id!==input.decisionId||!experimentalFinalSignal(saved,Date.now())||
      Date.now()-saved.committedAtMs!>p.maxSignalAgeMs||
      input.round.expiryMs-Date.now()<p.minRemainingMs)
      throw new Error("Fresh committed final decision required");
    const sums=(await c.query(`SELECT
      COALESCE(sum(reserved_cents) FILTER(WHERE interval_minutes=$2 AND round_id=$3 AND start_ms=$4 AND expiry_ms=$5
        AND status NOT IN ('REJECTED','UNFILLED')),0) AS round_cents,
      COALESCE(sum(reserved_cents) FILTER(WHERE session_id=$6 AND status NOT IN ('REJECTED','UNFILLED')),0) AS session_cents,
      COALESCE(sum(reserved_gas_mist) FILTER(WHERE session_id=$6),0) AS session_gas,
      COALESCE(sum(reserved_cents) FILTER(WHERE status IN ('RESERVED','PREPARED','UNKNOWN','ACCEPTED','FILLED')),0) AS open_cents
      FROM bluewater_execution_intents WHERE owner=$1`,
      [input.owner,input.round.intervalMinutes,input.round.roundId,input.round.startMs,input.round.expiryMs,input.sessionId])).rows[0];
    if(Number(sums.round_cents)+input.collateralCents>p.roundCollateralCents||
      Number(sums.session_cents)+input.collateralCents>p.sessionTurnoverCents||
      Number(sums.session_gas)+input.gasMist>p.sessionGasBudgetMist||
      (p.maxOrderCents!==null&&input.collateralCents>p.maxOrderCents)||
      p.maxUnresolved.mode!=="AMOUNT"||Number(sums.open_cents)+input.collateralCents>p.maxUnresolved.value)
      throw new Error("Wallet round, session, gas, order or unresolved-exposure limit");
    const id=randomUUID(),v=input.round;
    const inserted=(await c.query(`INSERT INTO bluewater_execution_intents
      (id,session_id,owner,decision_id,round_id,interval_minutes,start_ms,expiry_ms,account_id,policy_version,
      reserved_cents,reserved_gas_mist,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'RESERVED') RETURNING *`,
      [id,input.sessionId,input.owner,input.decisionId,v.roundId,v.intervalMinutes,v.startMs,v.expiryMs,
        session.account_id,session.policy_version,input.collateralCents,input.gasMist])).rows[0];
    await c.query("COMMIT");return {created:true,intent:inserted};
  }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e;}finally{c.release();}
}
export async function persistPreparedExecution(id:string,owner:string,bytes:Uint8Array,digest:string,
  signerExecutionRef:string,db:Pool=agentPool) {
  if(!bytes.length||!digest||!signerExecutionRef)throw new Error("Prepared transaction identity required");
  const r=await db.query(`UPDATE bluewater_execution_intents SET status='PREPARED',transaction_bytes=$3,
    transaction_digest=$4,signer_execution_ref=$5,updated_at=clock_timestamp()
    WHERE id=$1 AND owner=$2 AND status='RESERVED' RETURNING id`,
    [id,owner,Buffer.from(bytes).toString("base64"),digest,signerExecutionRef]);
  if(r.rowCount!==1)throw new Error("Intent is not reservable for preparation");
}
/** Persist UNKNOWN BEFORE calling the submitter. A timeout or process death
 * therefore cannot make the same spend available to another worker. */
export async function beginExecutionSubmission(id:string,owner:string,db:Pool=agentPool) {
  const r=await db.query(`UPDATE bluewater_execution_intents i SET status='UNKNOWN',updated_at=clock_timestamp()
    FROM bluewater_execution_sessions s,bluewater_agents a WHERE i.id=$1 AND i.owner=$2 AND i.status='PREPARED'
    AND s.id=i.session_id AND s.status='ARMED' AND s.expires_at_ms>$3 AND i.expiry_ms>$3
    AND a.owner=i.owner AND a.account_id=i.account_id AND a.policy_version=i.policy_version
    AND a.status IN ('RUNNING','LIVE') RETURNING i.*`,
    [id,owner,Date.now()]);
  return r.rows[0]??null;
}
/** Reconciliation reads include paused/stopped sessions, unlike submission. */
export async function executionReconciliationQueue(db:Pool=agentPool) {
  return (await db.query(`SELECT * FROM bluewater_execution_intents
    WHERE status IN ('UNKNOWN','ACCEPTED','FILLED','SETTLED') ORDER BY updated_at LIMIT 50`)).rows;
}
