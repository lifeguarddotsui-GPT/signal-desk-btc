/** Operational 1–10 timing rubric: NOT a trade probability, model edge, or
 * evidence of an optimal profit time. It measures only how much of the round
 * remains for gathering observations and executing a manually reviewed order.
 * No backend polling, custody or trading authority.
 */
export type TimingPhase="NOT_OPEN"|"TOO_EARLY"|"OBSERVE"|"REVIEW_WINDOW"|"LATE"|"CLOSED";
export type TimingWindow={
  phase:TimingPhase;score:number;label:string;description:string;
  elapsedPercent:number;remainingSeconds:number;
  quality:"OPERATIONAL_HEURISTIC_ONLY";
};
export function operationalTimingWindow(input:{startMs:number;expiryMs:number;nowMs:number}):TimingWindow{
  const {startMs,expiryMs,nowMs}=input;
  if(![startMs,expiryMs,nowMs].every(Number.isFinite)||expiryMs<=startMs)
    throw new Error("Invalid round bounds");
  const duration=expiryMs-startMs,remainingMs=expiryMs-nowMs;
  const elapsedPercent=Math.min(100,Math.max(0,100*(nowMs-startMs)/duration));
  const remainingSeconds=Math.max(0,Math.ceil(remainingMs/1000));
  const ratio=remainingMs/duration;
  let phase:TimingPhase,score:number,label:string,description:string;
  if(nowMs<startMs){phase="NOT_OPEN";score=1;label="WAIT FOR ROUND";description="The next round has not started.";}
  else if(remainingMs<=0){phase="CLOSED";score=1;label="ROUND CLOSED";description="No time remains for an entry.";}
  else if(remainingMs<=45_000){phase="LATE";score=1;label="LATE · EXECUTION RISK";description="The remaining window is too short to assume a fill.";}
  else if(ratio>.90){phase="TOO_EARLY";score=3;label="VERY EARLY · LOW EVIDENCE";description="Very little of this round has elapsed; market direction can reverse.";}
  else if(ratio>.70){phase="OBSERVE";score=6;label="EARLY · WATCH FOR STABILITY";description="There is room for a favorable payout, but early direction has limited evidence.";}
  else if(ratio>=.35){phase="REVIEW_WINDOW";score=8;label="MID-ROUND · TIME TO EVALUATE";description="Enough time has elapsed to examine price movement while leaving execution time.";}
  else if(ratio>=.20){phase="REVIEW_WINDOW";score=7;label="LATER · CHECK QUOTE CAREFULLY";description="More market information is available, but odds may be costly and fill time is shrinking.";}
  else {phase="LATE";score=3;label="LATE · HIGH TIMING RISK";description="Waiting further may improve apparent certainty but leaves little execution margin.";}
  return{phase,score,label,description,elapsedPercent,remainingSeconds,quality:"OPERATIONAL_HEURISTIC_ONLY"};
}
