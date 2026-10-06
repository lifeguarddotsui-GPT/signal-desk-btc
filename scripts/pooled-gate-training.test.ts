import test from "node:test";
import assert from "node:assert/strict";
import {trainPooledGates} from "../server/waterx/pooled-early-training";
import {evaluateEarlyStopping} from "../server/waterx/early-stopping";
import {earlyHorizons} from "../shared/timed-decision";
const now=Date.UTC(2026,9,6),day=86400000;
function rows(n:number,days:number){
 return Array.from({length:n},(_,i)=>earlyHorizons(5).map(horizon=>{
   const startMs=now-days*day+i*300000;
   return {interval:5 as const,roundId:`${days}-${i}`,startMs,expiryMs:startMs+300000,horizon,
     probability:i%2?.8:.2,outcome:i%2?"UP" as const:"DOWN" as const,
     labelAvailableAtMs:startMs+301000,snapshotDigest:`${days}-${i}-${horizon}`};
 })).flat();
}
test("pooled challenger counts independent rounds, fits elapsed and never promotes itself",()=>{
 const data=[...rows(210,8),...rows(60,4),...rows(60,1)];
 const fit=trainPooledGates(data,5,now);
 assert.equal(fit.counts.training,210);assert.equal(fit.counts.calibration,60);assert.equal(fit.counts.test,60);
 assert.equal(fit.promotion,"RETAIN_BASELINE");assert.equal(fit.status,"EVALUATED");
 if(fit.status==="EVALUATED"){assert.equal(fit.artifact.parameters.coefficients.length,2);assert(fit.artifact.shadowOnly);}
 assert.equal(trainPooledGates([...data].reverse(),5,now).fingerprint,fit.fingerprint);
});
test("correlated gates cannot manufacture enough independent training or bypass label embargo",()=>{
 const data=rows(30,8);
 assert.equal(trainPooledGates(data,5,now).status,"INSUFFICIENT");
 assert.equal(trainPooledGates(data,5,now).counts.training,30);
 assert.equal(trainPooledGates(data.map(r=>({...r,labelAvailableAtMs:now+1})),5,now).counts.eligible,0);
 assert.equal(trainPooledGates([...data,data[0]],5,now).rejectedRounds,1);
});
test("sequential replay abstains on weak gates, including the former forced deadline",()=>{
 const data=[...rows(60,3),...rows(60,1)].map(r=>({...r,probability:.525}));
 const forecasts=earlyHorizons(5).map(horizon=>({horizon,artifact:{
   parameters:{intercept:0,coefficients:[1]},calibration:{intercept:0,coefficients:[1]}}}));
 const report=evaluateEarlyStopping(data,5,forecasts,now);
 assert.equal(report.status,"EVALUATED");
 if("test" in report){assert.equal(report.test.decisionN,0);assert.equal(report.test.coverage,0);}
});
