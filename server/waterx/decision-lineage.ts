import {z} from "zod";
import type {LockDb} from "./lock-store";
import {researchPool} from "./research-store";
import {TIMED_STRATEGY,type TimedDecision} from "../../shared/timed-decision";
import {TWO_STAGE_STRATEGY} from "../../shared/two-stage";

/**
 * Read-only, bounded exact-round reconciliation. No migrations or new collectors.
 * Observed timed rounds are the denominator; visitor-idle periods are NOT guessed.
 */
export const lineageQuery=z.object({
  interval:z.enum(["all","5","15"]).default("all"),
  window:z.enum(["24h","7d"]).default("24h"),
  limit:z.coerce.number().int().min(1).max(100).default(40),
}).strict();
export type LineageScore="CORRECT"|"INCORRECT"|"AWAITING_SETTLEMENT"|"DISPUTED"|"WITHHELD"|"NO_LOCK";
export type LineageChoice={
  state:string;side:"UP"|"DOWN"|null;score:LineageScore;decisionId:string|null;
  savedAtMs:number|null;acknowledgedAtMs:number|null;probabilityUp:number|null;
  policyVersion:string|null;modelVersion:string|null;source:string|null;reason:string|null;
};
export type LineageRow={
  roundId:string;intervalMinutes:5|15;startMs:number;expiryMs:number;marketId:string|null;
  outcome:"UP"|"DOWN"|null;settlementStatus:"VERIFIED"|"PENDING"|"DISPUTED"|"WITHHELD"|"MISSING";
  primary:LineageChoice;early:LineageChoice;confirmation:LineageChoice;
  checkpoint:LineageChoice|null;congruence:"AGREE"|"DISAGREE"|"NOT_COMPARABLE";
  learningNote:string;
};
const side=(x:unknown):"UP"|"DOWN"|null=>x==="UP"||x==="DOWN"?x:null;
const finite=(x:unknown):number|null=>x!==null&&x!==undefined&&Number.isFinite(Number(x))?Number(x):null;
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
const score=(saved:boolean,s:"UP"|"DOWN"|null,status:LineageRow["settlementStatus"],outcome:"UP"|"DOWN"|null):LineageScore=>
  !saved||!s?"NO_LOCK":status==="DISPUTED"?"DISPUTED":
  status==="WITHHELD"?"WITHHELD":status!=="VERIFIED"||!outcome?"AWAITING_SETTLEMENT":
  s===outcome?"CORRECT":"INCORRECT";

