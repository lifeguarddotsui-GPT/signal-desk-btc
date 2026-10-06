export type HistoryResult = "CORRECT" | "INCORRECT" | "PENDING" | "WITHDRAWN-DISPUTED" | "NO CHOICE";
export type HistorySource = "baseline" | "bluewater" | "fallback";
export type HistoryFact = {
  intervalMinutes:5|15;roundId:string;startMs:number;expiryMs:number;
  choiceState:string|null;side:string|null;probabilityUp:number|null;lockAtMs:number|null;
  modelVersion:string|null;choiceCount:number;
  outcome:string|null;verificationState:string;verifiedOutcome:boolean;disputed:boolean;
};
export function projectHistory(f:HistoryFact,source:HistorySource) {
  const valid=f.choiceCount===1&&f.choiceState==="FROZEN"&&(f.side==="UP"||f.side==="DOWN")&&
    f.probabilityUp!==null&&Number.isFinite(f.probabilityUp)&&f.probabilityUp>=0&&f.probabilityUp<=1&&
    f.lockAtMs!==null&&Number.isSafeInteger(f.lockAtMs)&&f.lockAtMs>=f.startMs&&f.lockAtMs<f.expiryMs;
  const result:HistoryResult=!valid?"NO CHOICE":f.disputed?"WITHDRAWN-DISPUTED":
    !f.verifiedOutcome?"PENDING":f.side===f.outcome?"CORRECT":"INCORRECT";
  return {intervalMinutes:f.intervalMinutes,roundId:f.roundId,startMs:f.startMs,expiryMs:f.expiryMs,
    side:valid?f.side:null,probability:valid?(f.side==="UP"?f.probabilityUp:1-f.probabilityUp!):null,
    source:!valid?(source==="bluewater"?"No champion choice recorded":source==="fallback"?
      "No fallback choice recorded":"No baseline choice recorded"):
      source==="baseline"?"WaterX Market Baseline":source==="fallback"?
      "Deterministic 50/50 research fallback":"Bluewater frozen champion",
    modelVersion:valid?f.modelVersion:null,lockAtMs:valid?f.lockAtMs:null,
    secondsBeforeExpiry:valid?(f.expiryMs-f.lockAtMs!)/1000:null,
    outcome:f.verifiedOutcome&&!f.disputed?f.outcome:null,
    verificationState:f.verificationState,result,
    orderStatus:"NOT_AVAILABLE" as const,collateralSpent:null,receipt:null,realizedPnl:null};
}
export function historySummary(rows:ReturnType<typeof projectHistory>[]) {
  const count=(s:HistoryResult)=>rows.filter(r=>r.result===s).length;
  const correct=count("CORRECT"),incorrect=count("INCORRECT"),pending=count("PENDING"),
    withdrawn=count("WITHDRAWN-DISPUTED"),noChoice=count("NO CHOICE"),scored=correct+incorrect,total=rows.length;
  const frozen=rows.filter(r=>r.side!==null).length;
  return {correct,incorrect,pending,withdrawn,noChoice,scored,total,
    ratio:`${correct}:${incorrect}`,hitRate:scored?correct/scored:null,coverage:total?frozen/total:null};
}