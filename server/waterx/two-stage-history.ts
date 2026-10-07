import {z} from "zod";
import type {LockDb} from "./lock-store";
import {researchPool} from "./research-store";
import {TWO_STAGE_STRATEGY,PREVIOUS_TWO_STAGE_STRATEGY,stageRelationship,type TwoStageHistory,type TwoStageRoundRow,type StageStats,type StageLock} from "../../shared/two-stage";
import {TIMED_STRATEGY} from "../../shared/timed-decision";
import {historyTimeRange} from "./timed-history";
import {metrics as forecastMetrics} from "./bluewater-metrics";
import {twoStageRuntime} from "./two-stage-runtime";
import {compareTwoStage} from "./two-stage-comparison";
export const stageHistoryQuery=z.object({
  interval:z.enum(["all","5","15"]).default("all"),window:z.enum(["today","24h","7d","custom"]).default("today"),
  timezoneOffsetMinutes:z.coerce.number().int().min(-840).max(840).default(0),
  fromMs:z.coerce.number().int().nonnegative().optional(),toMs:z.coerce.number().int().nonnegative().optional(),
  limit:z.coerce.number().int().min(1).max(200).default(100),
  strategy:z.enum(["current","previous","all"]).default("current"),
}).strict().superRefine((q,ctx)=>{if(q.window==="custom"&&(q.fromMs==null||q.toMs==null||q.fromMs>=q.toMs||
  q.toMs-q.fromMs>366*86400000))ctx.addIssue({code:"custom",message:"Review a custom range no longer than 366 days."});});
