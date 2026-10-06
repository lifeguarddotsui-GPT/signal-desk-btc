// Child-process restart probe. Refuses all non-disposable databases.
import assert from "node:assert/strict";
import {setImmediate as immediate} from "node:timers/promises";
import * as React from "react";
import {renderToStaticMarkup} from "react-dom/server";
const url=new URL(process.env.DATABASE_URL??"");
assert.equal(process.env.RUN_TIMED_POSTGRES_TESTS,"1");
assert(["127.0.0.1","localhost","::1"].includes(url.hostname));
assert.equal(url.pathname,"/waterx_timed_test");
const [schema,roundId,clock]=process.argv.slice(2);
assert.match(schema,/^qa_replay_[a-f0-9]+$/);
Date.now=()=>Number(clock);
const {timedPool}=await import("../server/waterx/timed-db");
const {researchPool}=await import("../server/waterx/research-store");
const {lockPool}=await import("../server/waterx/lock-store");
import type pg from "pg";
for(const pool of [timedPool,researchPool]){
  (pool as unknown as {options:pg.PoolConfig}).options.options=`-c search_path=${schema}`;
}
const {recoverTimedSchedules,stopTimedStrategy,timedStrategyQueueMetrics}=await import("../server/waterx/timed-decision-coordinator");
const {drainGateResearch}=await import("../server/waterx/gate-research-queue");
const {parseWaterxResponse}=await import("../server/waterx/source");
const {buildWaterxLivePayload}=await import("../server/waterx/service");
const {getAtomicDecisionView}=await import("../client/src/live-decision-contract");
const {ManualOpportunity}=await import("../client/src/ManualOpportunity");
try{
  const stored=(await timedPool.query(`SELECT input FROM waterx_timed_observations WHERE round_id=$1
    ORDER BY received_at_ms DESC LIMIT 1`,[roundId])).rows[0].input;
  await recoverTimedSchedules(timedPool,Date.now());
  for(let n=0;timedStrategyQueueMetrics().depth&&n<2000;n++)await immediate();
  assert.equal(timedStrategyQueueMetrics().depth,0);
  const parsed=parseWaterxResponse(stored.features.syntheticProviderPayload,stored.intervalMinutes);
  const payload=buildWaterxLivePayload(stored.intervalMinutes,{observedAt:stored.observedAt,
    receivedAtMs:stored.receivedAtMs,status:"LIVE",round:parsed.round,sourceError:null,reason:"SYNTHETIC ISOLATED RESTART"},Date.now(),null);
  const view=getAtomicDecisionView(payload,stored.intervalMinutes,payload.round,Date.now());
  const html=renderToStaticMarkup(React.createElement(ManualOpportunity,{view,now:Date.now(),
    interval:stored.intervalMinutes,round:payload.round}));
  const outbox=(await timedPool.query(`SELECT o.* FROM waterx_timed_outbox o JOIN waterx_timed_decisions d ON d.id=o.decision_id
    WHERE d.round_id=$1`,[roundId])).rows;
  console.log("RESTART_PROOF="+JSON.stringify({pid:process.pid,payload,html,outbox}));
}finally{
  stopTimedStrategy();await drainGateResearch();
  await Promise.all([timedPool.end(),researchPool.end(),lockPool.end()]);
}
