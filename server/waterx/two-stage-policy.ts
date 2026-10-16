import {eventQualification} from "../../shared/event-lock";
import {economicEvidenceFromFeatures,defaultValuePreference} from "../../shared/lock-economics";
import {priceAreaFeatures,type PricePoint} from "../../shared/price-area";
import {TWO_STAGE_FEATURES,type StageInput,type StageLock,type LockStage,type StageDiagnostics} from "../../shared/two-stage";
import {sigmoid,logit} from "./bluewater-fast";
import {earlyCandidate,researchPreference} from "./early-policy";
import {validWaterxProbabilityPair} from "../../shared/round-decision";
export type LearnedStagePolicy={version:string;stage:LockStage;interval:5|15;modelVersion:string;
  trainedBeforeMs:number;featureVersion:string;minimumStrength:number;
  outcome:{intercept:number;coefficients:number[]};calibration:{intercept:number;coefficients:number[]};
  selectedCalibrationN:number;selectedBothOutcomes:boolean;selectedBrier:number;
  qualified:true;economicQuotesVerified:boolean};
/** Research safety reserve, not a claim of verified executable order terms. */
export const CONFIRMATION_ORDER_RESERVE_MS=30000;
/** Uncalibrated, shadow-only WaterX evidence experiment; NOT a trained forecast.
 * Turned ON by default so the Confirmation panel cannot sit disabled merely
 * because Replit omitted a deployment secret. Explicit "false" is a kill switch.
 * Does not enable, sign, or submit any trades.
 */
