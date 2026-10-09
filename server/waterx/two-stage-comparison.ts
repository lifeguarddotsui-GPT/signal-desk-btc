import type {LockDb} from "./lock-store";
import {TWO_STAGE_STRATEGY,type TwoStageRoundRow,type StageLock} from "../../shared/two-stage";
import {TIMED_STRATEGY,type TimedDecision} from "../../shared/timed-decision";
import {EVENT_LOCK_STRATEGY,type EventObservation} from "../../shared/event-lock";
import {metrics} from "./bluewater-metrics";
import {economicEvidenceFromFeatures} from "../../shared/lock-economics";
type Forecast={side:"UP"|"DOWN";probabilityUp:number;elapsedMs:number;clockDomain:string|null;economics:unknown};
const key=(r:TwoStageRoundRow)=>`${r.strategyVersion??TWO_STAGE_STRATEGY}:${r.intervalMinutes}:${r.roundId}:${r.startMs}:${r.expiryMs}`;
export async function compareTwoStage(rows:TwoStageRoundRow[],db:LockDb){
  const facts=new Map<string,{market:Forecast|null;active:Forecast|null;event:Forecast|null}>();
  if(rows.length){
    const result=await db.query(`SELECT r.strategy_version,r.interval_minutes,r.round_id,r.start_ms,r.expiry_ms,r.market_id,
      a.decision AS active,e.decision AS event,o.input AS first_input
      FROM waterx_two_stage_rounds r
      LEFT JOIN waterx_timed_decisions a ON a.network=r.network AND a.strategy_version=$2
        AND a.interval_minutes=r.interval_minutes AND a.round_id=r.round_id AND a.decision->>'status'='LOCKED'
        AND (a.decision->>'startMs')::bigint=r.start_ms AND (a.decision->>'expiryMs')::bigint=r.expiry_ms
      LEFT JOIN waterx_timed_decisions e ON e.network=r.network AND e.strategy_version=$3
        AND e.interval_minutes=r.interval_minutes AND e.round_id=r.round_id AND e.decision->>'status'='LOCKED'
        AND (e.decision->>'startMs')::bigint=r.start_ms AND (e.decision->>'expiryMs')::bigint=r.expiry_ms
      LEFT JOIN LATERAL (SELECT input FROM waterx_two_stage_observations p WHERE p.network=r.network
        AND p.market_id=r.market_id AND p.round_id=r.round_id AND p.interval_minutes=r.interval_minutes
        AND p.strategy_version=r.strategy_version AND p.input->>'sourceHealthy'='true'
        AND p.input->>'provenance'='PROSPECTIVE' AND p.available_at_ms<r.expiry_ms
        ORDER BY p.available_at_ms,p.received_at_ms LIMIT 1) o ON true
      WHERE r.strategy_version=ANY($1::text[]) AND r.capture_mode='PROSPECTIVE' AND r.start_ms>=$4 AND r.start_ms<=$5`,
      [Array.from(new Set(rows.map(r=>r.strategyVersion??TWO_STAGE_STRATEGY))),TIMED_STRATEGY,EVENT_LOCK_STRATEGY,Math.min(...rows.map(r=>r.startMs)),Math.max(...rows.map(r=>r.startMs))]);
    const existing=(d:unknown):Forecast|null=>{
      const p=d as TimedDecision|null;if(!p||p.status!=="LOCKED"||!p.side||p.probabilityUp==null)return null;
      return {side:p.side,probabilityUp:p.probabilityUp,elapsedMs:p.elapsedMs,
        clockDomain:typeof p.evidence?.clockDomain==="string"?p.evidence.clockDomain:null,
        economics:p.evidence?.entryEconomics??null};
    };
    for(const r of result.rows){
      const o=r.first_input as EventObservation|null;
      const market=o&&o.probabilityUp!==.5&&Number.isFinite(o.probabilityUp)?{
        side:o.probabilityUp>.5?"UP" as const:"DOWN" as const,probabilityUp:o.probabilityUp,
        elapsedMs:o.availableAtMs-Number(r.start_ms),clockDomain:typeof o.features.decisionClockDomain==="string"?o.features.decisionClockDomain:null,
        economics:economicEvidenceFromFeatures(o.features,String(r.round_id),o.probabilityUp>.5?"UP":"DOWN",o.availableAtMs)}:null;
      facts.set(`${r.strategy_version}:${r.interval_minutes}:${r.round_id}:${r.start_ms}:${r.expiry_ms}`,{market,active:existing(r.active),event:existing(r.event)});
    }
  }
  const stage=(d:StageLock|null):Forecast|null=>d?{side:d.side,probabilityUp:d.probabilityUp,elapsedMs:d.elapsedMs,
    clockDomain:(d.coverage as {clockDomain?:string})?.clockDomain??null,economics:d.economics}:null;
  const summaries=Object.fromEntries(["market","active","event","early","confirmation"].map(name=>{
    const selected=rows.flatMap(r=>{
      const f=name==="early"?stage(r.early):name==="confirmation"?stage(r.confirmation):
        facts.get(key(r))?.[name as "market"|"active"|"event"];
      return f?[{r,f}]:[];
    });
    const scored=selected.filter(p=>p.r.outcome&&!p.r.disputed);
    const times=selected.map(p=>p.f.elapsedMs).sort((a,b)=>a-b);
    return [name,{cohortN:rows.length,decisionN:selected.length,coverage:rows.length?selected.length/rows.length:null,
      timingN:times.length,medianElapsedMs:times.length?times[Math.ceil(times.length/2)-1]:null,
      p90ElapsedMs:times.length?times[Math.ceil(times.length*.9)-1]:null,
      forecasts:metrics(scored.map(p=>({probability:p.f.probabilityUp,outcome:p.r.outcome!}))),
      indicativeEconomics:selected.map(p=>({round:p.r.roundId,interval:p.r.intervalMinutes,economics:p.f.economics})),
      actualTradingPnl:null}];
  }));
  const matched=Object.fromEntries(["early","confirmation"].map(name=>{
    const same=rows.flatMap(r=>{
      const a=stage(name==="early"?r.early:r.confirmation),b=facts.get(key(r))?.active;
      return a&&b&&r.outcome&&!r.disputed?[{a,b,outcome:r.outcome}]:[];
    });
    const gains=same.filter(p=>p.a.clockDomain&&p.a.clockDomain===p.b.clockDomain)
      .map(p=>(p.b.elapsedMs-p.a.elapsedMs)/1000).sort((a,b)=>a-b);
    return [name,{n:same.length,stage:metrics(same.map(p=>({probability:p.a.probabilityUp,outcome:p.outcome}))),
      active:metrics(same.map(p=>({probability:p.b.probabilityUp,outcome:p.outcome}))),
      sameClockTimingN:gains.length,medianSecondsEarlier:gains.length?gains[Math.ceil(gains.length/2)-1]:null}];
  }));
  return {status:"PROSPECTIVE_SHADOW_CAPTURE",automaticPromotion:false,promotion:"NOT_AUTHORIZED",
    modelEdge:"NOT_ESTABLISHED",cohortN:rows.length,summaries,matched,
    priceAreaAblation:{status:"NOT_QUALIFIED_NO_PROSPECTIVE_MODEL_DECISIONS",comparison:null},
    uncertainty:"Accuracy/Brier are descriptive forecasts, not independently established model calibration or profit. Paired timing requires matching process clocks.",
    realizedProfit:null,drawdown:null};
}
