import { createHash } from "node:crypto";
import type { BluewaterFamily } from "../../shared/bluewater-research";
import { comparisonFeatures } from "./research-decision";

export const FEATURE_SCHEMA = "bluewater-point-in-time-v1";
export const FEATURE_NAMES = [
  "time_remaining_seconds", "waterx_probability_up", "waterx_probability_down",
  "probability_change_5s", "probability_change_15s", "probability_change_30s",
  "probability_velocity", "probability_acceleration", "recent_side_changes",
  "btc_price", "btc_return_1s", "btc_return_5s", "btc_return_15s", "btc_return_30s", "btc_return_60s",
  "volatility_15s", "volatility_30s", "volatility_60s", "reference_distance_bps",
  "normalized_distance", "tick_density", "comparison_latency_ms", "observation_age_ms", "source_freshness",
  // Retained reproducible seven-feature daily-training contract.
  "marketProbabilityUp", "referenceDistanceBps", "timeRemainingFraction",
  "return1m", "return3m", "realizedVolatilityBps", "sourceAgeMs",
] as const;
type Stamp = { sourceAtMs: number; receivedAtMs: number };
export type MarketPoint = Stamp & { probabilityUp: number; probabilityDown: number };
export type FeatureTick = Stamp & { price: number };
export type FeatureInput = {
  intervalMinutes: 5 | 15; roundId: string; startMs: number; expiryMs: number; decisionAtMs: number;
  market: MarketPoint[]; ticks: FeatureTick[];
  reference: (Stamp & { price: number; confirmed: boolean }) | null;
};
export type FeatureSnapshot = {
  schema: string; intervalMinutes: 5 | 15; roundId: string; startMs: number; expiryMs: number;
  decisionAtMs: number; values: Record<string, number | null>;
  provenance: { marketTimestampKind: "app-observed"; market: MarketPoint[]; ticks: FeatureTick[]; reference: FeatureInput["reference"] };
  digest: string;
};
export type ModelArtifact = {
  id: string; artifactDigest: string; formatVersion: "bluewater-numeric-v1";
  intervalMinutes: 5 | 15; family: BluewaterFamily; version: string; featureSchema: string;
  featureNames: string[]; fittedAtMs: number; evidenceThroughMs: number; datasetFingerprint: string;
  calibration: { slope: number; intercept: number } | null;
  parameters: { means?: number[]; scales?: number[]; coefficients?: number[]; intercept?: number };
  protocol: { eligible: boolean; records: number; spanMs: number; training: number; calibration: number; test: number };
  dateRange: { fromMs: number; throughMs: number }; partitions: unknown; hyperparameters: unknown; metrics: unknown;
};
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k =>
    `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export const sigmoid = (v: number) => 1 / (1 + Math.exp(-Math.max(-25, Math.min(25, v))));
export const logit = (p: number) => Math.log(Math.max(1e-10,Math.min(1-1e-10,p)) / (1-Math.max(1e-10,Math.min(1-1e-10,p))));
function timed(p: Stamp, at: number) {
  if (![p.sourceAtMs,p.receivedAtMs].every(Number.isFinite) || p.sourceAtMs>at || p.receivedAtMs>at)
    throw new Error("Feature source or receipt timestamp is future/invalid.");
  if(p.receivedAtMs<p.sourceAtMs) throw new Error("Feature receipt precedes its source.");
}
export function buildFeatureSnapshot(input: FeatureInput): FeatureSnapshot {
  const {intervalMinutes,roundId,startMs,expiryMs,decisionAtMs:at}=input;
  if(![5,15].includes(intervalMinutes)||!roundId||![startMs,expiryMs,at].every(Number.isFinite)||
    expiryMs-startMs!==intervalMinutes*60000||at<startMs||at>=expiryMs) throw new Error("Feature exact round timing invalid.");
  input.market.forEach(p=>{timed(p,at);if(![p.probabilityUp,p.probabilityDown].every(v=>Number.isFinite(v)&&v>=0&&v<=1)||
    Math.abs(p.probabilityUp+p.probabilityDown-1)>1e-6)throw new Error("Invalid two-sided market feature.");});
  input.ticks.forEach(p=>{timed(p,at);if(!Number.isFinite(p.price)||p.price<=0)throw new Error("Invalid price feature.");});
  if(input.reference)timed(input.reference,at);
  const market=[...input.market].filter(p=>p.sourceAtMs>=startMs).sort((a,b)=>a.sourceAtMs-b.sourceAtMs).slice(-240);
   const ticks=[...input.ticks].filter(p=>p.sourceAtMs>=at-195000).sort((a,b)=>a.sourceAtMs-b.sourceAtMs).slice(-4096);
  const latest=market.at(-1);if(!latest||at-latest.sourceAtMs>10000||at-latest.receivedAtMs>10000)
    throw new Error("No timely market feature.");
  const values:Record<string,number|null>=Object.fromEntries(FEATURE_NAMES.map(n=>[n,null]));
  const anchor=(seconds:number)=>market.filter(p=>p.sourceAtMs<=at-seconds*1000).at(-1);
  const change=(seconds:number)=>{const p=anchor(seconds);return p&&at-seconds*1000-p.sourceAtMs<=5000?
    latest.probabilityUp-p.probabilityUp:null;};
  values.time_remaining_seconds=(expiryMs-at)/1000;
  values.waterx_probability_up=values.marketProbabilityUp=latest.probabilityUp;
  values.waterx_probability_down=latest.probabilityDown;
  values.timeRemainingFraction=(expiryMs-at)/(expiryMs-startMs);
  for(const s of [5,15,30])values[`probability_change_${s}s`]=change(s);
  if(values.probability_change_5s!==null)values.probability_velocity=values.probability_change_5s/5;
  if(change(15)!==null&&change(30)!==null) values.probability_acceleration=(change(15)!-(change(30)!-change(15)!))/225;
  const recent=market.filter(p=>p.sourceAtMs>=at-30000);
  if(anchor(30)&&at-30000-anchor(30)!.sourceAtMs<=5000)values.recent_side_changes=recent.slice(1)
    .filter((p,i)=>(p.probabilityUp>=.5)!==(recent[i].probabilityUp>=.5)).length;
  values.observation_age_ms=at-latest.sourceAtMs;values.source_freshness=at-latest.sourceAtMs<=10000?1:0;
  const last=ticks.at(-1);
  const window=(seconds:number)=> {
    const before=ticks.filter(t=>t.sourceAtMs<=at-seconds*1000).at(-1);
    if(!before||at-seconds*1000-before.sourceAtMs>1000||!last||at-last.sourceAtMs>15000)return null;
    const selected=ticks.filter(t=>t.sourceAtMs>=before.sourceAtMs);
    if(selected.some((t,i)=>i>0&&t.sourceAtMs-selected[i-1].sourceAtMs>15000))return null;
    return selected;
  };
  if(last&&at-last.sourceAtMs<=15000){
    values.btc_price=last.price;values.comparison_latency_ms=last.receivedAtMs-last.sourceAtMs;
    values.sourceAgeMs=at-last.sourceAtMs;
    for(const s of [1,5,15,30,60,180]){
      const w=window(s);if(w)values[s===180?"return3m":`btc_return_${s}s`]=last.price/w[0].price-1;
    }
    for(const s of [15,30,60,180]){
      const w=window(s);if(w&&w.length>=3){const returns=w.slice(1).map((t,i)=>Math.log(t.price/w[i].price));
        const mean=returns.reduce((a,b)=>a+b,0)/returns.length;
        const vol=Math.sqrt(returns.reduce((a,b)=>a+(b-mean)**2,0)/returns.length)*10000;
        values[s===180?"realizedVolatilityBps":`volatility_${s}s`]=vol;}
    }
   const legacy=comparisonFeatures(ticks.map((t,i)=>({...t,id:String(i)})),at,ticks.length>=4096);
   if(legacy.coverage==="complete"){
     values.return1m=legacy.return1m;values.return3m=legacy.return3m;
     values.realizedVolatilityBps=legacy.realizedVolatility===null?null:legacy.realizedVolatility*10000;
   }else values.return1m=values.return3m=values.realizedVolatilityBps=null;
    const w=window(30);if(w)values.tick_density=w.length/30;
    if(input.reference?.confirmed&&Number.isFinite(input.reference.price)&&input.reference.price>0){
      values.reference_distance_bps=values.referenceDistanceBps=(last.price/input.reference.price-1)*10000;
      if(values.volatility_60s!==null&&values.volatility_60s>0)values.normalized_distance=values.reference_distance_bps/values.volatility_60s;
    }
  }
  const body={schema:FEATURE_SCHEMA,intervalMinutes,roundId,startMs,expiryMs,decisionAtMs:at,values,
    provenance:{marketTimestampKind:"app-observed" as const,market,ticks,reference:input.reference}};
  return {...body,digest:digest(body)};
}
export function validateArtifact(a: ModelArtifact, decisionAtMs: number) {
  const {id,artifactDigest,...body}=a;
  if(a.formatVersion!=="bluewater-numeric-v1"||a.featureSchema!==FEATURE_SCHEMA||
    !["platt_waterx","rich_logistic","rich_logistic_no_market"].includes(a.family)||
    ![5,15].includes(a.intervalMinutes)||a.fittedAtMs>decisionAtMs||a.evidenceThroughMs>a.fittedAtMs||
    ![a.fittedAtMs,a.evidenceThroughMs].every(Number.isFinite)||
    a.protocol.eligible!==true||![a.protocol.records,a.protocol.spanMs,a.protocol.training,a.protocol.calibration,a.protocol.test].every(Number.isFinite)||
    a.protocol.records<90||a.protocol.training<40||a.protocol.calibration<20||a.protocol.test<20||
    a.protocol.spanMs<(a.intervalMinutes===5?48*3600000:7*86400000))throw new Error("Invalid/untimely research artifact eligibility.");
  if(id!==digest(body)||artifactDigest!==id)throw new Error("Artifact digest mismatch.");
  if(!a.featureNames.length||new Set(a.featureNames).size!==a.featureNames.length||
    a.featureNames.some(n=>!(FEATURE_NAMES as readonly string[]).includes(n)))throw new Error("Artifact feature schema invalid.");
  if(a.family==="rich_logistic_no_market"&&a.featureNames.some(n=>n==="marketProbabilityUp"||n.startsWith("waterx_")||n.startsWith("probability_")||n==="recent_side_changes"))
    throw new Error("No-market ablation contains market features.");
  if(a.calibration&&![a.calibration.slope,a.calibration.intercept].every(v=>Number.isFinite(v)&&Math.abs(v)<=1000))
    throw new Error("Artifact calibration invalid.");
  if(a.family==="platt_waterx"){
    if(a.featureNames.length!==1||a.featureNames[0]!=="waterx_probability_up")throw new Error("Platt input invalid.");
  }else{
    const {means,scales,coefficients,intercept}=a.parameters;
    if(!Array.isArray(means)||!Array.isArray(scales)||!Array.isArray(coefficients)||
      means.length!==a.featureNames.length||scales.length!==means.length||coefficients.length!==means.length||
      ![...means,...scales,...coefficients,intercept].every(v=>typeof v==="number"&&Number.isFinite(v))||
      scales.some(v=>v<=1e-12)||coefficients.some(v=>Math.abs(v)>1000))throw new Error("Model numerical parameters invalid.");
  }
}
export function validateFeatureSnapshot(snapshot:FeatureSnapshot){
  const {digest:hash,...body}=snapshot;
  if(hash!==digest(body)||snapshot.schema!==FEATURE_SCHEMA)throw new Error("Feature digest/schema mismatch.");
  const reproduced=buildFeatureSnapshot({intervalMinutes:snapshot.intervalMinutes,roundId:snapshot.roundId,
    startMs:snapshot.startMs,expiryMs:snapshot.expiryMs,decisionAtMs:snapshot.decisionAtMs,...snapshot.provenance});
  if(reproduced.digest!==hash)throw new Error("Feature values not reproducible from provenance.");
}
export function infer(artifact:ModelArtifact,snapshot:FeatureSnapshot){
  validateArtifact(artifact,snapshot.decisionAtMs);
  validateFeatureSnapshot(snapshot);
  if(snapshot.schema!==artifact.featureSchema||snapshot.intervalMinutes!==artifact.intervalMinutes)
    throw new Error("Feature digest/schema mismatch.");
  const values=artifact.featureNames.map(n=>snapshot.values[n]);
  if(values.some(v=>v==null||!Number.isFinite(v)))throw new Error("Required model feature unavailable.");
  let raw:number;
  if(artifact.family==="platt_waterx"){
    if(artifact.featureNames.length!==1||artifact.featureNames[0]!=="waterx_probability_up")throw new Error("Platt input invalid.");
    raw=values[0]!;
  }else{
    const {means,scales,coefficients,intercept}=artifact.parameters;
    if(!means||!scales||!coefficients||means.length!==values.length||scales.length!==values.length||coefficients.length!==values.length||
      ![...means,...scales,...coefficients,intercept].every(v=>v!==undefined&&Number.isFinite(v))||
      scales.some(v=>v<=1e-12)||coefficients.some(v=>Math.abs(v)>1000))throw new Error("Model numerical parameters invalid.");
    raw=sigmoid(intercept!+values.reduce<number>((sum,v,i)=>sum+((v!-means[i])/scales[i])*coefficients[i],0));
  }
  const cal=artifact.calibration?sigmoid(artifact.calibration.intercept+artifact.calibration.slope*logit(raw)):null;
  const displayed=cal??raw;
  return {rawProbabilityUp:raw,calibratedProbabilityUp:cal,displayedProbabilityUp:displayed,
    chosenSide:displayed>=.5?"UP" as const:"DOWN" as const,modelArtifactId:artifact.id,
    featureSnapshotDigest:snapshot.digest,inferenceTimestamp:snapshot.decisionAtMs};
}

// Bounded, synchronous numerical feature state; no database, agent or network I/O.
const tickState:FeatureTick[]=[];
const markets=new Map<string,MarketPoint[]>();
export function acceptFeatureTick(tick:FeatureTick){
  if(![tick.price,tick.sourceAtMs,tick.receivedAtMs].every(Number.isFinite)||tick.price<=0||
    tick.sourceAtMs>tick.receivedAtMs)return;
   tickState.push(tick);while(tickState.length>4096||tickState[0]?.sourceAtMs<tick.sourceAtMs-195000)tickState.shift();
}
export function observeFeatureState(input:Omit<FeatureInput,"ticks"|"market">&{market:MarketPoint}):FeatureSnapshot {
  const key=`${input.intervalMinutes}:${input.roundId}`;
  let history=markets.get(key)??[];if(history.at(-1)?.sourceAtMs!==input.market.sourceAtMs)history.push(input.market);
  history=history.slice(-240);markets.set(key,history);while(markets.size>8)markets.delete(markets.keys().next().value!);
  return buildFeatureSnapshot({...input,market:history,ticks:tickState.filter(t=>t.sourceAtMs<=input.decisionAtMs&&t.receivedAtMs<=input.decisionAtMs)});
}