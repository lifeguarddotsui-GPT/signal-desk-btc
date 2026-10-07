import {eventQualification} from "../../shared/event-lock";
import {economicEvidenceFromFeatures,defaultValuePreference} from "../../shared/lock-economics";
import {priceAreaFeatures,type PricePoint} from "../../shared/price-area";
import {TWO_STAGE_FEATURES,type StageInput,type StageLock,type LockStage} from "../../shared/two-stage";
import {sigmoid,logit} from "./bluewater-fast";
export type LearnedStagePolicy={version:string;stage:LockStage;interval:5|15;modelVersion:string;
  trainedBeforeMs:number;featureVersion:string;minimumStrength:number;
  outcome:{intercept:number;coefficients:number[]};calibration:{intercept:number;coefficients:number[]};
  selectedCalibrationN:number;selectedBothOutcomes:boolean;selectedBrier:number;
  qualified:true;economicQuotesVerified:true};
export function accumulatedFeatures(input:StageInput){
  const latest=input.observations.at(-1),f=latest?.features??{};
  const points:PricePoint[]=input.observations.flatMap(o=>{
    const c=o.features.comparison as {price?:number;asOf?:string;source?:string}|null;
    const at=c?.asOf?Date.parse(c.asOf):NaN;
    return c&&typeof c.price==="number"&&Number.isSafeInteger(at)&&at<=o.receivedAtMs&&o.receivedAtMs-at<=5000?
      [{id:o.id,atMs:at,availableAtMs:o.availableAtMs,price:c.price,reference:typeof o.features.reference==="number"?o.features.reference:null,
        source:c.source??"Coinbase comparison"}]:[];
  });
  // The current public contract cannot establish oracle feed/window/sampling.
  // Never accept a vendor payload's bare 'verified' boolean as a rule proof.
  return priceAreaFeatures({points,startMs:input.startMs,expiryMs:input.expiryMs,asOfMs:input.nowMs,
    reference:typeof f.reference==="number"?f.reference:null,referenceConfirmed:f.referenceQuality==="confirmed"});
}
const clip=(x:number)=>Math.max(-5,Math.min(5,x));
export function stageModelFeatures(input:StageInput){
  const p=accumulatedFeatures(input),latest=input.observations.at(-1);
  if(!latest?.sourceHealthy||!Number.isFinite(latest.probabilityUp)||p.currentDistanceUsd==null||
    p.normalizedArea==null||p.coverageFraction==null||p.coverageFraction<.9)return null;
  const recent=p.windows[30] as {momentumUsd:number|null};
  return [clip(logit(latest.probabilityUp)),clip(p.volatilityAdjustedDistance??0),clip(p.normalizedArea),
    (input.nowMs-input.startMs)/(input.expiryMs-input.startMs),p.fractionObservedTimeAbove??.5,
    clip((recent.momentumUsd??0)/(p.volatilityUsd||1)),p.coverageFraction,p.referenceConfirmed?0:1];
}
export function validatedStagePolicy(p:LearnedStagePolicy|null,input:StageInput,stage:LockStage){
  return !!p&&p.qualified===true&&p.economicQuotesVerified===true&&p.stage===stage&&p.interval===input.intervalMinutes&&
    p.featureVersion===TWO_STAGE_FEATURES&&p.trainedBeforeMs<input.startMs&&p.selectedCalibrationN>=60&&
    p.selectedBothOutcomes===true&&Number.isFinite(p.selectedBrier)&&p.selectedBrier<.25&&
    p.outcome.coefficients.length===8&&p.calibration.coefficients.length===1&&
    [p.minimumStrength,p.outcome.intercept,p.calibration.intercept,...p.outcome.coefficients,...p.calibration.coefficients].every(Number.isFinite)&&
    p.minimumStrength>=.5&&p.minimumStrength<1;
}
export function assessStage(input:StageInput,stage:LockStage,early:StageLock|null,policy:LearnedStagePolicy|null=null){
  input={...input,observations:input.observations.filter(o=>o.availableAtMs<=input.nowMs&&
    o.receivedAtMs<=input.nowMs&&o.receivedAtMs>=input.startMs&&o.receivedAtMs<input.expiryMs)};
  const q=eventQualification(input,input.observations,input.nowMs),latest=input.observations.at(-1);
  if(input.nowMs>=input.expiryMs)return {eligible:false,reason:"ROUND_EXPIRED"};
  if(!latest||!latest.sourceHealthy||input.nowMs-latest.receivedAtMs>5000)return {eligible:false,reason:"WAITING_FOR_FRESH_DATA"};
  if(stage==="CONFIRMATION"&&early&&latest.id===early.observationIds.at(-1))
    return {eligible:false,reason:"WAITING_FOR_ADDITIONAL_EVIDENCE"};
  if(stage==="CONFIRMATION"&&!validatedStagePolicy(policy,input,stage))
    return {eligible:false,reason:"CONFIRMATION_POLICY_NOT_QUALIFIED"};
  if(stage==="CONFIRMATION"){
    const area=accumulatedFeatures(input);
    const prior=early?.features as {marketProbabilityUp?:number;currentDistanceUsd?:number}|null;
    const anchor=early?prior?.marketProbabilityUp:input.observations[0]?.probabilityUp;
    const first=input.observations[0];
    const priorDistance=early?prior?.currentDistanceUsd:first?accumulatedFeatures({...input,
      observations:[first],nowMs:first.availableAtMs}).currentDistanceUsd:null;
    const changed=anchor!=null&&latest.probabilityUp!==anchor||
      (priorDistance!=null&&area.currentDistanceUsd!=null&&priorDistance!==area.currentDistanceUsd);
    if(input.observations.length<2||!changed||early&&latest.availableAtMs<=early.evidenceCutoffMs)
      return {eligible:false,reason:"WAITING_FOR_ADDITIONAL_EVIDENCE"};
  }
  if(!q.qualified||!q.liveSide)return {eligible:false,reason:q.blocker};
  let side=q.liveSide,probabilityUp=latest.probabilityUp,source="WATERX_MARKET",modelVersion:null|string=null;
  let calibrationStatus:"UNQUALIFIED"|"QUALIFIED"="UNQUALIFIED",policyVersion="unchanged-event-rules-indicative-value-v1";
  if(validatedStagePolicy(policy,input,stage)){
    const x=stageModelFeatures(input);if(!x)return {eligible:false,reason:"INSUFFICIENT_PRICE_COVERAGE"};
    const raw=sigmoid(policy!.outcome.intercept+x.reduce((s,v,i)=>s+v*policy!.outcome.coefficients[i],0));
    if(Math.max(raw,1-raw)<policy!.minimumStrength)return {eligible:false,reason:"NO_QUALIFYING_STAGE_OPPORTUNITY"};
    probabilityUp=sigmoid(policy!.calibration.intercept+logit(raw)*policy!.calibration.coefficients[0]);
    side=raw>=.5?"UP":"DOWN";
    if((probabilityUp>=.5)!==(side==="UP"))return {eligible:false,reason:"CALIBRATED_DIRECTION_CONFLICT"};
    source="BLUEWATER_STAGE_SELECTED_CALIBRATED_MODEL";calibrationStatus="QUALIFIED";
    modelVersion=policy!.modelVersion;policyVersion=policy!.version;
  }
  const economics=economicEvidenceFromFeatures({...latest.features,
    qualifiedForecast:calibrationStatus==="QUALIFIED"?{status:"QUALIFIED",source:"INDEPENDENT_MODEL",
      probability:side==="UP"?probabilityUp:1-probabilityUp,modelVersion,calibrationVersion:policyVersion}:null},
    input.roundId,side,input.nowMs);
  if(economics.totalReturnedIfCorrectUsd==null)return {eligible:false,reason:"ENTRY_TERMS_UNAVAILABLE"};
  if(stage==="EARLY"&&economics.totalReturnedIfCorrectUsd<defaultValuePreference.minimumReturnUsd)
    return {eligible:false,reason:"NO_QUALIFYING_EARLY_VALUE"};
  if(calibrationStatus==="QUALIFIED"&&!(economics.expectedNetUsd!=null&&economics.expectedNetUsd>0))
    return {eligible:false,reason:"VERIFIED_POSITIVE_VALUE_UNAVAILABLE"};
  return {eligible:true,reason:calibrationStatus==="QUALIFIED"?"QUALIFIED_STAGE_POLICY":"EXPERIMENTAL_MARKET_BASELINE_NOT_MODEL_EDGE",
    side,probabilityUp,probabilitySource:source,calibrationStatus,modelVersion,policyVersion,economics,
    priceFeatures:accumulatedFeatures(input)};
}
