import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {reconcileRealFill,type VerifiedHistoryRound,type FilledPosition} from "../shared/real-fill-audit";

const start=1_792_000_000_000,expiry=start+300_000;
const history:VerifiedHistoryRound={
  marketId:"waterx-market-EXACT",roundId:"BTC-5m-EXACT",intervalMinutes:5,
  startMs:start,expiryMs:expiry,outcome:"DOWN",settlementStatus:"VERIFIED",
  primary:{side:"UP",acknowledgedAtMs:start+160_000,score:"INCORRECT",policyVersion:"bench"},
  early:{side:"DOWN",acknowledgedAtMs:start+45_000,score:"CORRECT",policyVersion:"early"},
  confirmation:{side:"DOWN",acknowledgedAtMs:null,score:"NO_LOCK",policyVersion:null},
};
const fill:FilledPosition={
  marketId:history.marketId!,roundId:history.roundId,intervalMinutes:5,startMs:start,
  expiryMs:expiry,filledAtMs:start+120_000,side:"UP",priceCents:67.6,stakeUsd:5,
  actualPayoutUsd:0,feesUsd:0,
};
test("waterx actual losing fill matches exact stage timing without fabricating late advice",()=>{
  const a=reconcileRealFill(history,fill);
  assert.equal(a.status,"MATCHED");
  assert.equal(a.tradeCorrect,false);
  assert.equal(a.officialOutcome,"DOWN");
  assert.equal(a.actualNetPnlUsd,-5);
  assert.equal(a.actualPnlStatus,"USER_REPORTED");
  assert.equal(a.early?.state,"FROZEN_BEFORE_FILL");
  assert.equal(a.early?.agreedWithTrade,false);
  assert.equal(a.primary?.state,"FROZEN_AFTER_FILL");
  assert.equal(a.primary?.agreedWithTrade,null,"later primary forecast cannot explain entry");
  assert.equal(a.confirmation?.state,"MISSING_ACKNOWLEDGED_SIGNAL");
  assert.ok(Math.abs(a.estimatedGrossIfCorrect!-5/.676)<1e-9);
  assert.ok(Math.abs(a.breakEvenBeforeFees!-.676)<1e-9);
});
test("similar clock time, missing market ID or different boundaries never matches",()=>{
  for(const p of [
    {...fill,marketId:"UNKNOWN"},
    {...fill,marketId:""},
    {...fill,roundId:"OTHER"},
    {...fill,startMs:start+1},
    {...fill,expiryMs:expiry+1},
    {...fill,intervalMinutes:15 as const},
  ]){
    const a=reconcileRealFill(history,p);
    assert.equal(a.status,"ROUND_IDENTITY_MISMATCH");
    assert.equal(a.primary,null);
    assert.equal(a.actualNetPnlUsd,null);
  }
  assert.equal(reconcileRealFill(history,{...fill,filledAtMs:expiry}).status,"FILL_TIME_UNVERIFIED");
  assert.equal(reconcileRealFill(history,{...fill,filledAtMs:start-1}).status,"FILL_TIME_UNVERIFIED");
});
test("unknown official outcome or omitted actual fee/payout leaves realized P&L unknown",()=>{
  assert.equal(reconcileRealFill({...history,settlementStatus:"PENDING"},fill).actualNetPnlUsd,null);
  assert.equal(reconcileRealFill(history,{...fill,actualPayoutUsd:null}).actualNetPnlUsd,null);
  assert.equal(reconcileRealFill(history,{...fill,feesUsd:null}).actualNetPnlUsd,null);
});
test("invalid supplied prices/costs are blocked, no invented quotes or order execution",()=>{
  for(const p of [{...fill,priceCents:0},{...fill,priceCents:110},
    {...fill,stakeUsd:-5},{...fill,feesUsd:-1},{...fill,filledAtMs:NaN}]){
      assert.equal(reconcileRealFill(history,p).status,"INVALID_ENTRY");
  }
  const ui=readFileSync(new URL("../client/src/RealFillAuditPanel.tsx",import.meta.url),"utf8");
  assert.match(ui,/Compare a real filled WaterX position with frozen signals/);
  assert.match(ui,/No verified frozen prediction before entry/);
  assert.match(ui,/not independently verified/i);
  assert.doesNotMatch(ui,/placeOrder|signAndExecuteTransaction|localStorage|setInterval/);
  const historyUi=readFileSync(new URL("../client/src/DecisionLineageHistory.tsx",import.meta.url),"utf8");
  assert.match(historyUi,/<RealFillAuditPanel round=\{r\}\/>/);
});
