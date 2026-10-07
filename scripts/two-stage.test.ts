import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import pg from "pg";
import {priceAreaFeatures,unverifiedSettlementRule,type PricePoint} from "../shared/price-area";
import {stageRelationship,type StageLock,type StageInput} from "../shared/two-stage";
import {createTwoStageRuntime} from "../server/waterx/two-stage-runtime";
import {readStageLocks,commitStage,stageIdentity} from "../server/waterx/two-stage-store";
import {assessStage,validatedStagePolicy,type LearnedStagePolicy} from "../server/waterx/two-stage-policy";
import {scoreStageRounds} from "../server/waterx/two-stage-history";
import {trainTwoStage} from "../server/waterx/two-stage-learning";
const start=1791300000000;
const point=(t:number,price:number,available=t):PricePoint=>({id:String(t),atMs:start+t,availableAtMs:start+available,
  price,reference:100,source:"Coinbase comparison"});
test("irregular piecewise linear integration splits positive and negative area at crossings",()=>{
  const f=priceAreaFeatures({points:[point(0,102),point(1000,100),point(3000,98)],reference:100,
    referenceConfirmed:false,startMs:start,expiryMs:start+300000,asOfMs:start+3000});
  assert.equal(f.signedAreaUsdSeconds,-1);assert.equal(f.positiveAreaUsdSeconds,1);
  assert.equal(f.negativeAreaUsdSeconds,2);assert.equal(f.observedMs,3000);
  assert.equal(f.fractionObservedTimeAbove,1/3);assert.equal(f.fractionObservedTimeBelow,2/3);
  assert.equal(f.remainingReversalAveragePrice,null);
  const crossing=priceAreaFeatures({points:[point(0,102),point(2000,98)],reference:100,referenceConfirmed:false,
    startMs:start,expiryMs:start+300000,asOfMs:start+2000});
  assert.equal(crossing.crossings,1);assert.equal(crossing.positiveAreaUsdSeconds,1);assert.equal(crossing.negativeAreaUsdSeconds,1);
});
test("gaps, future availability, duplicate timestamps and changed references never fabricate coverage",()=>{
  const f=priceAreaFeatures({points:[point(0,101),point(1000,101),point(10000,101),point(11000,101,12000),
    point(1000,101),{...point(11000,101),reference:102}],reference:100,referenceConfirmed:true,
    startMs:start,expiryMs:start+300000,asOfMs:start+11000});
  assert.equal(f.observedMs,1000);assert.equal(f.missingMs,10000);
  assert.equal(f.currentDistanceUsd,null);assert.equal(f.remainingReversalAveragePrice,null);
  assert.equal(f.referenceMismatchN,1);
});
test("remaining average formula is withheld unless all rule assumptions and complete observed coverage hold",()=>{
  const args={points:[point(0,102),point(1000,102)],reference:100,referenceConfirmed:true,
    startMs:start,expiryMs:start+3000,asOfMs:start+1000};
  assert.equal(priceAreaFeatures(args).remainingReversalAveragePrice,null);
  const rule={...unverifiedSettlementRule,verified:true,method:"CONTINUOUS_FULL_ROUND_AVERAGE" as const,
    oracle:"fixture-oracle",feed:"fixture-feed",referenceAtMs:start,referenceValue:100,rounding:"none",tieRule:"UP_ON_EQUAL"};
  assert.equal(priceAreaFeatures({...args,rule}).remainingReversalAveragePrice,99);
  assert.equal(priceAreaFeatures({...args,rule,asOfMs:start+3000}).reversalStatus,"EXPIRED");
});
const input=(roundId="two-stage-fixture",up=.8):StageInput=>({marketId:"fixture-market",roundId,intervalMinutes:5,startMs:start,
  expiryMs:start+300000,nowMs:start+26000,observations:Array.from({length:14},(_,i)=>({
    id:`${roundId}-${i}`,atMs:start+i*2000,receivedAtMs:start+i*2000,availableAtMs:start+i*2000,
    databaseAcceptedAtMs:start+i*2000,providerSourceAtMs:null,probabilityUp:up,probabilityDown:1-up,
    sourceHealthy:true,provenance:"SYNTHETIC" as const,features:{marketId:"fixture-market",reference:100,
      referenceQuality:"provisional",comparison:{price:100+i*.1,asOf:new Date(start+i*2000).toISOString(),source:"Coinbase comparison"},
      purchaseUp:{status:"reported",askCents:70},purchaseDown:{status:"reported",askCents:70}}}))});