export const RULE_CONFIRMATION_POLICY="confirmation-evidence-guard-v1";
export const ruleConfirmationEnabled=()=>process.env.WATERX_RULE_CONFIRMATION_ENABLED!=="false";
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
   return priceAreaFeatures({points:input.priceObservations?.length?input.priceObservations:points,startMs:input.startMs,expiryMs:input.expiryMs,asOfMs:input.nowMs,
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
  return !!p&&p.qualified===true&&p.stage===stage&&p.interval===input.intervalMinutes&&
    p.featureVersion===TWO_STAGE_FEATURES&&p.trainedBeforeMs<input.startMs&&p.selectedCalibrationN>=60&&
    p.selectedBothOutcomes===true&&Number.isFinite(p.selectedBrier)&&p.selectedBrier<.25&&
    p.outcome.coefficients.length===8&&p.calibration.coefficients.length===1&&
    [p.minimumStrength,p.outcome.intercept,p.calibration.intercept,...p.outcome.coefficients,...p.calibration.coefficients].every(Number.isFinite)&&
    p.minimumStrength>=.5&&p.minimumStrength<1;
}
export function assessStage(input:StageInput,stage:LockStage,early:StageLock|null,policy:LearnedStagePolicy|null=null){
  input={...input,observations:input.observations.filter(o=>o.availableAtMs<=input.nowMs&&
    o.receivedAtMs<=input.nowMs&&o.receivedAtMs>=input.startMs&&o.receivedAtMs<input.expiryMs)};
  const q=stage==="EARLY"?earlyCandidate(input):eventQualification(input,input.observations,input.nowMs),latest=input.observations.at(-1);
  const diagnostics:StageDiagnostics="diagnostics" in q?q.diagnostics:{message:q.remainingRequirement??"Building additional evidence",
    measurements:{...q.components},thresholds:{stage,policy:"unchanged-confirmation-guard"}};
  if(input.nowMs>=input.expiryMs)return {eligible:false,reason:"ROUND_EXPIRED"};
  if(stage==="CONFIRMATION"&&input.expiryMs-input.nowMs<CONFIRMATION_ORDER_RESERVE_MS)
    return {eligible:false,reason:"ABSTAINED_INSUFFICIENT_ORDER_TIME"};
  if(!latest||!latest.sourceHealthy||!validWaterxProbabilityPair(latest.probabilityUp,latest.probabilityDown)||
    input.nowMs-latest.receivedAtMs>5000)return {eligible:false,reason:"WAITING_FOR_FRESH_DATA"};
  if(stage==="CONFIRMATION"&&early&&latest.id===early.observationIds.at(-1))
    return {eligible:false,reason:"WAITING_FOR_ADDITIONAL_EVIDENCE"};
  const learnedConfirmation=stage==="CONFIRMATION"&&validatedStagePolicy(policy,input,stage);
  const ruleConfirmation=stage==="CONFIRMATION"&&!learnedConfirmation&&ruleConfirmationEnabled();
  if(stage==="CONFIRMATION"&&!learnedConfirmation&&!ruleConfirmation)
     return {eligible:false,reason:"CONFIRMATION_POLICY_NOT_QUALIFIED",
       diagnostics:{message:"Confirmation model not available",measurements:{stage,interval:input.intervalMinutes},
         thresholds:{requires:"Eligible interval-specific, stage-selected calibrated policy or explicitly enabled rule confirmation"}}};
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
    // Rule mode needs independently changed, pre-decision market evidence.
    // Merely repeating the same provider quote across polls is not confirmation.
    if(ruleConfirmation){
      // A moving Coinbase comparison chart is NOT a second independent
      // WaterX quote. Confirmation needs at least two distinct valid
      // provider odds pairs observed within this exact round.
      const distinct=new Set(input.observations.filter(o=>o.sourceHealthy&&
        validWaterxProbabilityPair(o.probabilityUp,o.probabilityDown)).map(o=>
        JSON.stringify([o.probabilityUp,o.probabilityDown])));
      if(distinct.size<2)return {eligible:false,reason:"WAITING_FOR_INDEPENDENT_EVIDENCE",
        diagnostics:{message:"WaterX odds have not changed; Coinbase-only chart movement cannot confirm the market direction.",
          measurements:{distinctWaterxQuotes:distinct.size},
          thresholds:{requiredDistinctWaterxQuotes:2,policyVersion:RULE_CONFIRMATION_POLICY}}};
      if(early&&latest.availableAtMs<=early.evidenceCutoffMs)
        return {eligible:false,reason:"WAITING_FOR_ADDITIONAL_EVIDENCE"};
    }
  }
  if(!q.qualified||!q.liveSide)return {eligible:false,reason:q.blocker,diagnostics};
  let side=q.liveSide,probabilityUp=latest.probabilityUp,source="WATERX_MARKET",modelVersion:null|string=null;
  let calibrationStatus:"UNQUALIFIED"|"QUALIFIED"="UNQUALIFIED",policyVersion=
    ruleConfirmation?RULE_CONFIRMATION_POLICY:
    String((diagnostics.thresholds as Record<string,unknown>).version??"unchanged-confirmation-guard");
  if(validatedStagePolicy(policy,input,stage)){
     const x=stageModelFeatures(input);if(!x)return {eligible:false,reason:"INSUFFICIENT_PRICE_COVERAGE",
       diagnostics:{message:"Price coverage insufficient",measurements:{coverage:accumulatedFeatures(input).coverageFraction},
         thresholds:{minimumPriceCoverage:.9}}};
    const raw=sigmoid(policy!.outcome.intercept+x.reduce((s,v,i)=>s+v*policy!.outcome.coefficients[i],0));
    if(Math.max(raw,1-raw)<policy!.minimumStrength)return {eligible:false,reason:"NO_QUALIFYING_STAGE_OPPORTUNITY"};
    probabilityUp=sigmoid(policy!.calibration.intercept+logit(raw)*policy!.calibration.coefficients[0]);
    side=raw>=.5?"UP":"DOWN";
    if((probabilityUp>=.5)!==(side==="UP"))return {eligible:false,reason:"CALIBRATED_DIRECTION_CONFLICT"};
    source="BLUEWATER_STAGE_SELECTED_CALIBRATED_MODEL";calibrationStatus="QUALIFIED";
    modelVersion=policy!.modelVersion;policyVersion=policy!.version;
  }
  const preference=input.researchPreference??researchPreference;
  const economics=economicEvidenceFromFeatures({...latest.features,researchValuePreference:preference,
    qualifiedForecast:calibrationStatus==="QUALIFIED"?{status:"QUALIFIED",source:"INDEPENDENT_MODEL",
      probability:side==="UP"?probabilityUp:1-probabilityUp,modelVersion,calibrationVersion:policyVersion}:null},
    input.roundId,side,input.nowMs);
  const valueStatus=economics.totalReturnedIfCorrectUsd==null?"UNAVAILABLE":
    economics.totalReturnedIfCorrectUsd<preference.minimumReturnUsd?"BELOW_PREFERRED":"MET";
  if(preference.mode==="REQUIRED"&&valueStatus!=="MET")return {eligible:false,reason:"NO_QUALIFYING_EARLY_VALUE",
    diagnostics:{...diagnostics,message:economics.totalReturnedIfCorrectUsd==null?"Required entry return unavailable":
      `Entry return below your $${preference.minimumReturnUsd} requirement.`,
      measurements:{...diagnostics.measurements,returnUsd:economics.totalReturnedIfCorrectUsd},
      thresholds:{...diagnostics.thresholds,minimumReturnUsd:preference.minimumReturnUsd,mode:preference.mode}}};
  return {eligible:true,reason:calibrationStatus==="QUALIFIED"?"QUALIFIED_STAGE_POLICY":
      ruleConfirmation?"RULE_CONFIRMED_MARKET_EVIDENCE_UNCALIBRATED":"EXPERIMENTAL_MARKET_BASELINE_NOT_MODEL_EDGE",
    side,probabilityUp,probabilitySource:source,calibrationStatus,modelVersion,policyVersion,economics,
     priceFeatures:accumulatedFeatures(input),diagnostics,researchPreference:preference,valueStatus};
}
