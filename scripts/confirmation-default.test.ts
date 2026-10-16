import test from "node:test";
import assert from "node:assert/strict";
import {ruleConfirmationEnabled,assessStage} from "../server/waterx/two-stage-policy";
test("rule Confirmation is shadow-enabled by default; explicit false remains a kill switch",()=>{
  const original=process.env.WATERX_RULE_CONFIRMATION_ENABLED;
  try{
    delete process.env.WATERX_RULE_CONFIRMATION_ENABLED;
    assert.equal(ruleConfirmationEnabled(),true);
    process.env.WATERX_RULE_CONFIRMATION_ENABLED="true";
    assert.equal(ruleConfirmationEnabled(),true);
    process.env.WATERX_RULE_CONFIRMATION_ENABLED="false";
    assert.equal(ruleConfirmationEnabled(),false);
    process.env.WATERX_RULE_CONFIRMATION_ENABLED=" FALSE ";
    assert.equal(ruleConfirmationEnabled(),false);
    process.env.WATERX_RULE_CONFIRMATION_ENABLED="OFF";
    assert.equal(ruleConfirmationEnabled(),false);
  }finally{
    if(original===undefined)delete process.env.WATERX_RULE_CONFIRMATION_ENABLED;
    else process.env.WATERX_RULE_CONFIRMATION_ENABLED=original;
  }
});
