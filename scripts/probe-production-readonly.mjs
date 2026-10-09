/** Public, read-only, one-shot production provenance and confirmation capture audit.
 * No keys, database access, writes, provider refresh or scheduled polling.
 * Bounded to twelve GETs and one HEAD; only aggregate metrics are printed to CI logs.
 */
const ROOT = "https://bluewaterai.app";
const probes = [
  ["version", "/api/waterx/version"],
  ["history5", "/api/waterx/paired-history?interval=5&window=24h"],
  ["history15", "/api/waterx/paired-history?interval=15&window=24h"],
  ["timed5", "/api/waterx/timed-history?interval=5&window=24h&limit=200"],
  ["timed15", "/api/waterx/timed-history?interval=15&window=24h&limit=200"],
  ["earlyOps", "/api/waterx/early-operations"],
  ["refresh5", "/api/waterx/refresh-health?interval=5"],
  ["refresh15", "/api/waterx/refresh-health?interval=15"],
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
  if(name.startsWith("timed")) {
    const metrics=data?.metrics??{};
    const entries=Array.isArray(data?.entries)?data.entries:[];
    const failureRecords=entries.filter(x=>x?.status==="DATA_FAILURE");
    const expectedGates=name==="timed5"?9:29;
    const diagnostic={
      analyzedFailureRecords:failureRecords.length,
      withMissedGate:0,withFreshDataWait:0,
      withBoth:0,withIncompleteGateJournal:0,
      withNeitherMissedNorFresh:0,
      totalGatesReported:0,gateResults:{},
    };
    for(const record of failureRecords) {
      const g=Array.isArray(record?.evidence?.gateResults)?record.evidence.gateResults:[];
      const results=new Set(g.map(x=>String(x?.result??"UNKNOWN")));
      const missed=results.has("MISSED_GATE"),fresh=results.has("WAIT_FRESH_DATA");
      if(missed)diagnostic.withMissedGate++;
      if(fresh)diagnostic.withFreshDataWait++;
      if(missed&&fresh)diagnostic.withBoth++;
      if(g.length!==expectedGates)diagnostic.withIncompleteGateJournal++;
      if(!missed&&!fresh)diagnostic.withNeitherMissedNorFresh++;
      diagnostic.totalGatesReported+=g.length;
      for(const item of g) {
        const key=String(item?.result??"UNKNOWN");
        diagnostic.gateResults[key]=(diagnostic.gateResults[key]??0)+1;
      }
    }
    return {strategyVersion:data?.strategyVersion??null,asOfMs:data?.asOfMs??null,
      rowsTruncated:data?.rowsTruncated??null,
      totalCohort:metrics.cohortN??null,committed:metrics.n??null,locks:metrics.locks??null,
      missingRecords:metrics.missingRecords??null,noValidInput:metrics.noValidInput??null,
      dataFailures:metrics.dataFailures??null,deadlineMisses:metrics.deadlineMisses??null,
      abstained:metrics.abstained??null,operationalFailures:metrics.operationalFailures??null,
      correct:metrics.correct??null,incorrect:metrics.incorrect??null,
      pending:metrics.pending??null,disputed:metrics.disputed??null,
      onTimeLocks:metrics.onTimeLocks??null,medianElapsedMs:metrics.medianElapsedMs??null,
      failureRecordDiagnostics:diagnostic};
  }
  if(name==="earlyOps") {
    return {status:data?.status??null,asOfMs:data?.asOfMs??null,
      diagnostics:data?.diagnostics??null,summary:data?.summary??null,
      note:data?.note??null};
  }
  if(name.startsWith("refresh")) {
    const r=data?.refreshHealth??{};
    const q=data?.captureQueues??{};
    return {refreshErrors:r?.errors??r?.lastErrors??null,
      collectorStatus:data?.collector?.collectorStatus??null,
      timedQueue:q?.timed??null};
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
try {
  const res=await fetch(ROOT+"/source-release.tar.gz",{method:"HEAD",redirect:"error",
    headers:{"User-Agent":"BlueWater-GitHub-Readonly-Audit/1.0"},
    signal:AbortSignal.timeout(10000)});
  console.log(JSON.stringify({probe:"sourceArchiveHEAD",httpStatus:res.status,
    contentType:res.headers.get("content-type"),contentLength:res.headers.get("content-length")}));
}catch(error){console.log(JSON.stringify({probe:"sourceArchiveHEAD",error:error instanceof Error?error.name:"UNKNOWN"}));}
console.log("Read-only production probe completed: 12 bounded GETs plus 1 HEAD; no DB writes, secrets, or deployments.");