const locked=(stage:"EARLY"|"CONFIRMATION",side:"UP"|"DOWN"):StageLock=>({
  ...input(),observations:undefined,nowMs:undefined,id:`fixture-${stage}`,network:"sui:mainnet",strategyVersion:"waterx-two-stage-shadow-v1",
  stage,side,evidenceCutoffMs:start+18000,qualifiedAtMs:start+18000,committedAtMs:start+18001,
  elapsedMs:18000,remainingMs:282000,probabilityUp:side==="UP"?.8:.2,probabilitySource:"WATERX_MARKET",calibrationStatus:"UNQUALIFIED",
  modelVersion:null,policyVersion:"fixture",featureVersion:"price-area-proxy-v1",observationIds:["fixture-9"],
  economics:assessStage(input(),"EARLY",null).economics!,reference:null,coverage:null,features:null,
  captureMode:"SYNTHETIC",shadowOnly:true,automaticExecutionAllowed:false} as StageLock);
test("early uses unchanged guards and indicative value without claiming independent edge; confirmation requires its own qualified policy",()=>{
  const early=assessStage(input(),"EARLY",null);
  assert.equal(early.eligible,true);assert.equal(early.calibrationStatus,"UNQUALIFIED");
  assert.equal(early.economics?.expectedNetUsd,null);
  assert.equal(assessStage(input(),"CONFIRMATION",null).reason,"CONFIRMATION_POLICY_NOT_QUALIFIED");
  assert.equal(assessStage({...input(),nowMs:start+300000},"EARLY",null).eligible,false);
  const bad=input();bad.observations.at(-1)!.sourceHealthy=false;
  assert.equal(assessStage(bad,"EARLY",null).reason,"WAITING_FOR_FRESH_DATA");
});
test("stage scoring includes unconfirmed early predictions, keeps paired cases exclusive, and never treats agreement as confidence",()=>{
  const base={roundId:"fixture",marketId:"fixture-market",intervalMinutes:5 as const,startMs:start,expiryMs:start+300000,
    outcome:"UP" as const,disputed:false,dataFailure:false,earlyReason:"fixture",confirmationReason:"fixture"};
  const pairs:[[StageLock|null,StageLock|null],...Array<[StageLock|null,StageLock|null]>]=[
    [locked("EARLY","UP"),locked("CONFIRMATION","UP")],[locked("EARLY","DOWN"),locked("CONFIRMATION","UP")],
    [locked("EARLY","UP"),locked("CONFIRMATION","DOWN")],[locked("EARLY","DOWN"),locked("CONFIRMATION","DOWN")],
    [locked("EARLY","DOWN"),null],[null,locked("CONFIRMATION","UP")],[null,null]];
  const rows=pairs.map(([early,confirmation])=>({...base,early,confirmation,relationship:stageRelationship(early,confirmation)}));
  const stats=scoreStageRounds(rows);assert.equal(Object.values(stats.paired).reduce((n,v)=>n+v,0),7);
  assert.equal(stats.early.correct,2);assert.equal(stats.early.incorrect,3);assert.equal(stats.early.scoredN,5);
  assert.equal(stats.confirmation.correct,3);assert.equal(stats.confirmation.incorrect,2);
  assert.equal(stats.early.brier,null);assert.equal(stats.early.actualTradingPnl,null);
  assert.equal(stageRelationship(pairs[2][0],pairs[2][1]),"Changed direction");
});
test("small stage trajectories do not become a calibrated stopping policy or fabricated economic training",()=>{
  const report=trainTwoStage([],5,start+1000000);
  assert.equal(report.counts.TRAIN,0);assert.equal(report.fullSizeQuotePoints,0);
  assert.equal(report.positiveModelEdgeAuthorized,false);
  assert.equal(report.stages.CONFIRMATION.status,"NOT_QUALIFIED");
});
test("new strategy never dispatches orders; uncertainty recovery is read-before-retry",()=>{
  const runtime=readFileSync(new URL("../server/waterx/two-stage-runtime.ts",import.meta.url),"utf8");
  const store=readFileSync(new URL("../server/waterx/two-stage-store.ts",import.meta.url),"utf8");
  assert.doesNotMatch(runtime,/submitOrder|enqueueFinal|requestSigning/);
  assert.match(store,/UNKNOWN_TWO_STAGE_COMMIT/);assert.match(store,/readStageLocks/);
  assert.match(runtime,/restoreLocks\(e,await readStageLocks/);
});
test("isolated PostgreSQL stage locks are immutable, atomic, recoverable, and unique across workers",
  {skip:process.env.RUN_TIMED_POSTGRES_TESTS!=="1"},async()=>{
  const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:4});
  await db.query(readFileSync(new URL("../migrations/waterx-two-stage.sql",import.meta.url),"utf8"));
  await db.query(readFileSync(new URL("../migrations/waterx-two-stage-prices.sql",import.meta.url),"utf8"));
  const r=input("stage-db-"+Date.now());
  await db.query(`INSERT INTO waterx_two_stage_rounds(network,market_id,round_id,interval_minutes,strategy_version,
    start_ms,expiry_ms,discovered_at_ms,capture_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'SYNTHETIC')`,
    [...stageIdentity(r),r.startMs,r.expiryMs,r.nowMs]);
  const clients=await Promise.all([db.connect(),db.connect()]);
  try{
    const saved=await Promise.all(clients.map(c=>commitStage(r,"EARLY",null,null,c,()=>true,()=>r.nowMs)));
    const read=await readStageLocks(r,db);assert.equal(read.length,1);assert.equal(read[0].stage,"EARLY");
    assert.ok(saved.some(Boolean));assert.equal(read[0].commitVerified,true);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM waterx_two_stage_outbox WHERE decision_id=$1",[read[0].id])).rows[0].n,1);
    await assert.rejects(db.query("UPDATE waterx_two_stage_locks SET decision=decision WHERE id=$1",[read[0].id]),/immutable/);
    await assert.rejects(db.query("DELETE FROM waterx_two_stage_locks WHERE id=$1",[read[0].id]),/immutable/);
    assert.equal(await commitStage(r,"CONFIRMATION",read[0],null,clients[0],()=>true,()=>r.nowMs),null);
    const restarted=await readStageLocks(r,db);assert.equal(restarted[0].id,read[0].id);
    const policy:LearnedStagePolicy={version:"SYNTHETIC_FIXTURE_ONLY",stage:"CONFIRMATION",interval:5,
      modelVersion:"SYNTHETIC_FIXTURE_ONLY",trainedBeforeMs:start-1,featureVersion:"price-area-proxy-v1",
      minimumStrength:.85,outcome:{intercept:Math.log(.1/.9),coefficients:Array(8).fill(0)},
      calibration:{intercept:0,coefficients:[1]},selectedCalibrationN:100,selectedBothOutcomes:true,
      selectedBrier:.1,qualified:true,economicQuotesVerified:true};
    const more={...r,nowMs:start+28000,observations:[...r.observations,{
      ...r.observations.at(-1)!,id:"fresh-confirmation-observation",atMs:start+28000,receivedAtMs:start+28000,
      availableAtMs:start+28000,probabilityUp:.81,probabilityDown:.19,
      features:{...r.observations.at(-1)!.features,comparison:{price:99.5,asOf:new Date(start+28000).toISOString()},
        executableQuote:{verified:true,fullSize:true,network:"sui:mainnet",roundId:r.roundId,marketId:r.marketId,side:"DOWN",
          quoteId:"SYNTHETIC_FULL_SIZE_QUOTE",quotedAtMs:start+28000,expiresAtMs:start+100000,executionCutoffAtMs:r.expiryMs,
          collateralUsd:5,feesUsd:.05,totalEntryCostUsd:5.05,shares:"7500000",payoutRule:"SYNTHETIC_BINARY_TEST",
          returnedIfCorrectUsd:7.5,returnedIfIncorrectUsd:0,gasSui:.01,gasUsd:.01,gasValuationBasis:"SYNTHETIC_TEST",
          partialFill:"FILL_OR_KILL",limitsEnforced:true,maxSpendUsd:5.1,minimumShares:"7500000",maximumPrice:.7}}}]};
    const confirmation=await commitStage(more,"CONFIRMATION",read[0],policy,clients[0],()=>true,()=>more.nowMs);
    assert.equal(confirmation?.side,"DOWN");
    const both=await readStageLocks(r,db);assert.equal(both.length,2);
    assert.equal(both.find(s=>s.stage==="EARLY")!.id,read[0].id);
    await assert.rejects(db.query("UPDATE waterx_two_stage_locks SET decision=decision WHERE id=$1",[confirmation!.id]),/immutable/);
    const only={...more,roundId:r.roundId+"-only",observations:more.observations.map(o=>({...o,
      features:{...o.features,executableQuote:o.features.executableQuote?{...(o.features.executableQuote as object),
        roundId:r.roundId+"-only"}:null}}))};
    await db.query(`INSERT INTO waterx_two_stage_rounds(network,market_id,round_id,interval_minutes,strategy_version,
      start_ms,expiry_ms,discovered_at_ms,capture_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'SYNTHETIC')`,
      [...stageIdentity(only),only.startMs,only.expiryMs,only.nowMs]);
    let ambiguous=true;
    const wrapped={query:async(sql:string,args?:unknown[])=>{
      const result=await clients[0].query(sql,args);
      if(sql==="COMMIT"&&ambiguous){ambiguous=false;throw new Error("SIMULATED_ACK_LOSS_AFTER_REAL_COMMIT");}
      return result;
    }} as Parameters<typeof readStageLocks>[1];
    const recovered=await commitStage(only,"CONFIRMATION",null,policy,wrapped,()=>true,()=>only.nowMs);
    assert.equal(recovered?.side,"DOWN");assert.equal(recovered?.commitVerified,true);
    assert.equal(recovered?.committedAtMs,null);
    const recoveredRows=await readStageLocks(only,db);assert.equal(recoveredRows.length,1);
    assert.equal(stageRelationship(null,recoveredRows[0]),"No early decision");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM waterx_two_stage_outbox WHERE decision_id=$1",[recovered!.id])).rows[0].n,1);
  }finally{clients.forEach(c=>c.release());await db.end();}
});
