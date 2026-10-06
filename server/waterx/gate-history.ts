import {z} from "zod";
import {TIMED_STRATEGY} from "../../shared/timed-decision";
import {timedPool} from "./timed-db";
export const gateHistoryQuery=z.object({interval:z.enum(["5","15"]).default("5"),
 roundId:z.string().uuid().optional()}).strict();
export async function gateHistory(query:unknown){
 const q=gateHistoryQuery.parse(query);
 const r=await timedPool.query(`SELECT round_id,start_ms,expiry_ms FROM waterx_timed_rounds
 WHERE strategy_version=$1 AND interval_minutes=$2 AND($3::text IS NULL OR round_id=$3)
 ORDER BY start_ms DESC LIMIT 1`,[TIMED_STRATEGY,Number(q.interval),q.roundId??null]);
 if(!r.rows.length)return {strategyVersion:TIMED_STRATEGY,round:null,entries:[]};
 const round=r.rows[0];
 const gates=await timedPool.query(`SELECT journal FROM waterx_gate_journals WHERE strategy_version=$1
 AND interval_minutes=$2 AND round_id=$3 ORDER BY gate_index LIMIT 29`,[TIMED_STRATEGY,Number(q.interval),round.round_id]);
 return {strategyVersion:TIMED_STRATEGY,round,entries:gates.rows.map(r=>r.journal),
 semantics:"Prospective gate journals. Repeated gates are correlated, not independent predictions."};
}
