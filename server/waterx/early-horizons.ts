import {createHash} from "node:crypto";
import {earlyHorizons,evaluateTimedDecision,TIMED_STRATEGY} from "../../shared/timed-decision";
import {validWaterxProbabilityPair} from "../../shared/round-decision";
import type {TimedInput} from "./timed-decision-store";
import type {LockDb} from "./lock-store";
import {researchPool} from "./research-store";
import {observationId} from "./observation-provenance";
import {forecastEarlyShadow} from "./early-shadow-runtime";
const ordered=(value:unknown):unknown=>Array.isArray(value)?value.map(ordered):
  value!==null&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))
    .map(([k,v])=>[k,ordered(v)])):value;
export const digestEarlySnapshot=(value:unknown)=>createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");
export function freezeEarlyHorizon(input:TimedInput,horizon:number,history:TimedInput[],now:number,primaryLocked:boolean){
  if(!earlyHorizons(input.intervalMinutes).includes(horizon))throw new Error("Unscheduled early horizon");
  const scheduledAtMs=input.startMs+horizon*1000;
  if(now<scheduledAtMs)throw new Error("Horizon not reached");
  const prior=history.filter(v=>v.receivedAtMs!=null&&v.receivedAtMs<=scheduledAtMs&&v.receivedAtMs>=input.startMs)
    .sort((a,b)=>a.receivedAtMs!-b.receivedAtMs!),latest=prior.at(-1);
  const interruptedAt=prior.filter(v=>!validWaterxProbabilityPair(v.probabilityUp,v.probabilityDown)).at(-1)?.receivedAtMs??-Infinity;
  const rows=prior.filter(v=>v.receivedAtMs!>interruptedAt&&validWaterxProbabilityPair(v.probabilityUp,v.probabilityDown)).map(v=>({
    atMs:v.receivedAtMs!,receivedAtMs:v.receivedAtMs!,providerSourceAtMs:null,
    probabilityUp:v.probabilityUp!,probabilityDown:v.probabilityDown!,sourceHealthy:true}));
  const evaluated=evaluateTimedDecision(input,rows,scheduledAtMs);
  const missed=now>scheduledAtMs+2000,valid=!!latest&&validWaterxProbabilityPair(latest.probabilityUp,latest.probabilityDown)&&
    scheduledAtMs-latest.receivedAtMs!<=10000;
  const status=missed?"MISSED_HORIZON":valid?"FROZEN":"DATA_FAILURE";
  const reference=latest?.anchorPrice??null,comparison=latest?.features?.comparison as
    {price?:number;source?:string;asOf?:string}|null|undefined;
  const comparisonAt=Date.parse(comparison?.asOf??""),comparisonValid=Number.isFinite(comparisonAt)&&
     Number(latest?.features?.contextAvailableAtMs??latest?.receivedAtMs??Infinity)<=scheduledAtMs&&
    comparisonAt<=scheduledAtMs&&scheduledAtMs-comparisonAt<=10000&&
    typeof comparison?.price==="number"&&Number.isFinite(comparison.price)&&comparison.price>0;
   const contextTimely=Number(latest?.features?.contextAvailableAtMs??latest?.receivedAtMs??Infinity)<=scheduledAtMs;
   const referenceAvailable=contextTimely&&typeof reference==="number"&&Number.isFinite(reference)&&reference>0;
   const referenceValid=referenceAvailable&&latest?.anchorConfirmed===true;
   const independent=prior.flatMap(v=>{
     const c=v.features?.comparison as {price?:number;asOf?:string}|undefined;
     const at=Date.parse(c?.asOf??"");
     return c&&typeof c.price==="number"&&Number.isFinite(c.price)&&c.price>0&&
       Number.isFinite(at)&&at<=scheduledAtMs&&at>=input.startMs&&
       Number(v.features?.contextAvailableAtMs??v.receivedAtMs)<=scheduledAtMs?
       [{price:c.price,atMs:at}]:[];
   }).filter((v,i,a)=>a.findIndex(x=>x.atMs===v.atMs)===i);
   const returns=independent.slice(1).map((v,i)=>Math.log(v.price/independent[i].price));
   const mean=returns.length?returns.reduce((a,b)=>a+b,0)/returns.length:0;
  const snapshot={
    schema:"bluewater-early-horizon-v1",strategyVersion:TIMED_STRATEGY,intervalMinutes:input.intervalMinutes,
    roundId:input.roundId,startMs:input.startMs,expiryMs:input.expiryMs,horizonSeconds:horizon,
    scheduledAtMs,frozenAtMs:now,status,primaryDecisionAlreadyLocked:primaryLocked,captureVersion:"atomic-gate-capture-v1",
    observationIds:prior.map(v=>observationId(input.intervalMinutes,input.roundId,v.receivedAtMs!)),
    probabilityUp:status==="FROZEN"?latest!.probabilityUp:null,
    probabilityDown:status==="FROZEN"?latest!.probabilityDown:null,
    modelProbabilityUp:null,modelVersion:null,calibrationVersion:null,featureSchemaVersion:"early-past-only-context-v1",
    receivedAtMs:latest?.receivedAtMs??null,providerOddsAtMs:null,
     provisionalSide:valid&&Number(latest?.features?.contextAvailableAtMs??Infinity)<=scheduledAtMs?
       latest?.features?.provisionalSide??null:null,leanVersion:latest?.features?.leanVersion??null,
    reference:{price:referenceAvailable?reference:null,quality:referenceValid?"confirmed":"missing-or-provisional"},
    gateEvaluation:null as Record<string,unknown>|null,
    features:!missed?{
      marketProbabilityUp:valid?latest!.probabilityUp:null,
      probabilityChange:rows.length>1?rows.at(-1)!.probabilityUp-rows[0].probabilityUp:null,
      sameSideMs:evaluated.components?.sameSideMs??null,
       recentReversals:evaluated.components?.recentReversals??null,
       validObservationCount:evaluated.components?.validCount??0,
       trendKind:evaluated.components?.trendKind??"MISSING",
       sourceAgeMs:evaluated.sourceAgeMs,
      probabilityRange:evaluated.components?.probabilityRange??null,
      referenceDistance:referenceValid&&comparisonValid?(comparison!.price!-reference!)/reference!:null,
      comparisonSource:comparisonValid?comparison!.source??null:null,
      secondsRemaining:(input.expiryMs-scheduledAtMs)/1000,
      missingReference:!referenceValid,missingComparison:!comparisonValid,
      missingProbabilities:!valid,
      comparisonPrice:comparisonValid?comparison!.price:null,
      comparisonReceivedAtMs:comparisonValid?comparisonAt:null,
      priceMovement:independent.length>1?independent.at(-1)!.price/independent[0].price-1:null,
      volatility:returns.length>1?Math.sqrt(returns.reduce((s,r)=>s+(r-mean)**2,0)/returns.length):null,
      spread:null,liquidity:null,
        crossInterval:contextTimely?latest?.features?.crossInterval??null:null,
    }:null,
    qualification:{components:evaluated.components??null,requirementsMet:valid?evaluated.requirementsMet:0,
      blocker:missed?"MISSED_GATE":!valid?"NO_VALID_PROBABILITY_INPUT":evaluated.blocker,
      outcome:missed?"MISSED_GATE":primaryLocked?"POST_LOCK_SHADOW":valid&&evaluated.qualified?"QUALIFIED":"WAIT"},
    coverage:{accepted:rows.length,ageMs:evaluated.sourceAgeMs,windowMs:75000},
    executableQuote:null,quoteStatus:"MISSING",
    provenance:prior.map(v=>({receivedAtMs:v.receivedAtMs,availableAtMs:v.features?.contextAvailableAtMs??null,
      providerSourceAtMs:null,probabilityUp:v.probabilityUp,probabilityDown:v.probabilityDown})),
    semantics:"Prospective elapsed horizon; no post-horizon observations. Late capture is MISSED, never reconstructed.",
  };
  const forecast=status==="FROZEN"?forecastEarlyShadow(input.intervalMinutes,horizon,latest!.probabilityUp!,
    snapshot.features as Record<string,unknown>,scheduledAtMs):null;
  const frozen={...snapshot,modelProbabilityUp:forecast?.probabilityUp??null,modelVersion:forecast?.modelVersion??null,
    calibrationVersion:forecast?.calibrationVersion??null,crossModelProbabilityUp:forecast?.crossProbabilityUp??null,
    modelDisposition:forecast?"PROSPECTIVE_SHADOW_ONLY":"NO_MODEL_RAN"};
  return {snapshot:frozen,status,scheduledAtMs,digest:digestEarlySnapshot(frozen)};
}
export async function persistFrozenHorizon(input:TimedInput,horizon:number,freeze:ReturnType<typeof freezeEarlyHorizon>,db:LockDb){
  await db.query(`INSERT INTO waterx_early_horizons(network,strategy_version,interval_minutes,round_id,
    start_ms,expiry_ms,horizon_seconds,scheduled_at_ms,frozen_at_ms,status,snapshot,snapshot_sha256)
    VALUES('sui:mainnet',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
    [TIMED_STRATEGY,input.intervalMinutes,input.roundId,input.startMs,input.expiryMs,horizon,
      freeze.scheduledAtMs,freeze.snapshot.frozenAtMs,freeze.status,JSON.stringify(freeze.snapshot),freeze.digest]);
}
/** Called outside the critical decision transaction; idempotent immutable freezes. */
export async function captureEarlyHorizons(input:TimedInput,now=Date.now(),db:LockDb=researchPool){
  const due=earlyHorizons(input.intervalMinutes).filter(h=>input.startMs+h*1000<=now);
  if(!due.length)return;
  const existing=await db.query(`SELECT horizon_seconds FROM waterx_early_horizons
    WHERE network='sui:mainnet' AND strategy_version=$1 AND interval_minutes=$2 AND round_id=$3`,
    [TIMED_STRATEGY,input.intervalMinutes,input.roundId]);
  const completed=new Set(existing.rows.map(r=>Number(r.horizon_seconds)));
  for(const h of due.filter(h=>!completed.has(h))){
    const at=input.startMs+h*1000,missed=now>at+2000;
    const data=missed?{rows:[]} :await db.query(`SELECT input FROM waterx_timed_observations
      WHERE network='sui:mainnet' AND strategy_version=$1 AND interval_minutes=$2 AND round_id=$3
        AND received_at_ms BETWEEN $4 AND $5 AND accepted_at_ms<=$5 ORDER BY received_at_ms DESC LIMIT 512`,
      [TIMED_STRATEGY,input.intervalMinutes,input.roundId,Math.max(input.startMs,at-75000),at]);
    const locked=await db.query(`SELECT id FROM waterx_timed_decisions WHERE network='sui:mainnet'
      AND strategy_version=$1 AND interval_minutes=$2 AND round_id=$3 AND status='LOCKED'`,
      [TIMED_STRATEGY,input.intervalMinutes,input.roundId]);
    const freeze=freezeEarlyHorizon(input,h,data.rows.map(r=>r.input as TimedInput),Date.now(),locked.rows.length>0);
    await db.query(`INSERT INTO waterx_early_horizons(network,strategy_version,interval_minutes,round_id,
      start_ms,expiry_ms,horizon_seconds,scheduled_at_ms,frozen_at_ms,status,snapshot,snapshot_sha256)
      VALUES('sui:mainnet',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
      [TIMED_STRATEGY,input.intervalMinutes,input.roundId,input.startMs,input.expiryMs,h,
        at,freeze.snapshot.frozenAtMs,freeze.status,JSON.stringify(freeze.snapshot),freeze.digest]);
  }
}
