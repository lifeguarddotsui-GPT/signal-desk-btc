import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RESEARCH_MAINTENANCE_PERIOD_MS, PREVIOUS_RESEARCH_MAINTENANCE_PERIOD_MS,
  scheduledMaintenanceRunsForOneHour, INACTIVE_15M_MAINTENANCE_PERIOD_MS,
  researchMaintenanceCadenceMs, maintenanceDue,
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

test("inactive 15m historical scans are throttled but all live and 5m scans retain cadence",()=>{
  assert.equal(INACTIVE_15M_MAINTENANCE_PERIOD_MS, 900_000);
  assert.equal(researchMaintenanceCadenceMs(15, false), 900_000);
  assert.equal(researchMaintenanceCadenceMs(15, true), 60_000);
  assert.equal(researchMaintenanceCadenceMs(5, false), 60_000);
  assert.equal(researchMaintenanceCadenceMs(5, true), 60_000);
  assert.equal(scheduledMaintenanceRunsForOneHour(researchMaintenanceCadenceMs(15, false)),4);
  assert.equal(maintenanceDue(undefined,0,900_000),true,"startup catch-up");
  assert.equal(maintenanceDue(1000,60000,900_000),false,"avoid repeat");
  assert.equal(maintenanceDue(1000,901000,900_000),true,"eventual catch-up");
  assert.equal(maintenanceDue(1000,500,900_000),true,"clock correction");
  assert.equal(maintenanceDue(1000,61000,60000),true,"reactivated market");
  assert.throws(()=>maintenanceDue(1000,60000,0),/invalid maintenance cadence/);
  const research=readFileSync(new URL("../server/waterx/research-maintenance.ts",import.meta.url),"utf8");
  assert.match(research,/researchMaintenanceCadenceMs\(/);
  assert.match(research,/maintenanceDue\(/);
  assert.match(research,/lastCompletedPassAtMs\.set\(interval,now\)/);
});
