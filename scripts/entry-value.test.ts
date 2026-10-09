import test from "node:test";
import assert from "node:assert/strict";
import {entryEconomics,type VerifiedEntryQuote,validateValuePreference,frozenEntryFeatures} from "../shared/lock-economics";
import {firstValueOpportunity,economicTrainingReadiness} from "../server/waterx/event-value-evidence";
import {historyTimeRange,timedHistoryQuery} from "../server/waterx/timed-history";
import {dollarsToAtomicAmount,signReviewedOwnerTransaction} from "../client/src/owner-wallet-signing";
import {Transaction} from "@mysten/sui/transactions";
import type {WalletAccount} from "@mysten/wallet-standard";
import {liveExecutionReadiness} from "../server/agent/live-readiness";
import {websiteControlPlaneStatus} from "../infrastructure/agent-signer/control-plane";

const now=1800000000000;
const quote:VerifiedEntryQuote={verified:true,fullSize:true,network:"sui:mainnet",roundId:"r",marketId:"m",side:"UP",
  quoteId:"q",quotedAtMs:now-100,expiresAtMs:now+3000,executionCutoffAtMs:now+60000,
  collateralUsd:5,feesUsd:.1,totalEntryCostUsd:5.1,shares:"7000000",payoutRule:"Binary payout; zero recovery",
  returnedIfCorrectUsd:7,returnedIfIncorrectUsd:0,gasSui:.01,gasUsd:.02,gasValuationBasis:"Contemporaneous SUI/USD",
  partialFill:"FILL_OR_KILL",limitsEnforced:true,maxSpendUsd:5.1,minimumShares:"7000000",maximumPrice:.75};
