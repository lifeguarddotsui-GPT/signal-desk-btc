/** Offline, read-only analysis of saved production exports. No database writes,
 * no activation, no TEST-based winner selection, and no order/signer calls. */
import {readFileSync,writeFileSync,statSync} from "node:fs";
import {createHash} from "node:crypto";
import {trainTwoStage,type StageTrajectory} from "../server/waterx/two-stage-learning";
import {EARLY_CANDIDATES,EARLY_DEFAULT_POLICY,EARLY_CANDIDATE_PROTOCOL} from "../server/waterx/early-policy";
import {assessStage} from "../server/waterx/two-stage-policy";
const root="reports/early-repair";
const parseExport=(text:string)=>{
  const value=text.slice(text.indexOf("\n")+1).trim();
  return JSON.parse(value.startsWith('"')?value.slice(1,-1).replace(/""/g,'"'):value);
};
const results=[];
for(const interval of [5,15] as const){
  const saved=JSON.parse(readFileSync(`${root}/production-trajectories-${interval}.json`,"utf8"));
  if(!saved.result.success)throw new Error("Production export failed");
  const exported=parseExport(saved.result.output);
  const rows:StageTrajectory[]=exported.map((r:any)=>({...r,intervalMinutes:interval,
    observations:(r.observations??[]).map((a:any[])=>({
      id:a[0],atMs:a[1],receivedAtMs:a[1],availableAtMs:a[2],databaseAcceptedAtMs:null,providerSourceAtMs:null,
      sourceHealthy:a[3]===true,probabilityUp:a[4]??NaN,probabilityDown:a[5]??NaN,provenance:"PROSPECTIVE",
      features:{marketId:r.marketId,reference:a[6],referenceQuality:a[7],sourceFailure:a[8],
        comparison:{price:a[9],asOf:a[10]},purchaseUp:a[11],purchaseDown:a[12]}}))}));
  const eligible=rows.filter(r=>r.verified&&["UP","DOWN"].includes(r.outcome)&&
    Number.isFinite(r.labelAvailableAtMs)&&r.labelAvailableAtMs>r.expiryMs&&r.labelAvailableAtMs<=saved.asOfMs&&
    r.observations.length&&r.observations.every(o=>o.availableAtMs>=o.receivedAtMs&&
      o.availableAtMs<r.expiryMs&&o.receivedAtMs>=r.startMs));
  const descriptive=EARLY_CANDIDATES.map(candidate=>{
    const selected=eligible.flatMap(r=>{
      for(let i=0;i<r.observations.length;i++){
        const input={...r,earlyPolicyVersion:candidate.version,observations:r.observations.slice(0,i+1),
          nowMs:r.observations[i].availableAtMs};
        const a=assessStage(input,"EARLY",null);
        if(a.eligible)return [{side:a.side,outcome:r.outcome,elapsedMs:input.nowMs-r.startMs,
          totalReturnUsd:a.economics?.totalReturnedIfCorrectUsd??null,calibrated:false}];
      }return [];
    });
    const times=selected.map(s=>s.elapsedMs).sort((a,b)=>a-b),correct=selected.filter(s=>s.side===s.outcome).length;
    return {version:candidate.version,cohortN:eligible.length,locks:selected.length,coverage:eligible.length?selected.length/eligible.length:null,
      correct,scoredN:selected.length,accuracy:selected.length?correct/selected.length:null,
      medianQualificationElapsedMs:times.length?times[Math.ceil(times.length*.5)-1]:null,
      p90QualificationElapsedMs:times.length?times[Math.ceil(times.length*.9)-1]:null,
      windows:(interval===5?[30,60,90,120]:[60,120,180,300]).map(seconds=>({
        seconds,n:selected.filter(s=>s.elapsedMs<=seconds*1000).length,
        rate:eligible.length?selected.filter(s=>s.elapsedMs<=seconds*1000).length/eligible.length:null})),
      belowPreferred:selected.filter(s=>s.totalReturnUsd!=null&&s.totalReturnUsd<6).length,
      returnUnavailable:selected.filter(s=>s.totalReturnUsd==null).length,calibrationQualified:false};
  });
  results.push({interval,asOfMs:saved.asOfMs,exportedRoundN:rows.length,
    evidenceKind:"RETROSPECTIVE_REPLAY_OF_PRODUCTION_V1_NOT_PROSPECTIVE_V2_LOCKS",
    descriptiveSameDayReplay:{evidenceKind:"DESCRIPTIVE_ONLY_NOT_CHRONOLOGICAL_VALIDATION",
      selectedCandidate:null,candidates:descriptive},
    assumptions:["Export-wide observation provenance verified separately",
      "Stored WaterX outcomes are app-verified; exact oracle settlement semantics remain unverified",
      "Common PREFERRED return mode isolates event-policy differences; unchanged guard control is not the old hard-return v1 selector",
      "Replay times are evidence qualification times, not observed database/UI commit latencies"],
    report:trainTwoStage(rows,interval,saved.asOfMs)});
}
writeFileSync(`${root}/retrospective-comparison.json`,JSON.stringify(results,null,2));
writeFileSync(`${root}/candidate-manifest.json`,JSON.stringify({
  protocol:EARLY_CANDIDATE_PROTOCOL,candidates:EARLY_CANDIDATES,experimentalDefault:EARLY_DEFAULT_POLICY,
  sourceDeclaredAt:statSync("server/waterx/early-policy.ts").mtime.toISOString(),
  recordedAt:new Date().toISOString(),catalogSha256:createHash("sha256").update(JSON.stringify(EARLY_CANDIDATES)).digest("hex"),
  trustedExternalTimestamp:false,automaticActivation:false,
  note:"Catalog fixed in source before this replay; no candidate chosen using TEST. Manifest is not an externally tamper-evident registration."
},null,2));
console.log(JSON.stringify(results.map(r=>({interval:r.interval,rounds:r.exportedRoundN,
  eligible:r.report.trajectoryN,counts:r.report.counts,excluded:r.report.excluded,
  candidates:r.report.preregisteredEarlyCandidates.candidates.map(c=>({version:c.version,...c.TEST})),
  selected:r.report.preregisteredEarlyCandidates.selectedOnPolicy})),null,2));
process.exit(0);
