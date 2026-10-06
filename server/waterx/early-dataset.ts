import {earlyHorizons,TIMED_STRATEGY} from "../../shared/timed-decision";
import {validWaterxProbabilityPair} from "../../shared/round-decision";
import {digestEarlySnapshot} from "./early-horizons";
import type {EarlyTrainingRow} from "./early-training";

/** Keep exclusions visible: the SQL caller LEFT JOINs labels and does not
 * pre-filter away failures. One primary reason per row, in declared order. */
export function auditEarlyDataset(records:Record<string,any>[],interval:5|15,cutoff:number){
  const stages=["validIdentity","timelyFeatures","verifiedOutcome","correctStrategySchema","eligibleHorizon"] as const;
  const counts=Object.fromEntries(stages.map(s=>[s,0])) as Record<typeof stages[number],number>;
  const byReason:Record<string,number>={},audit:{roundId:string;startMs:number;horizon:number;primaryReason:string|null;details:Record<string,unknown>}[]=[];
  const rows:EarlyTrainingRow[]=[],seen=new Set<string>();
  for(const r of records){
    const s=r.snapshot??{},start=Number(r.start_ms),expiry=Number(r.expiry_ms),horizon=Number(r.horizon_seconds);
    let reason:string|null=null;
    const fail=(code:string)=>{if(reason===null)reason=code;};
    if(r.network!=="sui:mainnet"||Number(r.interval_minutes)!==interval||!Number.isSafeInteger(start)||
      !Number.isSafeInteger(expiry)||expiry-start!==interval*60000||s.roundId!==r.round_id||
      s.startMs!==start||s.expiryMs!==expiry||s.intervalMinutes!==interval)fail("INVALID_IDENTITY");
    if(!reason)counts.validIdentity++;
    const scheduled=start+horizon*1000;
    if(r.status!=="FROZEN")fail(r.status==="MISSED_HORIZON"?"MISSED_HORIZON":"CAPTURE_DATA_FAILURE");
    if(s.status!==r.status||s.scheduledAtMs!==scheduled||Number(r.scheduled_at_ms)!==scheduled||
      s.frozenAtMs!==Number(r.frozen_at_ms)||s.frozenAtMs<scheduled||s.frozenAtMs>scheduled+2000||
      !Number.isSafeInteger(s.receivedAtMs)||s.receivedAtMs>scheduled||s.receivedAtMs<start||
      scheduled-s.receivedAtMs>10000)fail("UNTIMELY_FEATURES");
    if(s.frozenAtMs>cutoff)fail("FEATURES_AFTER_DATASET_CUTOFF");
    if(!validWaterxProbabilityPair(s.probabilityUp,s.probabilityDown)||!s.features)fail("INVALID_PROBABILITY_OR_FEATURES");
    const cross=s.features?.crossInterval;
    if(cross?.available===true&&(cross.availableAtMs>scheduled||cross.receivedAtMs>scheduled||
      cross.providerSourceAtMs!=null&&cross.providerSourceAtMs>scheduled))fail("FUTURE_CROSS_INTERVAL_FEATURE");
    if(!reason)counts.timelyFeatures++;
    const label=Number(r.label_available_at_ms),settled=Number(r.settled_at),outcome=String(r.outcome??"").toUpperCase();
    if(!r.label_status)fail("SETTLEMENT_JOIN_MISSING");
    else if(r.settlement_disputed||r.settlement_quarantine&&JSON.stringify(r.settlement_quarantine)!=="[]")fail("DISPUTED_OR_QUARANTINED_LABEL");
    else if(r.label_status!=="verified")fail("OUTCOME_NOT_VERIFIED");
    else if(r.label_available_at_ms==null||!Number.isFinite(label))fail("LABEL_AVAILABILITY_MISSING");
    else if(label>cutoff||settled>cutoff)fail("LABEL_AFTER_DATASET_CUTOFF");
    else if(settled<=expiry||label<settled||!["UP","DOWN"].includes(outcome)||
      !Number.isFinite(Number(r.settle_price))||Number(r.settle_price)<=0||
      !Number.isFinite(Number(r.settlement_anchor_price))||Number(r.settlement_anchor_price)<=0||
      (outcome==="UP")!==(Number(r.settle_price)>=Number(r.settlement_anchor_price)))fail("INVALID_SETTLEMENT_EVIDENCE");
    if(!reason)counts.verifiedOutcome++;
    if(r.strategy_version!==TIMED_STRATEGY||s.strategyVersion!==TIMED_STRATEGY||s.schema!=="bluewater-early-horizon-v1")
      fail("WRONG_STRATEGY_OR_SCHEMA");
    if(digestEarlySnapshot(s)!==r.snapshot_sha256)fail("SNAPSHOT_DIGEST_REJECTED");
    if(!reason)counts.correctStrategySchema++;
    if(s.horizonSeconds!==horizon||!earlyHorizons(interval).includes(horizon))fail("INELIGIBLE_HORIZON");
    const key=`${r.round_id}:${start}:${expiry}:${horizon}`;
    if(!reason&&seen.has(key))fail("DUPLICATE_EXACT_HORIZON");
    if(!reason){
      counts.eligibleHorizon++;seen.add(key);
      rows.push({interval,roundId:String(r.round_id),startMs:start,expiryMs:expiry,horizon,
        probability:s.probabilityUp,outcome:outcome as "UP"|"DOWN",labelAvailableAtMs:label,
        snapshotDigest:String(r.snapshot_sha256),features:s.features});
    }else byReason[reason]=(byReason[reason]??0)+1;
    audit.push({roundId:String(r.round_id),startMs:start,horizon,primaryReason:reason,
      details:{captureStatus:r.status,labelStatus:r.label_status??null,labelAvailableAtMs:r.label_available_at_ms??null,
        outcome:r.outcome??null,settledAtMs:r.settled_at??null,settlePrice:r.settle_price??null,
        settlementAnchorPrice:r.settlement_anchor_price??null,
        frozenAtMs:r.frozen_at_ms,strategyVersion:r.strategy_version,snapshotDigest:r.snapshot_sha256}});
  }
  return {rows,funnel:{captured:records.length,...counts,selected:rows.length,excluded:records.length-rows.length,
    byReason,rows:audit},datasetDigest:digestEarlySnapshot(audit)};
}
