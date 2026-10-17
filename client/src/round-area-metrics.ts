/** Browser-side, no paid oracle calls. Describes Coinbase comparison observations
 * against a WATERX-REPORTED ROUND START REFERENCE, not settlement TWAP.
 * Integration is in USD*milliseconds; percentages are conditioned on observed
 * non-gap segments, NEVER on an unobserved round's future duration.
 */
export type AreaPoint={at:number|string;price:number|null;gap?:boolean};
export type ColoredPiece={startMs:number;endMs:number;startPrice:number;endPrice:number;side:"ABOVE"|"BELOW"};
export type AreaSummary={
  source:"COINBASE_SPOT_VS_WATERX_REFERENCE";observedMs:number;elapsedMs:number;
  coveragePercent:number;aboveMs:number;belowMs:number;aboveTimePercent:number;belowTimePercent:number;
  aboveArea:number;belowArea:number;aboveAreaPercent:number|null;belowAreaPercent:number|null;
  netAreaBiasPercent:number|null;crossings:number;currentSide:"ABOVE"|"BELOW"|null;currentStreakMs:number;
  freshestSampleAgeMs:number|null;pieces:ColoredPiece[];
};
export function splitAtReference(a:{at:number;price:number},b:{at:number;price:number},ref:number):ColoredPiece[]{
  if(b.at<=a.at)return [];
  const da=a.price-ref,db=b.price-ref;
  const make=(x:typeof a,y:typeof a):ColoredPiece|null=>{
    const mid=((x.price+y.price)/2)-ref;
    if(Math.abs(mid)<1e-12)return null;
    return{startMs:x.at,endMs:y.at,startPrice:x.price,endPrice:y.price,side:mid>0?"ABOVE":"BELOW"};
  };
  if(da*db<0){
    const frac=Math.abs(da)/(Math.abs(da)+Math.abs(db));
    const mid={at:a.at+(b.at-a.at)*frac,price:ref};
    return [make(a,mid),make(mid,b)].filter((v):v is ColoredPiece=>v!==null);
  }
  const segment=make(a,b);
  return segment?[segment]:[];
}
export function computeAreaSummary(points:readonly AreaPoint[],ref:number,startMs:number,endMs:number,nowMs:number,maxGapMs=14_000):AreaSummary|null{
  if(![ref,startMs,endMs,nowMs,maxGapMs].every(Number.isFinite)||ref<=0||startMs>=endMs||maxGapMs<=0)return null;
  const cutoff=Math.min(nowMs,endMs),elapsedMs=Math.max(0,cutoff-startMs);
  const series=points.map(p=>({...p,at:Number(p.at)}))
    .filter(p=>Number.isFinite(p.at)&&p.at>=startMs&&p.at<=cutoff)
    .sort((a,b)=>a.at-b.at);
  const pieces:ColoredPiece[]=[];
  let prev:{at:number;price:number}|null=null;
  let observedMs=0,aboveMs=0,belowMs=0,aboveArea=0,belowArea=0,crossings=0;
  let currentSide:"ABOVE"|"BELOW"|null=null,currentStreakMs=0;
  let lastSegmentEnd=-Infinity;
  let lastValidAt:number|null=null;
  let lastNonzeroSide:"ABOVE"|"BELOW"|null=null;
  for(const p of series){
    if(p.gap||p.price===null||!Number.isFinite(p.price)||p.price<=0){prev=null;currentSide=null;currentStreakMs=0;lastNonzeroSide=null;continue;}
    const current={at:p.at,price:p.price};
    lastValidAt=current.at;
    if(prev&&current.at>prev.at&&current.at-prev.at<=maxGapMs){
      const newPieces=splitAtReference(prev,current,ref);
      // Exact linear crossing split: do not color or count unobserved gaps.
      for(const part of newPieces){
        const dt=part.endMs-part.startMs;
        if(dt<=0)continue;
        pieces.push(part);
        observedMs+=dt;
        const area=dt*(Math.abs(part.startPrice-ref)+Math.abs(part.endPrice-ref))/2;
        if(part.side==="ABOVE"){aboveMs+=dt;aboveArea+=area;}
        else{belowMs+=dt;belowArea+=area;}
        if(lastSegmentEnd!==part.startMs||lastNonzeroSide!==part.side){
          if(lastSegmentEnd===part.startMs&&lastNonzeroSide&&lastNonzeroSide!==part.side)crossings++;
          currentStreakMs=dt;
        }else currentStreakMs+=dt;
        currentSide=part.side;lastNonzeroSide=part.side;lastSegmentEnd=part.endMs;
      }
    }else if(prev){currentSide=null;currentStreakMs=0;lastNonzeroSide=null;}
    prev=current;
  }
  const hasCurrentObservation=lastValidAt!==null&&cutoff-lastValidAt<=maxGapMs;
  // Do not display a continuous current streak across a disconnected or stale tail.
  if(!hasCurrentObservation){currentSide=null;currentStreakMs=0;}
  const totalArea=aboveArea+belowArea;
  return{
    source:"COINBASE_SPOT_VS_WATERX_REFERENCE",elapsedMs,observedMs,
    coveragePercent:elapsedMs>0?100*observedMs/elapsedMs:0,
    aboveMs,belowMs,aboveTimePercent:observedMs>0?100*aboveMs/observedMs:0,
    belowTimePercent:observedMs>0?100*belowMs/observedMs:0,
    aboveArea,belowArea,aboveAreaPercent:totalArea>0?100*aboveArea/totalArea:null,
    belowAreaPercent:totalArea>0?100*belowArea/totalArea:null,
    netAreaBiasPercent:totalArea>0?100*(aboveArea-belowArea)/totalArea:null,
    crossings,currentSide,currentStreakMs,
    freshestSampleAgeMs:lastValidAt===null?null:cutoff-lastValidAt,pieces,
  };
}
