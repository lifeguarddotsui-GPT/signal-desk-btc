import {timedPolicy} from "../../shared/timed-decision";
const receipts=new Map<number,number[]>();
export function observeCollectionResponse(interval:5|15,atMs:number){
  const values=receipts.get(interval)??[];
  if(!Number.isFinite(atMs)||atMs<=(values.at(-1)??-Infinity))return;
  values.push(atMs);if(values.length>32)values.shift();receipts.set(interval,values);
}

/** Never shorten the configured request budget to compensate for absent fields. */
export function healthyCollectionDelay(periodMs:number,random=Math.random()){
  const period=Number.isFinite(periodMs)&&periodMs>0?periodMs:5000;
  return Math.ceil(period*(1+Math.max(0,Math.min(1,random))*0.1));
}
/** Operational wake-ups are bounded; the absolute provider embargo is not. */
export const collectionTimerDelay=(nextAt:number,now=Date.now())=>
  Math.max(1,Math.min(60000,nextAt-now));
export function collectionCadence(interval:5|15,periodMs:number,nextAt:number|null,now=Date.now()){
  const policy=timedPolicy(interval),waitMs=nextAt===null?null:Math.max(0,nextAt-now);
  const values=receipts.get(interval)??[],gaps=values.slice(1).map((v,i)=>v-values[i]);
  const sorted=[...gaps].sort((a,b)=>a-b);
  return {configuredPeriodMs:periodMs,jitter:"positive 0–10%; minimum configured spacing",
    observedResponses:{n:values.length,lastReceivedAtMs:values.at(-1)??null,
      lastGapMs:gaps.at(-1)??null,medianGapMs:sorted.length?sorted[Math.floor(sorted.length/2)]:null,
      maximumGapMs:sorted.at(-1)??null,scope:"Last 32 distinct application HTTP receipt clocks per process; cached replay does not add a receipt. Not fresh probability evidence."},
    maximumScheduledReadsPerMinute:Math.ceil(60000/periodMs),
    browserRefreshIsProviderPoll:false,nextProviderAttemptAtMs:nextAt,
    requiredMaximumObservationGapMs:policy.maxGapMs,
    requiredLatestObservationAgeMs:policy.maxAgeMs,
    qualificationSamplingCompatible:periodMs*1.1<=policy.maxGapMs&&
      (waitMs===null||waitMs<=policy.maxGapMs),
    providerPermission:"Existing public read configuration; no new API or increased healthy request budget. Provider throughput permission is not independently verified.",
    limitation:waitMs!==null&&waitMs>policy.maxGapMs?
      "Provider retry embargo exceeds qualification sampling limits; affected gates cannot qualify. Thresholds are unchanged.":null};
}
