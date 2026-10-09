import pg from "pg";
import {monitorEventLoopDelay} from "node:perf_hooks";
const eventLoop=monitorEventLoopDelay({resolution:20});
eventLoop.enable();
// Reserved capacity only for early decisions/receipts, not settlement or training.
// This is still PostgreSQL; it is not an edge/autoscale-independent scheduler.
export const timedPool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2,
  connectionTimeoutMillis:1000,query_timeout:1000,statement_timeout:1000,
  idleTimeoutMillis:10000,application_name:"bluewater-timed-critical"});
let lastIdleFailureAtMs:number|null=null;
timedPool.on("error",()=>{
  lastIdleFailureAtMs=Date.now();
  console.error("Timed decision pool idle connection lost; recovery required.");
});
export function timedPoolHealth(){
  return {capacity:2,total:timedPool.totalCount,idle:timedPool.idleCount,
    waiting:timedPool.waitingCount,acquisitionTimeoutMs:1000,queryTimeoutMs:1000,
    isolatedFromOptionalResearch:true,lastIdleFailureAtMs,
    processId:process.pid,eventLoop:{sampleN:eventLoop.count,
      p95Ms:eventLoop.count?eventLoop.percentile(95)/1e6:null,
      maximumMs:eventLoop.count?eventLoop.max/1e6:null},
    acquisitionMeasurement:"Total pool wait plus connection setup; queue depth is measured separately, not inferred as network latency."};
}
