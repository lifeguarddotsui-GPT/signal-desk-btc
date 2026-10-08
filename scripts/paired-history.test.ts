import test from "node:test";
import assert from "node:assert/strict";
import { stageScore, comparePaired, pairedSummary, type Stage, type PairedRow } from "../shared/paired-history";

const stage = (side: "UP" | "DOWN" | null, result: Stage["result"], status = side ? "LOCKED" : "UNRECORDED"): Stage =>
  ({side, status, probabilityUp: side === "UP" ? 0.8 : side === "DOWN" ? 0.2 : null,
    decisionAtMs: side ? 20 : null, secondsBeforeExpiry: side ? 120 : null, result});
const row = (early: Stage, confirmation: Stage): PairedRow => {
  const compare = comparePaired(early, confirmation);
  return {intervalMinutes:5,roundId:"a",startMs:0,expiryMs:300000,early,confirmation,
    ...compare,outcome:"UP",settlement:"VERIFIED",diagnostics:{
      gateCount:9,missedGates:0,waitsForFreshData:0,qualifiedGates:1,confirmationCause:"NONE"}};
};
test("scores both predictions from the same outcome without treating no lock as wrong",()=>{
  assert.equal(stageScore("UP","LOCKED","UP",false),"CORRECT");
  assert.equal(stageScore("DOWN","LOCKED","UP",false),"INCORRECT");
  assert.equal(stageScore(null,"DATA_FAILURE","UP",false),"DATA_FAILURE");
  assert.equal(stageScore(null,"ABSTAINED_NO_QUALIFIED_SIGNAL","UP",false),"ABSTAINED");
  assert.equal(stageScore(null,"UNRECORDED","UP",false),"UNRECORDED");
  assert.equal(stageScore("UP","LOCKED",null,false),"PENDING");
  assert.equal(stageScore("UP","LOCKED","UP",true),"DISPUTED");
});
test("congruence is direction agreement, independent from correctness",()=>{
  assert.deepEqual(comparePaired(stage("UP","CORRECT"),stage("DOWN","INCORRECT")),
    {congruence:"DISAGREE",pairedWinner:"EARLY_ONLY_CORRECT"});
  assert.deepEqual(comparePaired(stage("DOWN","INCORRECT"),stage("DOWN","INCORRECT")),
    {congruence:"AGREE",pairedWinner:"BOTH_INCORRECT"});
  assert.equal(comparePaired(stage("UP","PENDING"),stage("UP","PENDING")).pairedWinner,"NOT_COMPARABLE");
});
test("summary reports correct:incorrect:unrecorded, with pending separate",()=>{
  const rows=[row(stage("UP","CORRECT"),stage(null,"DATA_FAILURE","DATA_FAILURE")),
    row(stage("DOWN","INCORRECT"),stage(null,"ABSTAINED","ABSTAINED_NO_QUALIFIED_SIGNAL")),
    row(stage("UP","PENDING"),stage(null,"UNRECORDED"))];
  const summary=pairedSummary(rows);
  assert.deepEqual([summary.early.correct,summary.early.incorrect,summary.early.unrecorded,summary.early.pending],[1,1,0,1]);
  assert.deepEqual([summary.confirmation.correct,summary.confirmation.incorrect,summary.confirmation.unrecorded],[0,0,3]);
  assert.equal(summary.confirmation.dataFailures,1);
  assert.equal(summary.confirmation.abstained,1);
  assert.equal(summary.scoredPairs,0);
});
