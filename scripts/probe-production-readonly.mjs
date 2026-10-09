/** Public, read-only, one-shot production provenance and confirmation capture audit.
 * No keys, database access, writes, provider refresh or scheduled polling.
 * Bounded to seven GETs; only aggregate metrics are printed to CI logs.
 */
const ROOT = "https://bluewaterai.app";
const probes = [
  ["version", "/api/waterx/version"],
  ["history5", "/api/waterx/paired-history?interval=5&window=24h"],
  ["history15", "/api/waterx/paired-history?interval=15&window=24h"],
  ["gates5", "/api/waterx/gates?interval=5"],
  ["gates15", "/api/waterx/gates?interval=15"],
  ["collector5", "/api/waterx/collector-state?interval=5"],
  ["collector15", "/api/waterx/collector-state?interval=15"],
];
const count = (xs, fn) => xs.filter(fn).length;
const summarise = (name, data) => {
  if (name === "version") {
    return {build: data?.build ?? null, provenance: data?.source?.provenance ?? null,
      auditedDeployedSnapshot: data?.source?.auditedDeployedSnapshot ?? null};
  }
  if (name.startsWith("history")) {
    const rows=Array.isArray(data?.rows)?data.rows:[];
    const summary=data?.summary??{};
    const causes={};
    for(const row of rows) {
      const cause=String(row?.diagnostics?.confirmationCause??"UNKNOWN");
      causes[cause]=(causes[cause]??0)+1;
    }
    const gates={missed:0,freshWaits:0,qualified:0,total:0};
    for(const row of rows){
      const d=row?.diagnostics??{};
      gates.missed+=Number(d.missedGates??0);
      gates.freshWaits+=Number(d.waitsForFreshData??0);
      gates.qualified+=Number(d.qualifiedGates??0);
      gates.total+=Number(d.gateCount??0);
    }
    return {status:data?.status,asOfMs:data?.asOfMs,cohort:summary?.rounds??null,
      totalRows:data?.totalRows??null,shownRows:rows.length,rowsTruncated:!!data?.rowsTruncated,
      early:summary?.early??null,confirmation:summary?.confirmation??null,
      benchmark:summary?.benchmark??null,
      confirmationCausesShownRows:causes,gateTotalsShownRows:gates,
      settlementStatesShownRows:{
        VERIFIED:count(rows,r=>r?.settlement==="VERIFIED"),
        PENDING:count(rows,r=>r?.settlement==="PENDING"),
        WITHHELD:count(rows,r=>r?.settlement==="WITHHELD"),
        NOT_OBSERVED:count(rows,r=>r?.settlement==="NOT_OBSERVED"),
        DISPUTED:count(rows,r=>r?.settlement==="DISPUTED")
      }};
  }
  if(name.startsWith("gates")) {
    const gates=Array.isArray(data?.entries)?data.entries:[];
    const reasons={};for(const g of gates){const k=String(g?.result??"UNKNOWN");reasons[k]=(reasons[k]??0)+1;}
    const latenesses=gates.map(g=>Number(g?.evaluatedAtMs)-Number(g?.scheduledAtMs)).filter(Number.isFinite);
    const latest=gates.at(-1);
    return {strategyVersion:data?.strategyVersion??null,roundStartMs:data?.round?.start_ms??null,
      gateCount:gates.length,byResult:reasons,largestLagMs:latenesses.length?Math.max(...latenesses):null,
      latestGate:{index:latest?.gateIndex??null,result:latest?.result??null,
        lagMs:latest?Number(latest.evaluatedAtMs)-Number(latest.scheduledAtMs):null}};
  }
  if (name.startsWith("collector")) {
    const c=data?.collector??{};
    return {status:data?.status??null,reason:data?.reason??null,
      collectorStatus:c.collectorStatus??null,healthState:c.healthState??null,
      lastSuccessfulRequestAt:c.lastSuccessfulRequestAt??null,
      lastFetchAttemptAt:c.lastFetchAttemptAt??null,lastFailureStage:c.lastFailureStage??null,
      fetchInFlightAgeMs:c.fetchInFlightAgeMs??null,
      retryAt:c.retryAt??null};
  }
  return {status:"UNRECOGNISED"};
};
for(const [name, path] of probes) {
  try {
    const res=await fetch(ROOT+path,{method:"GET",redirect:"error",
      headers:{"Accept":"application/json","Cache-Control":"no-store","User-Agent":"BlueWater-GitHub-Readonly-Audit/1.0"},
      signal:AbortSignal.timeout(10000)});
    if(!res.ok){console.log(JSON.stringify({probe:name,httpStatus:res.status,error:"HTTP_ERROR"}));continue;}
    const body=await res.json();
    console.log(JSON.stringify({probe:name,httpStatus:res.status,result:summarise(name,body)}));
  }catch(error){
    console.log(JSON.stringify({probe:name,error:error instanceof Error?error.name+":"+error.message.slice(0,100):"UNKNOWN"}));
  }
}
console.log("Read-only production probe completed: 7 bounded GETs; no DB writes, secrets, or deployments.");