const percentile=(v:number[],p:number)=>v.length?[...v].sort((a,b)=>a-b)[Math.ceil(v.length*p)-1]:null;
export function scoreStageRounds(rows:TwoStageRoundRow[]){
  const paired:TwoStageHistory["paired"]={BOTH_CORRECT:0,EARLY_WRONG_CONFIRMATION_CORRECT:0,
    EARLY_CORRECT_CONFIRMATION_WRONG:0,BOTH_WRONG:0,BOTH_PENDING_OR_DISPUTED:0,EARLY_ONLY:0,CONFIRMATION_ONLY:0,NEITHER:0};
  for(const r of rows){
    if(!r.early&&!r.confirmation)paired.NEITHER++;
    else if(!r.early)paired.CONFIRMATION_ONLY++;
    else if(!r.confirmation)paired.EARLY_ONLY++;
    else if(!r.outcome||r.disputed)paired.BOTH_PENDING_OR_DISPUTED++;
    else if(r.early.side===r.outcome&&r.confirmation.side===r.outcome)paired.BOTH_CORRECT++;
    else if(r.early.side!==r.outcome&&r.confirmation.side===r.outcome)paired.EARLY_WRONG_CONFIRMATION_CORRECT++;
    else if(r.early.side===r.outcome)paired.EARLY_CORRECT_CONFIRMATION_WRONG++;
    else paired.BOTH_WRONG++;
  }
  const stats=(stage:"early"|"confirmation"):StageStats=>{
    const locks=rows.filter(r=>r[stage]),scored=locks.filter(r=>r.outcome&&!r.disputed);
    const correct=scored.filter(r=>r[stage]!.side===r.outcome).length;
    const calibrated=scored.filter(r=>r[stage]!.calibrationStatus==="QUALIFIED"&&r[stage]!.modelVersion);
    const metric=forecastMetrics(calibrated.map(r=>({probability:r[stage]!.probabilityUp,outcome:r.outcome!})));
     const elapsed=(r:TwoStageRoundRow)=>r[stage]!.committedAtMs==null?null:
       Math.max(0,r[stage]!.committedAtMs!-r.startMs);
     const times=locks.flatMap(r=>elapsed(r)==null?[]:[elapsed(r)!]);
    return {correct,incorrect:scored.length-correct,pending:locks.filter(r=>!r.outcome&&!r.disputed).length,
      disputed:locks.filter(r=>r.disputed).length,scoredN:scored.length,accuracy:scored.length?correct/scored.length:null,
      locks:locks.length,cohortN:rows.length,coverage:rows.length?locks.length/rows.length:null,
      medianElapsedMs:percentile(times,.5),p90ElapsedMs:percentile(times,.9),brier:metric.brier,
      calibration:calibrated.length?{n:calibrated.length,bins:metric.calibration}:null,
      indicativeN:locks.filter(r=>r[stage]!.economics.kind==="INDICATIVE").length,
       verifiedQuoteN:locks.filter(r=>r[stage]!.economics.kind==="VERIFIED_QUOTE").length,actualTradingPnl:null,
       timingN:times.length,timingUnknownN:locks.length-times.length,timingBasis:"APPLICATION_COMMIT_ACKNOWLEDGEMENT_NOT_WAL_COMMIT",
       earlyWindows:(rows.length&&rows.every(r=>r.intervalMinutes===15)?[60,120,180,300]:[30,60,90,120]).map(seconds=>{
         const n=locks.filter(r=>elapsed(r)!=null&&elapsed(r)!<=seconds*1000).length;
         return {seconds,locks:n,rate:rows.length?n/rows.length:null};
       })};
  };
  return {early:stats("early"),confirmation:stats("confirmation"),paired};
}
export async function twoStageHistory(query:unknown,now=Date.now(),db:LockDb=researchPool):Promise<TwoStageHistory>{
  const q=stageHistoryQuery.parse(query),{since,until}=historyTimeRange({...q,strategy:"all",deployment:"all"},now);
  const strategies=q.strategy==="all"?[TWO_STAGE_STRATEGY,PREVIOUS_TWO_STAGE_STRATEGY]:
    [q.strategy==="previous"?PREVIOUS_TWO_STAGE_STRATEGY:TWO_STAGE_STRATEGY];
  const result=await db.query(`SELECT r.*,CASE WHEN eo.decision_id IS NOT NULL THEN e.decision END AS early,
    CASE WHEN co.decision_id IS NOT NULL THEN c.decision END AS confirmation,
    eo.committed_ack_at_ms AS early_ack,co.committed_ack_at_ms AS confirmation_ack,
    a.reason AS early_reason,b.reason AS confirmation_reason,
    coalesce(a.data_failure,false) OR coalesce(b.data_failure,false) AS data_failure,
    l.settlement_disputed AS disputed,
    CASE WHEN l.label_status='verified' AND NOT l.settlement_disputed AND
      (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb) AND l.settled_at>r.expiry_ms
      AND l.settled_at<=$5 AND l.first_verified_at<=to_timestamp($5::double precision/1000)
      AND l.settle_price>0 AND l.settlement_anchor_price>0 AND l.settle_price<'Infinity'::float8
      AND l.settlement_anchor_price<'Infinity'::float8 AND
      ((upper(l.outcome)='UP' AND l.settle_price>=l.settlement_anchor_price) OR
      (upper(l.outcome)='DOWN' AND l.settle_price<l.settlement_anchor_price))
      THEN upper(l.outcome) END AS verified_outcome
    FROM waterx_two_stage_rounds r
    LEFT JOIN waterx_two_stage_locks e ON e.network=r.network AND e.market_id=r.market_id AND e.round_id=r.round_id
      AND e.interval_minutes=r.interval_minutes AND e.strategy_version=r.strategy_version AND e.lock_stage='EARLY'
    LEFT JOIN waterx_two_stage_locks c ON c.network=r.network AND c.market_id=r.market_id AND c.round_id=r.round_id
      AND c.interval_minutes=r.interval_minutes AND c.strategy_version=r.strategy_version AND c.lock_stage='CONFIRMATION'
    LEFT JOIN waterx_two_stage_outbox eo ON eo.decision_id=e.id LEFT JOIN waterx_two_stage_outbox co ON co.decision_id=c.id
    LEFT JOIN waterx_two_stage_assessments a ON a.network=r.network AND a.market_id=r.market_id AND a.round_id=r.round_id
      AND a.interval_minutes=r.interval_minutes AND a.strategy_version=r.strategy_version AND a.stage='EARLY'
    LEFT JOIN waterx_two_stage_assessments b ON b.network=r.network AND b.market_id=r.market_id AND b.round_id=r.round_id
      AND b.interval_minutes=r.interval_minutes AND b.strategy_version=r.strategy_version AND b.stage='CONFIRMATION'
    LEFT JOIN waterx_learning_rounds l ON l.interval_minutes=r.interval_minutes AND l.round_id=r.round_id
      AND l.start_ms=r.start_ms AND l.expiry_ms=r.expiry_ms
     WHERE r.network='sui:mainnet' AND r.strategy_version=ANY($1::text[]) AND r.capture_mode='PROSPECTIVE'
      AND ($2::int IS NULL OR r.interval_minutes=$2) AND r.start_ms>=$3 AND r.start_ms<$4
    ORDER BY r.start_ms DESC,r.interval_minutes,r.market_id,r.round_id`,
     [strategies,q.interval==="all"?null:Number(q.interval),since,until,now]);
  const lock=(d:StageLock|null,ack:unknown)=>d?{...d,commitVerified:true as const,committedAtMs:ack==null?null:Number(ack)}:null;
  const rows:TwoStageRoundRow[]=result.rows.map(r=>{
    const early=lock(r.early as StageLock|null,r.early_ack),confirmation=lock(r.confirmation as StageLock|null,r.confirmation_ack);
     return {roundId:String(r.round_id),marketId:String(r.market_id),strategyVersion:String(r.strategy_version),
       captureBuildId:String(r.capture_build_id??"LEGACY_UNKNOWN"),intervalMinutes:Number(r.interval_minutes) as 5|15,
      startMs:Number(r.start_ms),expiryMs:Number(r.expiry_ms),early,confirmation,
      outcome:r.verified_outcome as "UP"|"DOWN"|null,disputed:r.disputed===true,dataFailure:r.data_failure===true,
      relationship:stageRelationship(early,confirmation),earlyReason:String(r.early_reason??"ASSESSMENT_NOT_RECORDED"),
      confirmationReason:String(r.confirmation_reason??"ASSESSMENT_NOT_RECORDED")};
  });
  const training=await db.query(`SELECT DISTINCT ON(interval_minutes) interval_minutes,report
    FROM waterx_two_stage_training ORDER BY interval_minutes,created_at_ms DESC`);
  const launch=await db.query(`SELECT min(discovered_at_ms) AS at FROM waterx_two_stage_rounds
     WHERE strategy_version=ANY($1::text[]) AND capture_mode='PROSPECTIVE'`,[strategies]);
  const expected=await db.query(`SELECT count(*)::int AS expected,count(*) FILTER(WHERE NOT EXISTS(
       SELECT 1 FROM waterx_two_stage_rounds s WHERE s.network=r.network AND s.strategy_version=ANY($6::text[])
      AND s.interval_minutes=r.interval_minutes AND s.round_id=r.round_id AND s.start_ms=r.start_ms
      AND s.expiry_ms=r.expiry_ms AND s.capture_mode='PROSPECTIVE'))::int AS missing
    FROM waterx_timed_rounds r WHERE r.network='sui:mainnet' AND r.strategy_version=$1
      AND ($2::int IS NULL OR r.interval_minutes=$2) AND r.start_ms>=$3 AND r.start_ms<$4 AND r.start_ms<=$5
      AND r.expiry_ms>$7`,
     [TIMED_STRATEGY,q.interval==="all"?null:Number(q.interval),since,until,now,strategies,launch.rows[0]?.at??now]);
  const expectedN=Number(expected.rows[0]?.expected??0),missingN=Number(expected.rows[0]?.missing??0);
  const failures=await db.query(`SELECT o.interval_minutes,coalesce(o.input#>>'{features,sourceFailure}',
      'INVALID_OR_UNAVAILABLE_PROBABILITY_PAIR') AS cause,count(*)::int AS events,count(DISTINCT o.round_id)::int AS rounds
    FROM waterx_two_stage_observations o JOIN waterx_two_stage_rounds r ON r.network=o.network AND
      r.market_id=o.market_id AND r.round_id=o.round_id AND r.interval_minutes=o.interval_minutes AND
      r.strategy_version=o.strategy_version WHERE r.capture_mode='PROSPECTIVE' AND r.network='sui:mainnet'
      AND r.strategy_version=ANY($1::text[]) AND ($2::int IS NULL OR r.interval_minutes=$2)
      AND r.start_ms>=$3 AND r.start_ms<$4 AND o.input->>'sourceHealthy'='false'
    GROUP BY o.interval_minutes,coalesce(o.input#>>'{features,sourceFailure}','INVALID_OR_UNAVAILABLE_PROBABILITY_PAIR')`,
    [strategies,q.interval==="all"?null:Number(q.interval),since,until]);
   const grouped=(key:(r:TwoStageRoundRow)=>string)=>Array.from(new Set(rows.map(key))).map(k=>{
     const cohort=rows.filter(r=>key(r)===k);return {key:k,cohortN:cohort.length,...scoreStageRounds(cohort)};
   });
   return {strategyVersion:q.strategy==="all"?"all-versioned-shadow-rounds":strategies[0],asOfMs:now,shadowOnly:true,activeStrategy:TIMED_STRATEGY,
    cohort:{interval:q.interval,window:q.window,timezoneOffsetMinutes:q.timezoneOffsetMinutes,
      denominator:"CAPTURED_EXACT_SHADOW_ROUNDS_NOT_EXPECTED_TIME_SLOTS",cohortN:rows.length},
    ...scoreStageRounds(rows),dataFailureRate:rows.length?rows.filter(r=>r.dataFailure).length/rows.length:null,
    missingRecordRate:expectedN?missingN/expectedN:null,expectedCohortN:expectedN,
    missingRecordDenominator:"DISCOVERED_ACTIVE_STRATEGY_EXACT_ROUNDS; capture presence, not lock presence",
    rows:rows.slice(0,q.limit),rowsTruncated:rows.length>q.limit,
     breakdown:{byInterval:grouped(r=>`${r.strategyVersion}:${r.intervalMinutes}`),byStrategy:grouped(r=>r.strategyVersion??"unknown"),
       byBuild:grouped(r=>`${String((r.early?.coverage as {deploymentId?:string})?.deploymentId??
         (r.confirmation?.coverage as {deploymentId?:string})?.deploymentId??r.captureBuildId??"NO_LOCK_BUILD_UNAVAILABLE")}:${r.intervalMinutes}`),
       failureCauses:failures.rows,
       note:"All-version totals are correlated versioned round records; interval-specific windows are authoritative. No-lock build identity is unavailable in legacy records."},
    learning:training.rows.length?training.rows:{status:"NOT_RUN",reason:"Separate stage selection/calibration and full-size economic terms not yet qualified."},
    comparison:{...await compareTwoStage(rows,db),
      runtime:twoStageRuntime.health(),quoteAdjustedExpectedProfit:null,
      note:"Data failures are overlapping diagnostic rounds, not added to paired outcome totals. A missing lock is not a missing round record."}};
}
