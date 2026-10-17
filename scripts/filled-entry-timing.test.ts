import test from "node:test";
import assert from "node:assert/strict";
import {dollarOutcome} from "../shared/dollar-entry-target";
import {checkEntryProof,clockBand,outcomeOfEntry,researchVerifiedFills,type EntryFillEvidence} from "../server/waterx/filled-entry-training";
const start=1_793_000_000_000;
function evidence(index:number,interval:5|15=5):EntryFillEvidence {
  const st=start+index*interval*60000,exp=st+interval*60000,up=index%2===0;
  const marketId="0x"+String(index).padStart(64,"0"),roundId="round-"+index;
  return {intervalMinutes:interval,roundId,marketId,startMs:st,expiryMs:exp,
    side:"UP",filledAtMs:st+(.05+(index%4)*.23)*interval*60000,
    fillId:"fill-"+index,fillPriceCents:70,stakeUsd:5,entryFeesUsd:0.05,gasUsd:0.01,
    fillProof:{source:"WATERX_EXECUTION_RECEIPT",receiptId:"fill-"+index,marketId,verified:true},
    settlement:{source:"WATERX_VERIFIED_CHAINLINK_TWAP60",roundId,marketId,verified:true,disputed:false,
      anchorPrice:81000,settlementPrice:up?81010:80990,
      settledAtMs:exp+1000,labelAvailableAtMs:exp+2000,proofId:"settled-"+index}};
}
test("profit thresholds reflect winning-only $1–$2 target, not success probability",()=>{
  const mid=dollarOutcome(75,5,.05)!;
  assert.ok(mid.netIfCorrectUsd>1&&mid.netIfCorrectUsd<2);
  assert.ok(mid.maxAskForOneDollarProfitCents<83.34);
  assert.ok(mid.maxAskForTwoDollarProfitCents<71.43);
  assert.equal(mid.netIfIncorrectUsd,-5.05);
  assert.equal(dollarOutcome(100,5,0)?.target,"BELOW_ONE_DOLLAR");
  assert.equal(dollarOutcome(0),null);
  assert.equal(dollarOutcome(101),null);
  assert.equal(dollarOutcome(70,5,-1),null);
});
test("verified WaterX TWAP60 direction gives actual settled net, not market-implied certainty",()=>{
  const win=evidence(0),loss=evidence(1);
  assert.equal(checkEntryProof(win,win.expiryMs+9000),null);
  assert.equal(outcomeOfEntry(win).correct,true);
  assert.equal(outcomeOfEntry(loss).correct,false);
  assert.equal(outcomeOfEntry(loss).netUsd,-5.06);
  assert.equal(outcomeOfEntry(win).netWinningUsd>2,true);
  assert.equal(clockBand(evidence(0)),"FIRST_20_PERCENT");
  assert.equal(clockBand(evidence(1)),"EARLY_20_TO_40");
});
test("missing, disputed, mismatched or after-entry settlement/forecast evidence excluded",()=>{
  const r=evidence(0),now=r.expiryMs+10000;
  assert.equal(checkEntryProof({...r,fillProof:{...r.fillProof,verified:false}},now),"FILL_PROOF_UNVERIFIED");
  assert.equal(checkEntryProof({...r,settlement:{...r.settlement,disputed:true}},now),"SETTLEMENT_PROOF_UNVERIFIED");
  assert.equal(checkEntryProof({...r,settlement:{...r.settlement,source:"WATERX_VERIFIED_CHAINLINK_TWAP60",marketId:"wrong"}},now),"SETTLEMENT_PROOF_UNVERIFIED");
  assert.equal(checkEntryProof({...r,filledAtMs:r.expiryMs},now),"INVALID_OR_LATE_FILL");
  assert.equal(checkEntryProof({...r,settlement:{...r.settlement,labelAvailableAtMs:now+2000}},now),"SETTLEMENT_TIMING_OR_PRICE_INVALID");
  assert.equal(checkEntryProof({...r,forecast:{source:"INDEPENDENT_MODEL",version:"v1",probabilityForSelection:.9,calibrationQualified:true,createdAtMs:r.filledAtMs+1,qualifiedAtMs:r.filledAtMs}},now),"FORECAST_NOT_INDEPENDENT_OR_PRE_ENTRY");
});
test("chronological training uses unique rounds, forward label embargo and sealed test cohort",()=>{
  const rows=Array.from({length:200},(_,i)=>evidence(i));
  const now=rows.at(-1)!.expiryMs+10000;
  const r=researchVerifiedFills(rows,5,now);
  assert.equal(r.status,"OBSERVATIONAL_TEST_AVAILABLE");
  assert.equal(r.automaticPromotion,false);
  assert.equal(r.tradeAuthority,false);
  assert.equal(r.qualifiedEdge,false);
  assert.equal(r.testN,40);
  assert.equal(r.testCohorts.reduce((sum,c)=>sum+c.count,0),40);
  const duplicate=researchVerifiedFills([rows[0],rows[0]],5,now);
  assert.equal(duplicate.excluded.MULTIPLE_FILLS_SAME_ROUND,1);
  assert.equal(duplicate.status,"INSUFFICIENT_VERIFIED_FILLS");
  const future=researchVerifiedFills(rows,5,rows[0].startMs);
  assert.equal(future.testN,0);
  assert.ok(future.excluded.SETTLEMENT_TIMING_OR_PRICE_INVALID>0);
});
test("no model, no full fill or no verified TWAP label means no trade-ready timing training",()=>{
 const rows=Array.from({length:200},(_,i)=>({...evidence(i),fillProof:{...evidence(i).fillProof,verified:false}}));
 const r=researchVerifiedFills(rows as EntryFillEvidence[],5,rows.at(-1)!.expiryMs+10000);
 assert.equal(r.acceptedUniqueRounds,0);
 assert.equal(r.testN,0);
 assert.equal(r.qualifiedEdge,false);
});
