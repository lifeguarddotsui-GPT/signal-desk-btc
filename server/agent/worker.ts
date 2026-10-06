import {acknowledgeEarlyDecisionEvents,lockPool} from "../waterx/lock-store";
import {consumeTimedDecisionReceipts} from "../waterx/timed-decision-store";
import { pathToFileURL } from "node:url";
import { agentPool, agentTransaction, ledger } from "./store";
import { agentPolicySchema } from "../../shared/agent-policy";
import {committedFinalEvents} from "../waterx/final-events";
import {experimentalFinalSignal} from "./final-signal";

/** Dedicated development shadow observer. It has no signer and no submission path.
 * Do not turn indicative WaterX probabilities into executable quotes or champions.
 * A future verified adapter must supply exact economics and the prerequisites
 * for the explicitly selected strategy before WOULD_EXECUTE can be recorded.
 */
export async function shadowWorkerTick() {
  if (process.env.NODE_ENV !== "development") throw new Error("Agent worker is development-only");
  await acknowledgeEarlyDecisionEvents(agentPool);
  await consumeTimedDecisionReceipts(agentPool);
  const agents=(await agentPool.query("SELECT owner FROM bluewater_agents WHERE status='SHADOW' LIMIT 101")).rows;
  if(agents.length>100)throw new Error("Agent worker bound exceeded; no partial processing accepted");
  for(const {owner}of agents)await agentTransaction(owner,async(c,row)=>{
    if(row.status!=="SHADOW"||!row.paper)return; // Recheck under same lock as pause/policy changes.
    const p=agentPolicySchema.parse(row.policy),paper=row.paper,day=new Date().toISOString().slice(0,10);
    const timed=p.signalSource==="EXPERIMENTAL_QUALIFICATION_GATES"?
      await committedFinalEvents(p.intervals,Date.now()-p.maxSignalAgeMs,c):[];
    for(const event of timed){
      const decision=event.decision;
      const roundKey=`timed:${decision.strategyVersion}:${decision.intervalMinutes}:${decision.roundId}`;
      await c.query(`INSERT INTO bluewater_agent_ledger(owner,event,policy_version,round_key,details)
        VALUES($1,'WOULD_HOLD',$2,$3,$4) ON CONFLICT DO NOTHING`,
        [owner,row.policy_version,roundKey,JSON.stringify({decisionId:decision.id,
          reason:experimentalFinalSignal(decision,Date.now())?"QUALIFIED_RESEARCH_EXECUTION_PREREQUISITES_UNVERIFIED":
            "COMMITTED_DECISION_NOT_TRADE_ELIGIBLE",
          signalSource:decision.strategyVersion,waitingForCanonical:false,signing:false,submission:false})]);
    }
    if(paper.day!==day){
      paper.day=day;paper.dayStartingCents=paper.availableCents;paper.dayTurnoverCents=0;paper.dayRealizedPnlCents=0;
      await ledger(c,owner,"UTC_DAY_RESET",Number(row.policy_version),{day,sessionId:paper.sessionId,sessionHighWaterCents:paper.highWaterCents});
      await c.query("UPDATE bluewater_agents SET paper=$2 WHERE owner=$1",[owner,JSON.stringify(paper)]);
    }
    if(p.targetCents!==null && paper.availableCents>=p.targetCents){
      paper.stopReason="TARGET_REACHED";paper.stoppedAt=new Date().toISOString();
      await ledger(c,owner,"TARGET_REACHED",Number(row.policy_version),{paper,policy:p});
      await c.query("UPDATE bluewater_agents SET status='TARGET_REACHED',paper=$2,revision=revision+1 WHERE owner=$1",[owner,JSON.stringify(paper)]);return;
    }
    // A selected early strategy must not silently fall through to canonical or
    // champion-only logic. This observer still cannot sign or submit.
    const choices=p.signalSource==="EXPERIMENTAL_QUALIFICATION_GATES"?[]:(await c.query(`SELECT interval_minutes,round_id,start_ms,expiry_ms,decision_at_ms,side,probability_up
      FROM waterx_research_choices WHERE state='FROZEN' AND expiry_ms>extract(epoch FROM clock_timestamp())*1000
      AND interval_minutes=ANY($1::int[]) ORDER BY decision_at_ms LIMIT 10`,[p.intervals])).rows;
    for(const choice of choices){
      const key=`${p.network}:${choice.interval_minutes}:${choice.round_id}:${choice.start_ms}:${choice.expiry_ms}`;
      const inserted=await c.query(`INSERT INTO bluewater_agent_ledger(owner,event,policy_version,round_key,details)
        VALUES($1,'EXECUTION_CANDIDATE',$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
        [owner,row.policy_version,key,JSON.stringify({canonicalChoice:choice,signalSource:"WaterX Market Baseline",policy:p,sessionId:paper.sessionId})]);
      if(!inserted.rows.length)continue;
      await ledger(c,owner,"WOULD_HOLD",Number(row.policy_version),{
        reason:"NO_VERIFIED_CHAMPION_EXECUTION_ADAPTER",
        explanation:"Canonical WaterX baseline is preserved, not promoted to Bluewater champion. Verified executable economics and staging delegation remain unavailable.",
        roundKey:key,policy:p,sessionId:paper.sessionId,signing:false,submission:false,
      },key);
    }
  });
}
export async function runAgentWorker(){
  if(process.env.NODE_ENV!=="development")throw new Error("Production execution is disabled");
  let stopped=false;const stop=()=>{stopped=true;};
  process.once("SIGTERM",stop);process.once("SIGINT",stop);
  console.log("Bluewater Agent development shadow observer: NO signer, NO submission.");
  let wake:(()=>void)|null=null;
  const listener=await lockPool.connect();
  listener.on("notification",()=>wake?.());
  await listener.query("LISTEN bluewater_early_decision");
  await listener.query("LISTEN bluewater_timed_decision");
  while(!stopped){
    try{await shadowWorkerTick();}catch{console.error("Agent shadow observer unavailable; no trades submitted.");}
    await new Promise<void>(resolve=>{
      const done=()=>{clearTimeout(timer);wake=null;resolve();};
      const timer=setTimeout(done,3000);wake=done;
    });
  }
  await listener.query("UNLISTEN *");listener.release();
  await lockPool.end();
  await agentPool.end();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void runAgentWorker();