import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RESEARCH_MAINTENANCE_PERIOD_MS, PREVIOUS_RESEARCH_MAINTENANCE_PERIOD_MS,
  scheduledMaintenanceRunsForOneHour,
} from "../server/waterx/maintenance-cadence";

test("retrospective maintenance repeats 4x less often without reducing market or lock sampling",()=>{
  assert.equal(scheduledMaintenanceRunsForOneHour(PREVIOUS_RESEARCH_MAINTENANCE_PERIOD_MS),240);
  assert.equal(scheduledMaintenanceRunsForOneHour(RESEARCH_MAINTENANCE_PERIOD_MS),60);
  const research=readFileSync(new URL("../server/waterx/research-maintenance.ts",import.meta.url),"utf8");
  assert.match(research,/setInterval\(\(\)=>void run\(\),RESEARCH_MAINTENANCE_PERIOD_MS\)/);
  assert.match(research,/void run\(\);/,"run immediately on visitor wake");
  assert.match(research,/return \(\)=>\{stopped=true;clearInterval\(timer\);\}/,"stop maintenance on last visitor");
  const waterx=readFileSync(new URL("../server/waterx/service.ts",import.meta.url),"utf8");
  assert.match(waterx,/options\.periods\?\.\[interval\] \?\? 5_000/);
  const coordinator=readFileSync(new URL("../shared/timed-decision.ts",import.meta.url),"utf8");
  assert.match(coordinator,/GATE_MS=30000/,"30 second choice gates remain untouched");
});
