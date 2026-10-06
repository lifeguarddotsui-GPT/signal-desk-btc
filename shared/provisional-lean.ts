import type {LockObservation} from "./lock-readiness";
import {validWaterxProbabilityPair} from "./round-decision";

/** Display-only hysteresis. Qualification always uses raw observations, not this retained side. */
export const LEAN_VERSION="waterx-provisional-hysteresis-v1";
export function provisionalLean(rows:readonly LockObservation[],now:number,startMs:number,
  previous?:{side:"UP"|"DOWN"|null;receivedAtMs:number|null}){
  let side:"UP"|"DOWN"|null=previous?.side??null,last:number|null=previous?.receivedAtMs??null;
  for(const row of rows){
    if(row.receivedAtMs<startMs||row.receivedAtMs>now||!row.sourceHealthy||
      !validWaterxProbabilityPair(row.probabilityUp,row.probabilityDown))continue;
    if(last!==null&&row.receivedAtMs<=last)continue;
    if(last!==null&&row.receivedAtMs-last>10000)side=null;
    if(row.probabilityUp===.5)side=null;
    else if(side===null)side=row.probabilityUp>.5?"UP":"DOWN";
    else if(side==="UP"&&row.probabilityUp<=.48)side="DOWN";
    else if(side==="DOWN"&&row.probabilityUp>=.52)side="UP";
    last=row.receivedAtMs;
  }
  return {version:LEAN_VERSION,side:last===null||now-last>10000?null:side,
    receivedAtMs:last,semantics:"Display hysteresis only; raw reversals reset gate persistence"};
}
