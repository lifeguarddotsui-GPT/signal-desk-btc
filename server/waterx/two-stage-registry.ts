import {validatedStagePolicy,type LearnedStagePolicy} from "./two-stage-policy";
import {TWO_STAGE_FEATURES,type StageInput,type LockStage} from "../../shared/two-stage";
import type {LockDb} from "./lock-store";
export const STAGE_TRAINING_PROTOCOL="two-stage-live-selector-replay-v2";
export function createStagePolicyRegistry(){
  const policies=new Map<string,LearnedStagePolicy>(),deficits:Record<string,string>={};
  let trainingDeficits:Record<string,unknown>={};
  let loadedAtMs:number|null=null,error:string|null=null,job:Promise<void>|null=null;
  for(const interval of [5,15])for(const stage of ["EARLY","CONFIRMATION"])
    deficits[`${interval}:${stage}`]="Registry not yet loaded";
  function ingest(reports:{interval_minutes:unknown;report:unknown}[],now:number){
    policies.clear();
    trainingDeficits={};
    for(const interval of [5,15])for(const stage of ["EARLY","CONFIRMATION"] as const)
      deficits[`${interval}:${stage}`]="No eligible stage-selected calibrated artifact";
    for(const row of reports){
      const report=row.report as Record<string,any>;
      if(report?.protocol===STAGE_TRAINING_PROTOCOL&&!trainingDeficits[String(row.interval_minutes)])
        trainingDeficits[String(row.interval_minutes)]={counts:report.counts,partitions:report.deficits,
          stages:report.stages,reason:report.reason,datasetDigest:report.datasetDigest};
      for(const stage of ["EARLY","CONFIRMATION"] as const){
        const p=report?.artifacts?.[stage] as LearnedStagePolicy|undefined,key=`${row.interval_minutes}:${stage}`;
        if(policies.has(key))continue;
        const evidence=report?.stages?.[stage];
        const fakeInput={intervalMinutes:Number(row.interval_minutes),startMs:now+1} as StageInput;
        if(!p||report.protocol!==STAGE_TRAINING_PROTOCOL||report.featureVersion!==TWO_STAGE_FEATURES||
          !/^[a-f0-9]{64}$/.test(report.datasetDigest??"")||
          !validatedStagePolicy(p,fakeInput,stage)||p.trainedBeforeMs>now||
          evidence?.status!=="QUALIFIED_SHADOW_ONLY"||evidence.selectedCalibrationN<60||
          evidence.test?.n<60||!(evidence.test?.observedUpRate>0&&evidence.test.observedUpRate<1)||
          !Number.isFinite(evidence.test.brier)||evidence.test.brier!==p.selectedBrier||
          !(evidence.test.brier<evidence.matchedMarketBaseline?.brier)||
          report.selectorParity!==true){
          if(p)deficits[key]="Artifact protocol, cutoff, calibration, held-out evidence or selector parity failed validation";
          continue;
        }
        policies.set(key,p);delete deficits[key];
      }
    }
    loadedAtMs=now;error=null;
  }
  async function refresh(db:LockDb,now=Date.now(),force=false){
    if(job)return job;
    if(!force&&loadedAtMs!=null&&now-loadedAtMs<300000)return;
    job=(async()=>{
      try{const rows=await db.query(`SELECT interval_minutes,report FROM waterx_two_stage_training
        ORDER BY created_at_ms DESC LIMIT 100`);ingest(rows.rows.map(row=>({
          interval_minutes:row.interval_minutes,report:row.report})),now);}
      catch(e){error=(e as Error).message;loadedAtMs=now;}
    })().finally(()=>{job=null;});
    return job;
  }
  return {ingest,refresh,policy:(input:StageInput,stage:LockStage)=>{
    const p=policies.get(`${input.intervalMinutes}:${stage}`)??null;
    return validatedStagePolicy(p,input,stage)?p:null;
  },health:()=>({loadedAtMs,error,eligibleVersions:Array.from(policies.values()).map(p=>p.version),
    deficits:{...deficits},trainingDeficits,executionAllowed:false,activation:"SHADOW_ONLY"})};
}
export const stagePolicyRegistry=createStagePolicyRegistry();
