import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {projectLineageRow,decisionLineage,lineageQuery} from "../server/waterx/decision-lineage";
import {TIMED_STRATEGY} from "../shared/timed-decision";
import {TWO_STAGE_STRATEGY} from "../shared/two-stage";

const start=1792112400000,now=start+3600000;
const base=()=>({
  network:"sui:mainnet",interval_minutes:5,round_id:"btc-lineage-test",start_ms:start,expiry_ms:start+300000,
  market_id:"btc-market-fixture",stage_strategy:TWO_STAGE_STRATEGY,stage_match_count:1,
  primary_id:"primary-id",primary_outbox_id:"primary-id",primary_ack:start+58000,
  primary_decision:{strategyVersion:TIMED_STRATEGY,roundId:"btc-lineage-test",intervalMinutes:5,startMs:start,expiryMs:start+300000,
    status:"LOCKED",side:"DOWN",probabilityUp:.31,decisionAtMs:start+55000,lockReason:"QUALIFIED"},
  early_id:"early-id",early_outbox_id:"early-id",early_ack:start+24000,
  early_decision:{network:"sui:mainnet",marketId:"btc-market-fixture",strategyVersion:TWO_STAGE_STRATEGY,
    stage:"EARLY",roundId:"btc-lineage-test",intervalMinutes:5,startMs:start,expiryMs:start+300000,
    side:"UP",probabilityUp:.69,qualifiedAtMs:start+20000,policyVersion:"early-tw72-12-v1",modelVersion:null,
    probabilitySource:"WATERX_MARKET"},
  confirmation_id:null,confirmation_outbox_id:null,confirmation_reason:"CONFIRMATION_POLICY_NOT_QUALIFIED",
  checkpoint_state:null,
  outcome:"DOWN",label_status:"verified",settlement_disputed:false,settlement_quarantine:[],
  settlement_anchor_price:100,settle_price:98,settled_at:start+300001,
  first_verified_at:new Date(start+310000).toISOString(),
});
test("unified view scores saved primary and early independently and never makes inactive confirmation incorrect",()=>{
  const row=projectLineageRow(base(),now);
  assert.equal(row.outcome,"DOWN");
  assert.equal(row.primary.score,"CORRECT");assert.equal(row.early.score,"INCORRECT");
  assert.equal(row.confirmation.score,"NO_LOCK");assert.equal(row.congruence,"DISAGREE");
  assert.match(row.confirmation.reason??"",/CONFIRMATION_POLICY_NOT_QUALIFIED/);
});
test("exact identity, outbox and provider proof gate all accuracy claims",()=>{
  const a=base();
  assert.equal(projectLineageRow({...a,primary_decision:{...a.primary_decision,roundId:"different"}},now).primary.score,"NO_LOCK");
  assert.equal(projectLineageRow({...a,early_outbox_id:null},now).early.score,"NO_LOCK");
  assert.equal(projectLineageRow({...a,early_ack:null},now).early.score,"NO_LOCK");
  assert.equal(projectLineageRow({...a,primary_ack:null},now).primary.score,"NO_LOCK");
  assert.equal(projectLineageRow({...a,primary_ack:start+5_000},now).primary.score,"NO_LOCK");
  assert.equal(projectLineageRow({...a,primary_ack:start+300_000},now).primary.score,"NO_LOCK");
  assert.equal(projectLineageRow({...a,early_ack:start+2_000},now).early.score,"NO_LOCK");
  assert.equal(projectLineageRow({...a,early_ack:start+300_000},now).early.score,"NO_LOCK");
  assert.equal(projectLineageRow({...a,stage_match_count:2},now).early.reason,"AMBIGUOUS_STAGE_MARKET");
  assert.equal(projectLineageRow({...a,settlement_disputed:true},now).primary.score,"DISPUTED");
  assert.equal(projectLineageRow({...a,outcome:"UP"},now).settlementStatus,"PENDING");
  assert.equal(projectLineageRow({...a,label_status:"withheld",outcome:null},now).primary.score,"WITHHELD");
  assert.equal(projectLineageRow({...a,first_verified_at:new Date(now+1).toISOString()},now).primary.score,"AWAITING_SETTLEMENT");
});
test("different confirmation policies are frozen separately and never treated as calibrated by name",()=>{
  const a=base(),confirm={...a.early_decision,stage:"CONFIRMATION",side:"DOWN",
    policyVersion:"confirmation-evidence-guard-v1",qualifiedAtMs:start+110000};
  const row=projectLineageRow({...a,confirmation_id:"confirm-id",confirmation_outbox_id:"confirm-id",
    confirmation_ack:start+120000,confirmation_decision:confirm},now);
  assert.equal(row.confirmation.side,"DOWN");assert.equal(row.confirmation.score,"CORRECT");
  assert.equal(row.confirmation.modelVersion,null);
  assert.equal(row.confirmation.policyVersion,"confirmation-evidence-guard-v1");
});
test("one bounded read-only lineage query does not create rounds for invisible time slots",async()=>{
  let calls=0,sql="",args:unknown[]=[];
  const db={query:async(q:string,p:unknown[])=>{calls++;sql=q;args=p;return {rows:[base()]};}};
  const report=await decisionLineage({interval:"5",window:"24h",limit:40},now,db as any);
  assert.equal(calls,1);
  assert.match(sql,/FROM waterx_timed_rounds/);assert.match(sql,/LIMIT \$5/);
  assert.doesNotMatch(sql,/INSERT INTO|UPDATE\s|DELETE FROM/i);
  assert.equal(args[4],40);assert.equal(report.cohortN,1);
  assert.equal(report.stats.primary.correct,1);assert.equal(report.stats.early.incorrect,1);
  assert.equal(report.stats.confirmation.scored,0);assert.equal(report.paired.verifiedN,1);
  assert.ok(Math.abs(report.stats.primary.brier!-.0961)<1e-9);
  assert.ok(Math.abs(report.stats.early.brier!-.4761)<1e-9);
  assert.equal(report.stats.primary.probabilityScoredN,1);
  assert.equal(report.stats.primary.medianSecondsRemainingAtAck,242);
  assert.equal(lineageQuery.safeParse({limit:1001}).success,false);
});
test("default history UI uses a single lazy bounded endpoint and does not poll",()=>{
  const u=readFileSync(new URL("../client/src/DecisionLineageHistory.tsx",import.meta.url),"utf8");
  const root=readFileSync(new URL("../client/src/CanonicalHistory.tsx",import.meta.url),"utf8");
  assert.match(u,/api\/waterx\/decision-lineage/);assert.doesNotMatch(u,/window\.setInterval\(|globalThis\.setInterval\(|setTimeout\(/);
  assert.match(root,/<DecisionLineageHistory\/>/);
});
