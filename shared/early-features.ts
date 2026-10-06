export const EARLY_FEATURE_SCHEMA="early-past-only-context-v1";
export type IntervalObservation={interval:5|15;roundId:string;startMs:number;expiryMs:number;
  probabilityUp:number;receivedAtMs:number;availableAtMs:number;providerSourceAtMs:number|null;
  reference:number|null;referenceQuality:"confirmed"|"provisional"|"missing";comparison:number|null;comparisonAtMs:number|null};

/** A raw context join, never an agreement rule, averaged probability or label.
 * Both event and independently measured availability clocks must precede cutoff. */
export function crossIntervalContext(own:IntervalObservation,other:IntervalObservation|undefined,cutoff:number){
  const valid=!!other&&other.interval!==own.interval&&other.startMs<=cutoff&&other.expiryMs>cutoff&&
    other.receivedAtMs<=cutoff&&other.availableAtMs<=cutoff&&cutoff-other.receivedAtMs<=10000&&
    (other.providerSourceAtMs===null||other.providerSourceAtMs<=cutoff)&&
    Number.isFinite(other.probabilityUp)&&other.probabilityUp>=0&&other.probabilityUp<=1;
  if(!valid)return {schema:EARLY_FEATURE_SCHEMA,available:false,reason:"NO_TIMELY_OTHER_INTERVAL_OBSERVATION"};
  const reference=other!.reference,price=other!.comparison,priceAt=other!.comparisonAtMs;
  const distance=reference!==null&&reference>0&&price!==null&&price>0&&priceAt!==null&&
    priceAt<=cutoff&&cutoff-priceAt<=10000?(price-reference)/reference:null;
  return {schema:EARLY_FEATURE_SCHEMA,available:true,interval:other!.interval,roundId:other!.roundId,
    startMs:other!.startMs,expiryMs:other!.expiryMs,receivedAtMs:other!.receivedAtMs,
    availableAtMs:other!.availableAtMs,providerSourceAtMs:other!.providerSourceAtMs,
    probabilityUp:other!.probabilityUp,elapsedFraction:(cutoff-other!.startMs)/(other!.expiryMs-other!.startMs),
    reference:reference,referenceQuality:other!.referenceQuality,referenceDistance:distance,
    comparisonSource:"comparison-not-settlement",
    fiveMinuteSegment:own.interval===15?Math.floor((cutoff-own.startMs)/300000):null,
    verifiedPreviousOutcome:null,modelProbabilityUp:null};
}
const number=(v:unknown,fallback=0)=>typeof v==="number"&&Number.isFinite(v)?v:fallback;
const logit=(p:number)=>Math.log(Math.max(.000001,Math.min(.999999,p))/(1-Math.max(.000001,Math.min(.999999,p))));
/** Exactly this function is used in fitting, offline replay and shadow inference.
 * Missing values have explicit flags; no later reference replacement is possible. */
export function earlyFeatureVector(probability:number,horizon:number,interval:5|15,features:Record<string,unknown>,cross:boolean){
  const own=[logit(probability),horizon/(interval*60),number(features.probabilityChange),
    number(features.sameSideMs)/1000,number(features.recentReversals),number(features.referenceDistance)*10000,
    number(features.probabilityRange),number(features.sourceAgeMs)/1000,
    features.missingReference===true?1:0,features.missingComparison===true?1:0];
  if(!cross)return own;
  const c=features.crossInterval as Record<string,unknown>|undefined,available=c?.available===true&&c.schema===EARLY_FEATURE_SCHEMA;
  return [...own,available?logit(number(c.probabilityUp,.5)):0,available?number(c.elapsedFraction):0,
    available?number(c.referenceDistance)*10000:0,available?0:1];
}
export type EarlyLinearModel={means:number[];scales:number[];intercept:number;coefficients:number[]};
export function inferEarlyModel(model:EarlyLinearModel,vector:number[]){
  if(vector.length!==model.coefficients.length||vector.some(v=>!Number.isFinite(v))||
    model.means.length!==vector.length||model.scales.length!==vector.length||model.scales.some(v=>!Number.isFinite(v)||v<=0))
    throw new Error("Early model feature/schema mismatch");
  const z=model.intercept+vector.reduce((sum,v,i)=>sum+(v-model.means[i])/model.scales[i]*model.coefficients[i],0);
  return 1/(1+Math.exp(-Math.max(-40,Math.min(40,z))));
}
