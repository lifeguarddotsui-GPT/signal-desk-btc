export const AREA_VERSION="price-area-proxy-v1";
export const MAX_PRICE_GAP_MS=5000;
export type PricePoint={id:string;atMs:number;availableAtMs:number;price:number;reference:number|null;source:string;receivedAtMs?:number};
export type AverageRule={verified:boolean;method:"CONTINUOUS_FULL_ROUND_AVERAGE"|"UNKNOWN";oracle:string|null;
  feed:string|null;referenceAtMs:number|null;referenceValue:number|null;rounding:string|null;tieRule:string|null};
export const unverifiedSettlementRule:AverageRule={verified:false,method:"UNKNOWN",oracle:null,feed:null,
  referenceAtMs:null,referenceValue:null,rounding:null,tieRule:null};
function integrate(points:readonly PricePoint[],reference:number,from:number,to:number,maxGap:number){
  let signed=0,positive=0,negative=0,above=0,below=0,covered=0,crossings=0,gaps=0;
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i],dt=b.atMs-a.atMs;
    const left=Math.max(a.atMs,from),right=Math.min(b.atMs,to);
    if(right<=left)continue;
    if(dt>maxGap||a.reference!==reference||b.reference!==reference){gaps++;continue;}
    const x=a.price-reference+(b.price-a.price)*(left-a.atMs)/dt;
    const y=a.price-reference+(b.price-a.price)*(right-a.atMs)/dt;
    const duration=(right-left)/1000;
    covered+=right-left;signed+=(x+y)/2*duration;
    if(x>=0&&y>=0){positive+=(x+y)/2*duration;if(x>0||y>0)above+=right-left;}
    else if(x<=0&&y<=0){negative-=(x+y)/2*duration;if(x<0||y<0)below+=right-left;}
    else{
      crossings++;const split=Math.abs(x)/(Math.abs(x)+Math.abs(y)),first=duration*split,second=duration-first;
      if(x>0){positive+=x*first/2;negative-=y*second/2;above+=first*1000;below+=second*1000;}
      else{negative-=x*first/2;positive+=y*second/2;below+=first*1000;above+=second*1000;}
    }
  }
  return {signedAreaUsdSeconds:signed,positiveAreaUsdSeconds:positive,negativeAreaUsdSeconds:negative,
    observedMs:covered,gapSegments:gaps,crossings,
    timeWeightedDistanceUsd:covered?signed/(covered/1000):null,
    fractionObservedTimeAbove:covered?above/covered:null,fractionObservedTimeBelow:covered?below/covered:null};
}
export function priceAreaFeatures(input:{points:readonly PricePoint[];startMs:number;expiryMs:number;asOfMs:number;
  reference:number|null;referenceConfirmed:boolean;rule?:AverageRule;maxGapMs?:number;settlementPrice?:number|null}){
  const end=Math.min(input.asOfMs,input.expiryMs),elapsed=Math.max(0,end-input.startMs),maxGap=input.maxGapMs??MAX_PRICE_GAP_MS;
  const candidates=input.points.filter(p=>Number.isFinite(p.price)&&p.price>0&&Number.isSafeInteger(p.atMs)&&
    Number.isSafeInteger(p.availableAtMs)&&p.availableAtMs<=input.asOfMs&&p.atMs<=end&&p.atMs>=input.startMs)
    .sort((a,b)=>a.atMs-b.atMs||a.id.localeCompare(b.id));
  const points=candidates.filter((p,i)=>i===0||p.atMs!==candidates[i-1].atMs);
  const reference=input.reference!=null&&Number.isFinite(input.reference)&&input.reference>0?input.reference:null;
  const compatible=reference==null?[]:points.filter(p=>p.reference===reference);
  const integral=integrate(points,reference??NaN,input.startMs,end,maxGap);
  const deltas=compatible.slice(1).flatMap((p,i)=>p.atMs-compatible[i].atMs<=maxGap?[p.price-compatible[i].price]:[]);
  const volatility=deltas.length?Math.sqrt(deltas.reduce((s,d)=>s+d*d,0)/deltas.length):null;
  const latest=points.at(-1),fresh=!!latest&&end-latest.atMs<=maxGap&&latest.reference===reference;
  const gaps=points.slice(1).map((p,i)=>p.atMs-points[i].atMs).sort((a,b)=>a-b);
  const receiptGaps=points.slice(1).flatMap((p,i)=>p.receivedAtMs!=null&&points[i].receivedAtMs!=null?
    [p.receivedAtMs-points[i].receivedAtMs!]:[]).sort((a,b)=>a-b);
  const quantile=(v:number[],q:number)=>v.length?v[Math.ceil(v.length*q)-1]:null;
  const windows=Object.fromEntries([15,30,60].map(seconds=>{
    const from=Math.max(input.startMs,end-seconds*1000),window=integrate(points,reference??NaN,from,end,maxGap);
    const preceding=compatible.filter(p=>p.atMs<=from).at(-1);
    const following=compatible.find(p=>p.atMs>=from);
    const boundary=preceding&&following&&following.atMs-preceding.atMs<=maxGap?
      preceding.atMs===following.atMs?preceding.price:preceding.price+
        (following.price-preceding.price)*(from-preceding.atMs)/(following.atMs-preceding.atMs):null;
    return [seconds,{...window,momentumUsd:fresh&&boundary!=null?latest!.price-boundary:null,
      coverageFraction:end>from?window.observedMs/(end-from):null}];
  }));
  const rule=input.rule??unverifiedSettlementRule,remainingMs=Math.max(0,input.expiryMs-input.asOfMs);
  const supports=rule.verified&&rule.method==="CONTINUOUS_FULL_ROUND_AVERAGE"&&!!rule.oracle&&!!rule.feed&&
    rule.referenceAtMs===input.startMs&&rule.referenceValue===reference&&!!rule.rounding&&!!rule.tieRule;
  const complete=reference!=null&&input.referenceConfirmed&&elapsed>0&&integral.observedMs===elapsed&&fresh;
  const reversal=remainingMs>0&&supports&&complete?reference!-integral.signedAreaUsdSeconds/(remainingMs/1000):null;
  return {version:AREA_VERSION,source:"COINBASE_COMPARISON_PROXY_NOT_SETTLEMENT",reference,referenceConfirmed:input.referenceConfirmed,
    currentDistanceUsd:fresh&&reference!=null?latest!.price-reference:null,...integral,
    elapsedMs:elapsed,coverageFraction:elapsed?integral.observedMs/elapsed:null,
    missingMs:Math.max(0,elapsed-integral.observedMs),maxSupportedGapMs:maxGap,
    interpolation:"Piecewise linear between compatible observed endpoints, gap <= maximum; no extrapolation across outages or at tail.",
    observationN:points.length,referenceMismatchN:points.filter(p=>p.reference!==reference).length,
    rawObservationCoverage:{pointN:points.length,uniqueSourceTimestampN:points.length,
      duplicateTimestampN:candidates.length-points.length,firstAtMs:points[0]?.atMs??null,lastAtMs:latest?.atMs??null,
      observedSpanMs:points.length?latest!.atMs-points[0].atMs:0,
      medianSourceCadenceMs:quantile(gaps,.5),p95SourceCadenceMs:quantile(gaps,.95),
      medianReceiptCadenceMs:quantile(receiptGaps,.5),p95ReceiptCadenceMs:quantile(receiptGaps,.95),
      sourceToReceiptLatencyMs:points.flatMap(p=>p.receivedAtMs!=null?[p.receivedAtMs-p.atMs]:[])},
    usableAreaCoverage:{supportedMs:integral.observedMs,elapsedMs:elapsed,
      fraction:elapsed?integral.observedMs/elapsed:null,unsupportedSegments:integral.gapSegments,
      referenceMismatchN:points.filter(p=>p.reference!==reference).length},
    crossingsPerObservedMinute:integral.observedMs?integral.crossings/(integral.observedMs/60000):null,
    volatilityUsd:volatility,volatilityAdjustedDistance:fresh&&reference!=null&&volatility!=null&&volatility>0?(latest!.price-reference)/volatility:null,
    normalizedArea:integral.timeWeightedDistanceUsd!=null&&volatility!=null&&volatility>0?integral.timeWeightedDistanceUsd/volatility:null,
    windows,comparisonSettlementDisagreementUsd:fresh&&input.settlementPrice!=null&&Number.isFinite(input.settlementPrice)?
      latest!.price-input.settlementPrice:null,
    remainingReversalAveragePrice:reversal,
    reversalStatus:reversal!=null?"ILLUSTRATIVE_PROXY_ESTIMATE_NOT_PROBABILITY":remainingMs===0?"EXPIRED":
      !supports?"SETTLEMENT_AVERAGING_RULE_UNVERIFIED":"INCOMPLETE_COVERAGE_OR_REFERENCE",
    settlementRule:rule};
}
