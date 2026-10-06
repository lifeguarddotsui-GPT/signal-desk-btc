import type { BluewaterReport } from "../../shared/bluewater-research";
/** Capability-limited slow planner. Only structured evidence in, proposals out.
 * No DB handle, SQL, imports of store/HTTP clients, deployment, wallet or promotion tools. */
export function researchHypotheses(report:BluewaterReport){
  const hypotheses:BluewaterReport["research"]["hypotheses"]=[];
  const funnel=report.funnels[0];
  if(funnel?.missingChoices)hypotheses.push({hypothesis:"Investigate collector capture gaps before judging probabilities.",
    reason:`${funnel.missingChoices} discovered exact rounds have no canonical choice; this does not prove timely input existed.`,
    experiment:{kind:"HORIZON_ANALYSIS",interval:report.intervalMinutes,horizons:[90,60,45,30,15]}});
  if(report.mistakes.some(m=>m.probability>=.9))hypotheses.push({hypothesis:"Audit high-confidence errors and side asymmetry.",
    reason:"Prospective incorrect predictions reached at least 90% chosen-side confidence; associations are descriptive.",
    experiment:{kind:"ERROR_ANALYSIS",interval:report.intervalMinutes,confidence:"HIGH",side:"ALL"}});
  if(report.training.canonical)hypotheses.push({hypothesis:"Test whether past-only calibration helps the raw WaterX control.",
    reason:"Canonical records remain available even without rich features; minimum evidence gates remain unchanged.",
    experiment:{kind:"TRAIN_CHALLENGER",interval:report.intervalMinutes,family:"platt_waterx",cohort:"verified-frozen-14d",
      calibrationProtocol:"chronological-60-20-20"}});
  const rich=report.challengers.find(c=>c.modelFamily==="rich_logistic");
  if(rich)hypotheses.push({hypothesis:"Measure incremental information beyond market probability on one matched cohort.",
    reason:"Removing WaterX probability tests dependence, not causal independence or profitability.",
    experiment:{kind:"ABLATION",interval:report.intervalMinutes,artifactId:rich.artifactId,feature:"marketProbabilityUp"}});
  else hypotheses.push({hypothesis:"Collect probability acceleration prospectively before testing it.",
    reason:"Historical missing windows cannot be reconstructed. Newly captured feature states need their own sufficient cohort.",
    experiment:{kind:"TRAIN_CHALLENGER",interval:report.intervalMinutes,family:"rich_logistic",
      features:["waterx_probability_up","probability_acceleration","btc_return_15s"],cohort:"prospective-features-14d",
      calibrationProtocol:"chronological-60-20-20"}});
  return hypotheses.slice(0,5);
}
export function structuredResearchReport(report:BluewaterReport){
  return {format:"bluewater-slow-research-v1",intervalMinutes:report.intervalMinutes,asOf:report.asOf,
    dataHealth:{funnels:report.funnels,limitations:report.limitations},
    baseline:{records:report.training.canonical,metrics:report.baselineMetrics,
      note:"All canonical records; comparisons elsewhere use their own exact matched cohorts."},
    champion:report.champion?{...report.champion,comparison:report.comparisons.find(c=>c.artifactId===report.champion!.artifactId)??null}:null,
    challengers:report.comparisons,horizons:{availableAt:"/api/waterx/research",matchedOnly:true},
    ablations:report.research.experiments.filter(e=>e.kind==="ABLATION"),
    mistakes:{contexts:report.mistakes,aggregates:report.mistakeAggregates,
      scope:"All accepted model-horizon errors in bounded 14-day aggregation; up to 100 recent primary contexts are displayed.",descriptiveOnly:true},hypotheses:researchHypotheses(report),
    promotion:report.promotion,authority:{propose:true,runCode:false,writeForecasts:false,
      modifyLabels:false,deploy:false,promote:false,trade:false,sign:false},
    requiresManualExperimentApproval:true};
}