import test from "node:test";
import assert from "node:assert/strict";
import {agentPolicySchema,defaultAgentPolicy} from "../shared/agent-policy";
import {canonicalHistory} from "../server/waterx/canonical-history";
import {researchOperations} from "../server/waterx/research-operations";
import {BASELINE_ARTIFACT_DIGEST,freezeResearchDecision} from "../server/waterx/research-decision";
import {readFileSync} from "node:fs";
import type {ResearchTrainingQueryable} from "../server/waterx/research-training";
import {captureRateLabel} from "../shared/bluewater-display";

test("capture percentage points are not multiplied by 100 a second time",()=>{
  assert.equal(captureRateLabel(89.095),"89.1%");
  assert.equal(captureRateLabel(100),"100.0%");
  assert.equal(captureRateLabel(null),"Not reported");
  assert.equal(captureRateLabel(8909.5),"Not reported");
});

test("mainnet owner-approved aggregate round ceiling is separate from turnover, sizing and exposure",()=>{
  const p={...defaultAgentPolicy,network:"mainnet" as const};
  assert.equal(agentPolicySchema.safeParse(p).success,true);
  assert.equal(agentPolicySchema.safeParse({...p,fixedCents:501}).success,false);
  for(const patch of [{maxOrderCents:501},{fixedCents:700,roundCollateralCents:1000},{compound:true}])
    assert.equal(agentPolicySchema.safeParse({...p,...patch}).success,true);
  assert.equal(agentPolicySchema.safeParse({...p,dailyTurnoverCents:501,
    maxUnresolved:{mode:"AMOUNT",value:501}}).success,true);
});
const row={interval_minutes:5,round_id:"fixture",start_ms:1000000,expiry_ms:1300000,
  outcome:"UP",label_status:"verified",settlement_disputed:false,n:"1",
  choices:[{state:"FROZEN",side:"UP",probability_up:"0.6",decision_at_ms:1240000,
    model_version:"market-baseline:fixture",choice_source:"market_baseline",
    evidence:{artifactDigest:"sha256:fixture"}}],verified:true};
function fakeDb():ResearchTrainingQueryable {
  return {async query<T extends Record<string,unknown>>(sql:string){
    const rows=sql.includes("FROM waterx_learning_rounds l")?[row]:
      sql.includes("AS last_capture")?[{last_capture:"2026-10-03T10:00:00Z"}]:
      sql.includes("AS artifacts")?[{artifacts:true,champions:true}]:
      sql.includes("max(created_at)")||sql.includes("max(effective_at)")?[{at:null}]:
      sql.includes("AS choices")?[{choices:"choices",daily:"daily",rounds:"rounds"}]:
      sql.includes("SELECT scheduled_day,status")?[{scheduled_day:"2026-10-03",
        status:"insufficient",dataset_count:1,reason:"Need more chronological evidence.",phases:[]}]:
      sql.includes("first_day")?[{first_day:"2026-10-03",days:["2026-10-03"]}]:
      sql.includes("SELECT status,phases")?[{status:"insufficient",phases:[],report:{}}]:[];
    return {rows:rows as unknown as T[]};
  }};
}
test("Learning and History use identical source/window denominators; no fit is inferred",async()=>{
  const db=fakeDb(),at=2000000;
  const history=await canonicalHistory({interval:"5",window:"20",source:"baseline"},at,db);
  const learning=await researchOperations(5,{interval:"5",window:"20",source:"baseline"},at,db);
  assert.equal(learning.status,"ok");
  if(learning.status!=="ok"||!("operations" in learning))throw new Error("Unavailable fixture.");
  assert.deepEqual(learning.summary,history.summary);
  assert.equal(learning.operations.lastTrainingAt,null);
  assert.equal(learning.operations.lastCalibrationAt,null);
  assert.equal(learning.operations.lastPromotionAt,null);
});
test("new baseline choices have a version and algorithm digest without a trained model",()=>{
  const choice=freezeResearchDecision({intervalMinutes:5,roundId:"fixture",startMs:1000000,
    expiryMs:1300000,observedAt:new Date(1240000).toISOString(),probabilityUp:0.6,
    probabilityDown:0.4,anchorPrice:null,anchorConfirmed:false},1240000,{
      source:"Coinbase",coverage:"unavailable",reason:"fixture",price:null,sourceAtMs:null,
      receivedAtMs:null,ageMs:null,return1m:null,return3m:null,realizedVolatility:null});
  assert.equal(choice?.choiceSource,"market_baseline");
  assert.match(choice!.modelVersion!,/^market-baseline:/);
  assert.equal(choice?.evidence.artifactDigest,BASELINE_ARTIFACT_DIGEST);
});
test("production does not hide read-only reports or defer canonical work behind legacy reads",()=>{
  const routes=readFileSync("server/routes.ts","utf8");
  for(const name of ["bluewater","lock-readiness"]){
    const body=routes.split(`app.get("/api/waterx/${name}"`)[1]?.split("app.get(")[0];
    assert.ok(body);assert.ok(!body.includes('process.env.NODE_ENV'));
  }
  const service=readFileSync("server/waterx/service.ts","utf8");
  assert.match(service,/canonicalLockQueue\.enqueue\(input\)/);
  assert.ok(!service.includes('if(process.env.NODE_ENV==="development")'));
  assert.match(service,/skipResearch:true/);
});