export function projectLineageRow(raw:Record<string,unknown>,now:number):LineageRow{
  const roundId=String(raw.round_id),intervalMinutes=Number(raw.interval_minutes) as 5|15,
    startMs=Number(raw.start_ms),expiryMs=Number(raw.expiry_ms),marketId=typeof raw.market_id==="string"?raw.market_id:null;
  const label=String(raw.label_status??"");
  const quarantine=raw.settlement_quarantine;
  const disputed=raw.settlement_disputed===true||
    Array.isArray(quarantine)&&quarantine.length>0;
  const anchor=finite(raw.settlement_anchor_price),close=finite(raw.settle_price),
    providerSide=side(typeof raw.outcome==="string"?raw.outcome.toUpperCase():null);
  const verified=label==="verified"&&!disputed&&providerSide!==null&&
    anchor!==null&&anchor>0&&close!==null&&close>0&&
    ((providerSide==="UP"&&close>=anchor)||(providerSide==="DOWN"&&close<anchor))&&
    finite(raw.settled_at)!==null&&Number(raw.settled_at)>expiryMs&&Number(raw.settled_at)<=now&&
    raw.first_verified_at!=null&&new Date(String(raw.first_verified_at)).getTime()<=now;
  const settlementStatus:LineageRow["settlementStatus"]=disputed?"DISPUTED":verified?"VERIFIED":
    label==="withheld"?"WITHHELD":raw.label_status==null?"MISSING":"PENDING";
  const outcome=verified?providerSide:null;
  const exact=(d:Record<string,unknown>)=>d.roundId===roundId&&Number(d.startMs)===startMs&&
    Number(d.expiryMs)===expiryMs&&Number(d.intervalMinutes)===intervalMinutes;
  const missing=(reason:string):LineageChoice=>({
    state:"NO_LOCK",side:null,score:"NO_LOCK",decisionId:null,savedAtMs:null,acknowledgedAtMs:null,
    probabilityUp:null,policyVersion:null,modelVersion:null,source:null,reason,
  });
  const primaryRaw=obj(raw.primary_decision);
  const primaryOK=raw.primary_id!=null&&raw.primary_outbox_id!=null&&
    finite(raw.primary_ack)!==null&&finite(primaryRaw.decisionAtMs)!==null&&
    finite(primaryRaw.decisionAtMs)!>=startMs&&
    finite(raw.primary_ack)!>=finite(primaryRaw.decisionAtMs)!&&
    finite(raw.primary_ack)!<expiryMs&&
    exact(primaryRaw)&&primaryRaw.strategyVersion===TIMED_STRATEGY;
  const primary:LineageChoice=primaryOK?{
    state:String(primaryRaw.status??"UNKNOWN"),side:primaryRaw.status==="LOCKED"?side(primaryRaw.side):null,
    score:score(primaryRaw.status==="LOCKED",side(primaryRaw.side),settlementStatus,outcome),
    decisionId:String(raw.primary_id),savedAtMs:finite(primaryRaw.decisionAtMs),
    acknowledgedAtMs:finite(raw.primary_ack),probabilityUp:finite(primaryRaw.probabilityUp),
    policyVersion:TIMED_STRATEGY,modelVersion:null,source:"WaterX market / 30-second benchmark",
    reason:String(primaryRaw.lockReason??primaryRaw.status??""),
  }:missing(raw.primary_id!=null?
    raw.primary_outbox_id==null||finite(raw.primary_ack)===null?"PRIMARY_COMMIT_ACK_MISSING":"PRIMARY_IDENTITY_OR_COMMIT_MISMATCH":
    "NOT_RECORDED_NO_RETROSPECTIVE_INFERENCE");
  const stage=(name:"early"|"confirmation"):LineageChoice=>{
    const d=obj(raw[`${name}_decision`]),stageName=name==="early"?"EARLY":"CONFIRMATION";
    const matching=Number(raw.stage_match_count)===1&&
      raw[`${name}_id`]!=null&&raw[`${name}_outbox_id`]!=null&&
      finite(raw[`${name}_ack`])!==null&&finite(d.qualifiedAtMs)!==null&&
      finite(d.qualifiedAtMs)!>=startMs&&
      finite(raw[`${name}_ack`])!>=finite(d.qualifiedAtMs)!&&
      finite(raw[`${name}_ack`])!<expiryMs&&marketId!==null&&
      exact(d)&&d.stage===stageName&&d.network==="sui:mainnet"&&d.marketId===marketId&&
      d.strategyVersion===TWO_STAGE_STRATEGY&&
      d.strategyVersion===raw.stage_strategy;
    if(!matching)return missing(Number(raw.stage_match_count)>1?"AMBIGUOUS_STAGE_MARKET":
      raw[`${name}_id`]!=null?
        raw[`${name}_outbox_id`]==null||finite(raw[`${name}_ack`])===null?
          "STAGE_COMMIT_ACK_MISSING":"STAGE_IDENTITY_OR_COMMIT_MISMATCH":
      String(raw[`${name}_reason`]??"NOT_RECORDED"));
    const s=side(d.side);
    return {
      state:s?"LOCKED":"INVALID_STAGE_DIRECTION",side:s,score:score(!!s,s,settlementStatus,outcome),
      decisionId:String(raw[`${name}_id`]),savedAtMs:finite(d.qualifiedAtMs),
      acknowledgedAtMs:finite(raw[`${name}_ack`]),probabilityUp:finite(d.probabilityUp),
      policyVersion:typeof d.policyVersion==="string"?d.policyVersion:null,
      modelVersion:typeof d.modelVersion==="string"?d.modelVersion:null,
      source:typeof d.probabilitySource==="string"?d.probabilitySource:null,reason:null,
    };
  };
  const early=stage("early"),confirmation=stage("confirmation");
  const checkpointRaw=obj(raw.checkpoint_evidence);
  const checkpointSaved=raw.checkpoint_state==="FROZEN"&&side(raw.checkpoint_side)!==null&&
    finite(raw.checkpoint_decision_at)!==null&&Number(raw.checkpoint_decision_at)<expiryMs;
  const checkpoint=raw.checkpoint_state!=null?{
    state:String(raw.checkpoint_state),side:checkpointSaved?side(raw.checkpoint_side):null,
    score:score(checkpointSaved,side(raw.checkpoint_side),settlementStatus,outcome),
    decisionId:null,savedAtMs:finite(raw.checkpoint_decision_at),acknowledgedAtMs:null,
    probabilityUp:finite(raw.checkpoint_probability_up),
    policyVersion:typeof raw.checkpoint_policy==="string"?raw.checkpoint_policy:null,
    modelVersion:typeof raw.checkpoint_model==="string"?raw.checkpoint_model:null,
    source:typeof raw.checkpoint_source==="string"?raw.checkpoint_source:null,
    reason:typeof raw.checkpoint_no_choice==="string"?raw.checkpoint_no_choice:
      typeof checkpointRaw.reason==="string"?checkpointRaw.reason:null,
  } as LineageChoice:null;
  const congruence=primary.side&&early.side?primary.side===early.side?"AGREE":"DISAGREE":"NOT_COMPARABLE";
  const learningNote=settlementStatus!=="VERIFIED"?
    "Official outcome not verified; no choice is scored.":primary.score==="NO_LOCK"&&early.score==="NO_LOCK"?
    "No saved primary or early prediction; no correctness inference.": 
    `Benchmark: ${primary.score}. Early: ${early.score}. Confirmation: ${confirmation.score}. Only saved choices are scored; no model is automatically trained or promoted.`;
  return {roundId,intervalMinutes,startMs,expiryMs,marketId,outcome,settlementStatus,
    primary,early,confirmation,checkpoint,congruence,learningNote};
}

