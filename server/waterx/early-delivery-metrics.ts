import {randomUUID} from "node:crypto";
type Sample={interval:5|15;stage:string;durationMs:number|null;outcome:"ok"|"error";atMs:number;roundId:string};
const samples:Sample[]=[];
const bootId=randomUUID(),bootAtMs=Date.now();
export function recordEarlyDelivery(interval:5|15,roundId:string,stage:string,durationMs:number|null,outcome:"ok"|"error"){
  samples.push({interval,roundId,stage,durationMs:durationMs!==null&&Number.isFinite(durationMs)&&durationMs>=0?durationMs:null,outcome,atMs:Date.now()});
  if(samples.length>4096)samples.shift();
}
export function earlyDeliveryMetrics(){
  const keys=Array.from(new Set(samples.map(s=>`${s.interval}:${s.stage}`)));
  return {version:"early-delivery-monotonic-v1",bootId,bootAtMs,scope:"Bounded process window; samples reset on restart, not a lifetime or outage SLA.",
    clockUncertainty:"Monotonic durations within process. Absolute provider/DB/browser clock offset is unverified; cross-process latency is not inferred.",
    stages:keys.map(key=>{
      const selected=samples.filter(s=>`${s.interval}:${s.stage}`===key),valid=selected.flatMap(s=>s.durationMs===null?[]:[s.durationMs]).sort((a,b)=>a-b);
      const percentile=(p:number)=>valid.length?valid[Math.max(0,Math.ceil(valid.length*p)-1)]:null;
      const failures=selected.filter(s=>s.outcome==="error").length;
      return {interval:Number(key.split(":")[0]),stage:key.split(":")[1],attempts:selected.length,
        measuredN:valid.length,failures,failureRate:failures/selected.length,p50Ms:percentile(.5),p95Ms:percentile(.95),
        maxMs:valid.at(-1)??null,unknownDurations:selected.length-valid.length};
    })};
}