const forecast={status:"QUALIFIED" as const,source:"INDEPENDENT_MODEL" as const,probability:.8,modelVersion:"m",calibrationVersion:"c"};
const input={roundId:"r",marketId:"m",side:"UP" as const,nowMs:now};
test("public asks remain indicative: gross can exceed $7, no modeled edge, net or fill",()=>{
  const e=entryEconomics({...input,askCents:50,forecast});
  assert.equal(e.kind,"INDICATIVE");assert.equal(e.totalReturnedIfCorrectUsd,10);
  assert.equal(e.netProfitIfCorrectUsd,null);assert.equal(e.expectedNetUsd,null);assert.equal(e.preferenceMet,null);
  assert.equal(e.executionEligible,false);assert.equal(e.totalCostUsd,null);
});
test("archived entry asks come only from the exact frozen available observation",()=>{
  const features={purchaseUp:{status:"reported",askCents:70}};
  const evidence={observations:[{id:"chosen",availableAtMs:now,receivedAtMs:now-10,features},
    {id:"later",availableAtMs:now+1,receivedAtMs:now+1,features:{purchaseUp:{status:"reported",askCents:10}}}]};
  assert.deepEqual(frozenEntryFeatures(evidence,"chosen",now),features);
  assert.equal(frozenEntryFeatures(evidence,"later",now),undefined);
});
test("verified binary accounting includes fees and gas exactly once",()=>{
  const e=entryEconomics({...input,quote,forecast});
  assert.equal(e.kind,"VERIFIED_QUOTE");assert(Math.abs(e.totalCostUsd!-5.12)<1e-10);
  assert(Math.abs(e.expectedNetUsd!-.48)<1e-10);assert(Math.abs(e.netProfitIfCorrectUsd!-1.88)<1e-10);
  assert(Math.abs(e.lossIfIncorrectUsd!-5.12)<1e-10);assert.equal(e.executionEligible,false);
});
test("nonzero loss recovery uses actual protocol payout rather than assuming total loss",()=>{
  const e=entryEconomics({...input,quote:{...quote,returnedIfIncorrectUsd:1},forecast});
  assert(Math.abs(e.expectedNetUsd!-.68)<1e-10);assert(Math.abs(e.lossIfIncorrectUsd!-4.12)<1e-10);
});
test("market odds cannot qualify independent expected value",()=>{
  const e=entryEconomics({...input,quote,forecast:{...forecast,source:"MARKET" as any}});
  assert.equal(e.kind,"VERIFIED_QUOTE");assert.equal(e.expectedNetUsd,null);
});
test("stale, wrong-side, partial-size and unenforced quotes fail closed",()=>{
  for(const changed of [{roundId:"other"},{side:"DOWN"},{fullSize:false},{quotedAtMs:now-10001},
    {expiresAtMs:now},{executionCutoffAtMs:now},{limitsEnforced:false},{partialFill:"PARTIAL"},
    {totalEntryCostUsd:5.2},{gasValuationBasis:""},{minimumShares:"8000000"},{maximumPrice:0}]){
    assert.equal(entryEconomics({...input,quote:{...quote,...changed} as VerifiedEntryQuote,forecast}).kind,"UNAVAILABLE");
  }
});
test("value policy locks first valid candidate, not a hindsight-best return or highest market odds",()=>{
  const row={atMs:now,qualified:true,roundId:"r",marketId:"m",side:"UP" as const,quote,forecast};
  assert.equal(firstValueOpportunity([{...row,quote:null},row,{...row,atMs:now+1,quote:{...quote,returnedIfCorrectUsd:9}}]).atMs,now);
  assert.equal(firstValueOpportunity([{...row,forecast:null}]).action,"ABSTAIN");
  assert.equal(firstValueOpportunity([{...row,forecast:{...forecast,probability:.6}}]).action,"ABSTAIN");
  assert.equal(firstValueOpportunity([row],{collateralUsd:5,minimumReturnUsd:6,preferredReturnUsd:7}).action,"LOCK");
  assert.throws(()=>firstValueOpportunity([row,{...row,atMs:now-1,quote:null}],undefined,99),/chronological/);
});
test("value training cannot turn missing verified quotes into economically qualified examples",()=>{
  const r=economicTrainingReadiness([],5,now);
  assert.equal(r.status,"NOT_QUALIFIED");assert.equal(r.learnedEconomicStoppingArtifact,null);
  assert.equal(r.deficits.TEST.missingRounds,60);assert.equal(r.positiveModelEdgeAuthorized,false);
  assert.throws(()=>validateValuePreference({collateralUsd:5,minimumReturnUsd:5,preferredReturnUsd:7}));
});
test("History today uses browser timezone, custom boundaries are start-inclusive/end-exclusive",()=>{
  const midnight=Date.UTC(2026,9,7,6);
  assert.equal(historyTimeRange(timedHistoryQuery.parse({window:"today",timezoneOffsetMinutes:360}),midnight+60000).since,midnight);
  assert.deepEqual(historyTimeRange(timedHistoryQuery.parse({window:"custom",fromMs:10,toMs:20}),100),{since:10,until:20});
  assert.throws(()=>timedHistoryQuery.parse({window:"custom",fromMs:20,toMs:10}));
  assert.throws(()=>timedHistoryQuery.parse({deployment:"fabricated"}));
});
test("dollar-to-atomic conversion is exact, positive, bounded, and rejects exponent notation",()=>{
  assert.equal(dollarsToAtomicAmount("5.000001"),"5000001");assert.equal(dollarsToAtomicAmount("0.000001"),"1");
  for(const s of ["0","-1","5.0000001","1e6","NaN","18446744073709551616"])assert.equal(dollarsToAtomicAmount(s),null);
});
const account={address:"0x"+"1".repeat(64),chains:["sui:mainnet"],features:["sui:signAndExecuteTransaction"],publicKey:new Uint8Array(32)} as WalletAccount;
test("owner wallet signing checks account/network/action and uses exact prepared JSON once",async()=>{
  const tx=new Transaction();tx.setSender(account.address);
  const transaction=await tx.toJSON();let calls=0;
  const wallet={accounts:[account],features:{"sui:signAndExecuteTransaction":{signAndExecuteTransaction:async(v:any)=>{
    calls++;assert.equal(v.chain,"sui:mainnet");assert.equal(v.account,account);
    assert.equal(v.transaction.getData().sender,account.address);return {digest:"1".repeat(44)};
  }}}};
  const input={wallet,account,transaction,action:"CREATE_ACCOUNT",isCurrent:()=>true};
  assert.equal((await signReviewedOwnerTransaction(input)).digest,"1".repeat(44));assert.equal(calls,1);
  await assert.rejects(signReviewedOwnerTransaction({...input,action:"AUTHORIZE"}),/released/);
  await assert.rejects(signReviewedOwnerTransaction({...input,isCurrent:()=>false}),/Reconnect/);
  await assert.rejects(signReviewedOwnerTransaction({...input,account:{...account,chains:["sui:testnet"]}}),/Reconnect/);
  assert.equal(calls,1);
});
test("transport cancellation remains uncertain; only explicit wallet rejection clears submission",async()=>{
  const tx=new Transaction();tx.setSender(account.address);const transaction=await tx.toJSON();
  const input={account,transaction,action:"CREATE_ACCOUNT",isCurrent:()=>true};
  const walletFor=(error:Error)=>({features:{"sui:signAndExecuteTransaction":{signAndExecuteTransaction:async()=>{throw error;}}}});
  await assert.rejects(signReviewedOwnerTransaction({...input,wallet:walletFor(new Error("RPC request cancelled after submit"))}),
    (e:any)=>e.submissionState!=="NOT_SUBMITTED");
  await assert.rejects(signReviewedOwnerTransaction({...input,wallet:walletFor(Object.assign(new Error("Rejected"),{code:4001}))}),
    (e:any)=>e.submissionState==="NOT_SUBMITTED");
});
test("readiness never treats absent credentials or implemented builders as a released agent",()=>{
  for(const env of [{},{CLOUDFLARE_API_KEY:"test-only-non-secret"}]){
    const r=liveExecutionReadiness(websiteControlPlaneStatus(env));
    assert.equal(r.released,false);assert(r.items.every(i=>i.status!=="VERIFIED"));
    assert(r.blocker&&r.nextAction);assert(r.items.some(i=>i.id==="control-plane"&&i.status==="BLOCKED"));
  }
});