export async function decisionLineage(query:unknown,now=Date.now(),db:LockDb=researchPool){
  const q=lineageQuery.parse(query),cutoff=now-(q.window==="24h"?86400000:7*86400000);
  // Limit before joining wider history/settlement tables: one bounded DB read,
  // only when the Round History page is opened. No watcher, polling or writes.
  const result=await db.query(`WITH cohort AS (
    SELECT network,round_id,interval_minutes,start_ms,expiry_ms
    FROM waterx_timed_rounds
    WHERE network='sui:mainnet' AND strategy_version=$1
      AND start_ms>=$2 AND start_ms<$3 AND ($4::int IS NULL OR interval_minutes=$4)
    ORDER BY start_ms DESC,interval_minutes,round_id LIMIT $5
  )
  SELECT r.*,sr.market_id,sr.strategy_version AS stage_strategy,sr.stage_match_count,
    td.id AS primary_id,td.decision AS primary_decision,po.decision_id AS primary_outbox_id,
    po.committed_ack_at_ms AS primary_ack,
    e.id AS early_id,e.decision AS early_decision,eo.decision_id AS early_outbox_id,
    eo.committed_ack_at_ms AS early_ack,
    c.id AS confirmation_id,c.decision AS confirmation_decision,co.decision_id AS confirmation_outbox_id,
    co.committed_ack_at_ms AS confirmation_ack,
    ea.reason AS early_reason,ca.reason AS confirmation_reason,
    ch.state AS checkpoint_state,ch.side AS checkpoint_side,
    ch.decision_at_ms AS checkpoint_decision_at,ch.probability_up AS checkpoint_probability_up,
    ch.policy_version AS checkpoint_policy,ch.model_version AS checkpoint_model,
    ch.choice_source AS checkpoint_source,ch.no_choice_reason AS checkpoint_no_choice,
    ch.evidence AS checkpoint_evidence,
    l.outcome,l.label_status,l.settlement_disputed,l.settlement_quarantine,
    l.settled_at,l.first_verified_at,l.settle_price,l.settlement_anchor_price
  FROM cohort r
  LEFT JOIN waterx_timed_decisions td ON td.network=r.network AND td.strategy_version=$1
    AND td.interval_minutes=r.interval_minutes AND td.round_id=r.round_id
  LEFT JOIN waterx_timed_outbox po ON po.decision_id=td.id
  LEFT JOIN LATERAL(
    SELECT x.market_id,x.strategy_version,count(*) OVER()::int AS stage_match_count
    FROM waterx_two_stage_rounds x
    WHERE x.network=r.network AND x.round_id=r.round_id AND x.interval_minutes=r.interval_minutes
      AND x.start_ms=r.start_ms AND x.expiry_ms=r.expiry_ms
      AND x.strategy_version=$6 AND x.capture_mode='PROSPECTIVE'
    ORDER BY x.discovered_at_ms DESC,x.market_id LIMIT 1
  ) sr ON true
  LEFT JOIN waterx_two_stage_locks e ON e.network=r.network AND e.market_id=sr.market_id
    AND e.round_id=r.round_id AND e.interval_minutes=r.interval_minutes
    AND e.strategy_version=sr.strategy_version AND e.lock_stage='EARLY'
  LEFT JOIN waterx_two_stage_outbox eo ON eo.decision_id=e.id
  LEFT JOIN waterx_two_stage_locks c ON c.network=r.network AND c.market_id=sr.market_id
    AND c.round_id=r.round_id AND c.interval_minutes=r.interval_minutes
    AND c.strategy_version=sr.strategy_version AND c.lock_stage='CONFIRMATION'
  LEFT JOIN waterx_two_stage_outbox co ON co.decision_id=c.id
  LEFT JOIN waterx_two_stage_assessments ea ON ea.network=r.network AND ea.market_id=sr.market_id
    AND ea.round_id=r.round_id AND ea.interval_minutes=r.interval_minutes
    AND ea.strategy_version=sr.strategy_version AND ea.stage='EARLY'
  LEFT JOIN waterx_two_stage_assessments ca ON ca.network=r.network AND ca.market_id=sr.market_id
    AND ca.round_id=r.round_id AND ca.interval_minutes=r.interval_minutes
    AND ca.strategy_version=sr.strategy_version AND ca.stage='CONFIRMATION'
  LEFT JOIN waterx_research_choices ch ON ch.interval_minutes=r.interval_minutes
    AND ch.round_id=r.round_id AND ch.start_ms=r.start_ms AND ch.expiry_ms=r.expiry_ms
  LEFT JOIN waterx_learning_rounds l ON l.interval_minutes=r.interval_minutes AND l.round_id=r.round_id
    AND l.start_ms=r.start_ms AND l.expiry_ms=r.expiry_ms
  ORDER BY r.start_ms DESC,r.interval_minutes,r.round_id`,
  [TIMED_STRATEGY,cutoff,now,q.interval==="all"?null:Number(q.interval),q.limit,
    TWO_STAGE_STRATEGY]);
  const rows:LineageRow[]=result.rows.map(raw=>projectLineageRow(raw,now));
  const median=(values:number[])=>values.length?
    [...values].sort((a,b)=>a-b)[Math.floor((values.length-1)/2)]:null;
  const stats=(name:"primary"|"early"|"confirmation")=>{
    const locked=rows.filter(r=>r[name].side!==null);
    const verified=locked.filter(r=>r[name].score==="CORRECT"||r[name].score==="INCORRECT");
    const correct=verified.filter(r=>r[name].score==="CORRECT").length,
      incorrect=verified.length-correct;
    // Diagnostic on frozen source probabilities, never represented as an
    // independently trained/calibrated Bluewater model or live win probability.
    const scoredProbability=verified.filter(r=>r[name].probabilityUp!=null&&
      r[name].probabilityUp!>=0&&r[name].probabilityUp!<=1&&r.outcome!=null);
    const brier=scoredProbability.length?scoredProbability.reduce((acc,r)=>{
      const delta=r[name].probabilityUp!-(r.outcome==="UP"?1:0);
      return acc+delta*delta;
    },0)/scoredProbability.length:null;
    const remaining=locked.filter(r=>r[name].acknowledgedAtMs!=null&&
      r[name].acknowledgedAtMs!>=r.startMs&&r[name].acknowledgedAtMs!<=r.expiryMs)
      .map(r=>(r.expiryMs-r[name].acknowledgedAtMs!)/1000);
    return {locked:locked.length,correct,incorrect,scored:verified.length,
      accuracy:verified.length?correct/verified.length:null,
      coverage:rows.length?locked.length/rows.length:null,
      brier,probabilityScoredN:scoredProbability.length,
      medianSecondsRemainingAtAck:median(remaining)};
  };
  // Descriptive, non-causal timing cohorts: when a *saved* prediction
  // was acknowledged, NOT when any order was executed. Never fabricate
  // win rates from fewer than 20 verified records per identical cohort.
  const timingBands=(["primary","early","confirmation"] as const).flatMap(stage=>
    ([5,15] as const).flatMap(intervalMinutes=>
      (["FIRST_THIRD","MIDDLE_THIRD","LAST_THIRD"] as const).map(band=>{
        const matching=rows.filter(r=>{
          const ack=r[stage].acknowledgedAtMs;
          if(r.intervalMinutes!==intervalMinutes||ack==null||!r[stage].side||
            ack<r.startMs||ack>=r.expiryMs)return false;
          const fraction=(ack-r.startMs)/(r.expiryMs-r.startMs);
          return band==="FIRST_THIRD"?fraction<1/3:
            band==="MIDDLE_THIRD"?fraction>=1/3&&fraction<2/3:fraction>=2/3;
        });
        const scored=matching.filter(r=>["CORRECT","INCORRECT"].includes(r[stage].score));
        const correct=scored.filter(r=>r[stage].score==="CORRECT").length;
        return {stage,intervalMinutes,band,locked:matching.length,
          verifiedN:scored.length,correct,incorrect:scored.length-correct,
          descriptiveAccuracy:scored.length>=20?correct/scored.length:null,
          minimumSampleN:20,
        };
      })));
  const paired=rows.filter(r=>r.primary.side&&r.early.side&&r.settlementStatus==="VERIFIED");
  const confirmedPairs=rows.filter(r=>r.early.side&&r.confirmation.side&&r.settlementStatus==="VERIFIED");
  return {asOfMs:now,window:q.window,interval:q.interval,cohortN:rows.length,
    truncated:rows.length===q.limit,source:"prospectively discovered timed rounds, not all theoretical clock slots",
    stats:{primary:stats("primary"),early:stats("early"),confirmation:stats("confirmation")},
    timingBands,
    paired:{verifiedN:paired.length,agree:paired.filter(r=>r.congruence==="AGREE").length,
      disagree:paired.filter(r=>r.congruence==="DISAGREE").length,
      earlyWrongPrimaryCorrect:paired.filter(r=>r.early.score==="INCORRECT"&&r.primary.score==="CORRECT").length,
      earlyCorrectPrimaryWrong:paired.filter(r=>r.early.score==="CORRECT"&&r.primary.score==="INCORRECT").length,
      earlyConfirmationVerifiedN:confirmedPairs.length,
      confirmationCorrectedEarly:confirmedPairs.filter(r=>r.early.score==="INCORRECT"&&r.confirmation.score==="CORRECT").length,
      confirmationReversedCorrectEarly:confirmedPairs.filter(r=>r.early.score==="CORRECT"&&r.confirmation.score==="INCORRECT").length},
    rows};
}
