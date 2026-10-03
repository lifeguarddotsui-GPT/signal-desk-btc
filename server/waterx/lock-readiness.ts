import type { LockObservation, LockPolicy, LockReadiness, LockLatency } from "../../shared/lock-readiness";

const clamp=(n:number)=>Math.max(0,Math.min(1,n));
export function validateLockPolicy(p:LockPolicy) {
  const fields=["intervalMinutes","fallbackSeconds","maxAgeMs","maxGapMs","earlyStrength","lateStrength",
    "earlyPersistenceMs","latePersistenceMs","stabilityWindowMs","maxRange","reversalWindowMs",
    "minObservations","maxVelocity","maxAcceleration","captureGraceMs"] as const;
  if(!p.version || ![5,15].includes(p.intervalMinutes) ||
    p.fallbackSeconds!==(p.intervalMinutes===5?60:180) ||
    JSON.stringify(p.windows)!==JSON.stringify(p.intervalMinutes===5?[120,90,60]:[360,300,240,180]) ||
    !fields.every(k=>Number.isFinite(p[k])&&p[k]>0) ||
    p.earlyStrength<p.lateStrength || p.lateStrength<=0.5 || p.earlyStrength>=1 ||
    p.earlyPersistenceMs<p.latePersistenceMs || p.maxRange>=1 ||
    p.captureGraceMs!==5000 || p.maxAgeMs>10000 || p.maxGapMs>15000 ||
    p.minObservations<3 || !Number.isInteger(p.minObservations) ||
    !Number.isInteger(p.maxReversals)||p.maxReversals<0)throw new Error("Invalid pinned adaptive lock policy.");
  return p;
}
/** Only observed, ordered samples. Gaps reset persistence; missing samples are never interpolated. */
export function evaluateLockReadiness(p:LockPolicy,startMs:number,expiryMs:number,
  observations:readonly LockObservation[],now:number):LockReadiness {
  validateLockPolicy(p);
  if(!Number.isSafeInteger(now)||expiryMs-startMs!==p.intervalMinutes*60000)
    throw new Error("Invalid exact round/time for lock readiness.");
  const rows=observations.filter(o=>o.atMs>=startMs&&o.atMs<=now&&o.receivedAtMs<=now&&
    o.receivedAtMs<=o.atMs&&o.atMs<expiryMs&&Number.isFinite(o.probabilityUp)&&
    Number.isFinite(o.probabilityDown)&&o.probabilityUp>=0&&o.probabilityUp<=1&&
    o.probabilityDown>=0&&o.probabilityDown<=1&&
    Math.abs(o.probabilityUp+o.probabilityDown-1)<=1e-6&&
    (o.providerSourceAtMs===null||o.providerSourceAtMs<=o.receivedAtMs))
    .slice().sort((a,b)=>a.atMs-b.atMs);
  if(rows.some((r,i)=>i>0&&r.atMs===rows[i-1].atMs))throw new Error("Duplicate observation timestamp.");
  const latest=rows.at(-1), remaining=(expiryMs-now)/1000;
  const earliest=expiryMs-p.windows[0]*1000, fallback=expiryMs-p.fallbackSeconds*1000;
  const progress=clamp((now-earliest)/(fallback-earliest));
  const strengthRequired=p.earlyStrength+(p.lateStrength-p.earlyStrength)*progress;
  const persistenceRequired=p.earlyPersistenceMs+(p.latePersistenceMs-p.earlyPersistenceMs)*progress;
  const side=latest?(latest.probabilityUp>=latest.probabilityDown?"UP":"DOWN"):null;
  const preferred=(o:LockObservation)=>o.probabilityUp>=o.probabilityDown?"UP":"DOWN";
  let since=latest?.atMs??now,gapReset=false;
  for(let i=rows.length-2;i>=0;i--){
    if(rows[i+1].atMs-rows[i].atMs>p.maxGapMs){gapReset=true;break;}
    if(preferred(rows[i])!==side||!rows[i].sourceHealthy)break;
    since=rows[i].atMs;
  }
  // Duration ends at the latest real observation, never at the reporting clock.
  const persistence=latest?latest.atMs-since:0;
  const recent=rows.filter(o=>o.atMs>=now-p.stabilityWindowMs);
  const span=recent.length?Math.max(...recent.map(o=>o.probabilityUp))-Math.min(...recent.map(o=>o.probabilityUp)):null;
  let reversals=0;
  rows.forEach((o,i)=>{if(i&&o.atMs>=now-p.reversalWindowMs&&preferred(o)!==preferred(rows[i-1]))reversals++;});
  const last=rows.at(-2), before=rows.at(-3);
  const velocity=latest&&last?(latest.probabilityUp-last.probabilityUp)/((latest.atMs-last.atMs)/1000):null;
  const priorVelocity=last&&before?(last.probabilityUp-before.probabilityUp)/((last.atMs-before.atMs)/1000):null;
  const acceleration=velocity!==null&&priorVelocity!==null&&latest&&last?
    (velocity-priorVelocity)/((latest.atMs-last.atMs)/1000):null;
  const age=latest?now-latest.receivedAtMs:null,healthy=!!latest?.sourceHealthy;
  const fresh=age!==null&&age<=p.maxAgeMs&&(latest?.providerSourceAtMs===null||
    now-latest!.providerSourceAtMs!<=p.maxAgeMs);
  const within=now>=earliest&&now<fallback;
  const strength=latest?Math.max(latest.probabilityUp,latest.probabilityDown):0;
  const stable=span!==null&&span<=p.maxRange&&recent.length>=p.minObservations&&
    reversals<=p.maxReversals&&(velocity===null||Math.abs(velocity)<=p.maxVelocity)&&
    (acceleration===null||Math.abs(acceleration)<=p.maxAcceleration);
  const ready=within&&fresh&&healthy&&strength>=strengthRequired&&persistence>=persistenceRequired&&stable;
  const score=Math.round(100*(.35*clamp((strength-.5)/(strengthRequired-.5))+
    .30*clamp(persistence/persistenceRequired)+.20*(stable?1:0)+.10*(fresh?1:0)+.05*(healthy?1:0)));
  let reason=ready?"Early-lock rule satisfied; shadow candidate only."
    :!fresh?"Waiting for fresh WaterX observation":!healthy?"WaterX source health is unavailable"
    :now>=fallback?"Early window ended; canonical fallback remains unchanged"
    :now<earliest?`Waiting for permitted early window (${((earliest-now)/1000).toFixed(1)}s)`
    :strength<strengthRequired?"Needs stronger directional separation"
    :gapReset&&persistence<persistenceRequired?"Observation gap reset stability timer"
    :persistence<persistenceRequired?
      (reversals?`Recent reversal reset stability timer; waiting ${((persistenceRequired-persistence)/1000).toFixed(1)}s`:
        `Waiting for ${((persistenceRequired-persistence)/1000).toFixed(1)}s more directional stability`)
    :recent.length<p.minObservations?"Needs more fresh stability observations"
    :reversals>p.maxReversals?"Too many recent side reversals"
    :!stable?"Recent probability oscillation exceeds stability limits":"Waiting for evidence";
  const durationSlope=(p.earlyPersistenceMs-p.latePersistenceMs)/(fallback-earliest);
  const persistenceAt=(since+p.earlyPersistenceMs+durationSlope*earliest)/(1+durationSlope);
  const strengthAt=strength>=p.earlyStrength?earliest:strength<p.lateStrength?Infinity:
    earliest+(p.earlyStrength-strength)/(p.earlyStrength-p.lateStrength)*(fallback-earliest);
  const conditionalAt=Math.ceil(Math.max(now,earliest,persistenceAt,strengthAt));
  gapReset=gapReset&&persistence<persistenceRequired;
  return {state:ready?"READY":!fresh||!healthy||!latest?"WATCHING":
    strength>=strengthRequired?"BUILDING LOCK":"LEANING",
    score:ready?100:Math.min(99,score),side,probability:latest?strength:null,
    evaluatedAtMs:now,secondsRemaining:remaining,sameSideMs:persistence,
    earliestPossibleAtMs:latest&&healthy&&fresh&&stable&&conditionalAt<fallback?conditionalAt:null,
    reason,health:!fresh||!healthy||gapReset?"DATA/COLLECTOR DELAY":"WAITING FOR EVIDENCE",
    components:{strength,requiredStrength:strengthRequired,persistenceMs:persistence,
      requiredPersistenceMs:persistenceRequired,range:span,reversals,observationCount:recent.length,
      ageMs:age,gapReset,velocity,acceleration,sourceHealthy:healthy,withinWindow:within,fresh,stable}};
}
export function lockLatency(kind:LockLatency["kind"],o:LockObservation,
  evaluationAtMs:number,transactionStartMs:number,committedAtMs:number):LockLatency {
  if(o.receivedAtMs>evaluationAtMs||evaluationAtMs>transactionStartMs||transactionStartMs>committedAtMs)
    throw new Error("Latency stages out of order.");
  return {kind,measurementVersion:"final-write-v1",providerSourceAtMs:o.providerSourceAtMs,receivedAtMs:o.receivedAtMs,
    evaluationAtMs,transactionStartMs,committedAtMs,
    providerToReceiptMs:o.providerSourceAtMs===null?null:o.receivedAtMs-o.providerSourceAtMs,
    receiptToEvaluationMs:evaluationAtMs-o.receivedAtMs,
    evaluationToTransactionMs:transactionStartMs-evaluationAtMs,
    commitMs:committedAtMs-transactionStartMs,totalMs:committedAtMs-o.receivedAtMs};
}