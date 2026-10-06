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
  const rows=prior.filter(v=>validWaterxProbabilityPair(v.probabilityUp,v.probabilityDown)).map(v=>({
    atMs:v.receivedAtMs!,receivedAtMs:v.receivedAtMs!,providerSourceAtMs:null,
    probabilityUp:v.probabilityUp!,probabilityDown:v.probabilityDown!,sourceHealthy:true}));
  const evaluated=evaluateTimedDecision(input,rows,scheduledAtMs);
  const missed=now>scheduledAtMs+2000,valid=!!latest&&validWaterxProbabilityPair(latest.probabilityUp,latest.probabilityDown)&&
    scheduledAtMs-latest.receivedAtMs!<=10000;
  const status=missed?"MISSED_HORIZON":valid?"FROZEN":"DATA_FAILURE";
  const reference=latest?.anchorPrice??null,comparison=latest?.features?.comparison as
    {price?:number;source?:string;asOf?:string}|null|undefined;
  const comparisonAt=Date.parse(comparison?.asOf??""),comparisonValid=Number.isFinite(comparisonAt)&&
    comparisonAt<=scheduledAtMs&&scheduledAtMs-comparisonAt<=10000&&
    typeof comparison?.price==="number"&&Number.isFinite(comparison.price)&&comparison.price>0;
  const referenceValid=latest?.anchorConfirmed===true&&typeof reference==="number"&&Number.isFinite(reference)&&reference>0;
  const snapshot={
    schema:"bluewater-early-horizon-v1",strategyVersion:TIMED_STRATEGY,intervalMinutes:input.intervalMinutes,
    roundId:input.roundId,startMs:input.startMs,expiryMs:input.expiryMs,horizonSeconds:horizon,
    scheduledAtMs,frozenAtMs:now,status,primaryDecisionAlreadyLocked:primaryLocked,captureVersion:"atomic-gate-capture-v1",
    observationIds:prior.map(v=>observationId(input.intervalMinutes,input.roundId,v.receivedAtMs!)),
    probabilityUp:status==="FROZEN"?latest!.probabilityUp:null,
    probabilityDown:status==="FROZEN"?latest!.probabilityDown:null,
    modelProbabilityUp:null,modelVersion:null,calibrationVersion:null,featureSchemaVersion:"early-past-only-context-v1",
    receivedAtMs:latest?.receivedAtMs??null,providerOddsAtMs:null,
    reference:{price:reference,quality:referenceValid?"confirmed":"missing-or-provisional"},
    features:status==="FROZEN"?{
      marketProbabilityUp:latest!.probabilityUp,
      probabilityChange:rows.length>1?rows.at(-1)!.probabilityUp-rows[0].probabilityUp:null,
      sameSideMs:evaluated.components?.sameSideMs??null,
       recentReversals:evaluated.components?.recentReversals??null,
       sourceAgeMs:evaluated.sourceAgeMs,
      probabilityRange:evaluated.components?.probabilityRange??null,
      referenceDistance:referenceValid&&comparisonValid?(comparison!.price!-reference!)/reference!:null,
      comparisonSource:comparisonValid?comparison!.source??null:null,
      secondsRemaining:(input.expiryMs-scheduledAtMs)/1000,
      missingReference:!referenceValid,missingComparison:!comparisonValid,
      spread:null,liquidity:null,
       crossInterval:latest?.features?.crossInterval??null,
    }:null,
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
