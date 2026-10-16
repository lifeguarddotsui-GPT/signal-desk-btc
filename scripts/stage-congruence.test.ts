import test from "node:test";
import assert from "node:assert/strict";
import {summarizeTriad} from "../shared/stage-congruence";
test("a consensus is descriptive and never invents independent confidence or order authority",()=>{
  const same=summarizeTriad({early:"DOWN",confirmation:"DOWN",primary:"DOWN"});
  assert.equal(same.state,"AGREE_THREE");assert.equal(same.direction,"DOWN");
  assert.equal(same.permitsTrading,false);assert.match(same.display,/NOT independent validation/);
  const two=summarizeTriad({early:"UP",confirmation:null,primary:"UP"});
  assert.equal(two.state,"AGREE_TWO");assert.equal(two.permitsTrading,false);
});
test("any conflicting saved stage suppresses unified direction regardless of order or stage precedence",()=>{
  for(const a of [
    {early:"UP" as const,confirmation:"DOWN" as const,primary:null},
    {early:"UP" as const,confirmation:"DOWN" as const,primary:"DOWN" as const},
    {early:"UP" as const,confirmation:"UP" as const,primary:"DOWN" as const},
  ]){
    const x=summarizeTriad(a);assert.equal(x.state,"CONFLICT");
    assert.equal(x.direction,null);assert.equal(x.permitsTrading,false);
  }
});
test("an Early-only direction is never upgraded to an agreed or validated forecast",()=>{
  const x=summarizeTriad({early:"DOWN",confirmation:null,primary:null});
  assert.equal(x.state,"SINGLE");assert.equal(x.direction,"DOWN");assert.equal(x.permitsTrading,false);
  const none=summarizeTriad({early:null,confirmation:null,primary:null});
  assert.equal(none.state,"NONE");assert.equal(none.direction,null);
});
