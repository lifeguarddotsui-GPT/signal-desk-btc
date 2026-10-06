import { canonicalHistory, historyQuerySchema } from "./canonical-history";
import { getResearchDailyJob, type ResearchTrainingQueryable } from "./research-training";
import { researchPool } from "./research-store";

function iso(value:unknown):string|null {
  if(value===null||value===undefined)return null;
  const at=value instanceof Date?value.getTime():Date.parse(String(value));
  return Number.isFinite(at)?new Date(at).toISOString():null;
}
function json(value:unknown):unknown {
  if(typeof value!=="string")return value;
  try{return JSON.parse(value);}catch{return null;}
}

/** The selected History denominator is reused, not reimplemented. Operational
 * timestamps are interval-wide, while the summary is the chosen closed cohort. */
export async function researchOperations(interval:5|15,query:unknown,now=Date.now(),
  db:ResearchTrainingQueryable=researchPool) {
  const selected=historyQuerySchema.parse(query);
  const history=await canonicalHistory({...selected,interval:String(interval)},now,db);
  if(history.status!=="ok")return history;
  const dailyJob=await getResearchDailyJob(interval,{db});
  const [captures,runs,schema]=await Promise.all([
    db.query(`SELECT max(captured_at) AS last_capture FROM waterx_research_choices
      WHERE interval_minutes=$1 AND state='FROZEN' AND decision_at_ms<expiry_ms`,[interval]),
    db.query(`SELECT status,phases,report FROM waterx_research_daily_runs WHERE interval_minutes=$1
      ORDER BY scheduled_day DESC LIMIT 90`,[interval]),
    db.query(`SELECT to_regclass('waterx_research_artifacts') IS NOT NULL AS artifacts,
      to_regclass('waterx_research_champion_events') IS NOT NULL AS champions`),
  ]);
  const phaseDates=(names:string[])=>{
    const dates=runs.rows.flatMap(r=>{
      const phases=json(r.phases);
      return Array.isArray(phases)?phases.filter(p=>names.includes(p?.status)).map(p=>iso(p.at))
        .filter((at):at is string=>at!==null):[];
    });
    return dates.sort().at(-1)??null;
  };
  let lastCandidateAt:string|null=null,lastPromotionAt:string|null=null;
  if(schema.rows[0]?.artifacts===true){
    const result=await db.query(`SELECT max(created_at) AS at FROM waterx_research_artifacts
      WHERE interval_minutes=$1`,[interval]);
    lastCandidateAt=iso(result.rows[0]?.at);
  }
  if(schema.rows[0]?.champions===true){
    const result=await db.query(`SELECT max(effective_at) AS at FROM waterx_research_champion_events
      WHERE interval_minutes=$1 AND event_type='ACTIVATE'`,[interval]);
    lastPromotionAt=iso(result.rows[0]?.at);
  }
  const blockers:string[]=[];
  if(!captures.rows[0]?.last_capture)blockers.push("No successful prospective frozen capture is recorded.");
  if(dailyJob.reason)blockers.push(dailyJob.reason);
  if(dailyJob.error)blockers.push(dailyJob.error);
  if(!lastCandidateAt)blockers.push("No qualified candidate artifact has been created for this interval.");
  if(!lastPromotionAt)blockers.push("No champion promotion is recorded; champion NO CHOICE is not baseline accuracy.");
  if(!dailyJob.guaranteesDailyExecution)blockers.push("Existing autoscale-process scheduling cannot guarantee a daily wake or continuous capture. No paid persistent worker was provisioned.");
  return {status:"ok" as const,intervalMinutes:interval,asOfMs:now,
    cohort:{intervalMinutes:interval,window:selected.window,source:selected.source},
    summary:history.summary,
    operations:{lastCaptureAt:iso(captures.rows[0]?.last_capture),
      lastTrainingAt:phaseDates(["trained","canonical-trained"]),
      lastCalibrationAt:phaseDates(["calibrated","canonical-calibrated"]),
      lastEvaluationAt:phaseDates(["evaluated","canonical-evaluated"]),
      lastCandidateAt,lastPromotionAt,trainingCount:dailyJob.datasetCount,blockers},
    definitions:{
      history:"Same canonical exact-round projection as History: closed observed rounds, selected source/interval/window; no choice remains unscored. Late but valid prospective baseline choices remain visible.",
      training:"Different eligibility: verified, non-disputed, non-withdrawn prospective frozen choices; 14-day bounded interval-specific cohort, chronological partitions and embargo. Rich models additionally need pre-lock features; probability-only calibration does not. History total is not training eligibility or a champion test denominator. Timestamps are interval-wide; absent stages are null, not inferred.",
    },dailyJob};
}