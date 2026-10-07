import type {EventObservation} from "../../shared/event-lock";
/** ONE unpromoted alternative to the range/strict-strengthening stability
 * component. Strength, freshness and persistence are deliberately not changed. */
export function supportFractionExperiment(observations:readonly EventObservation[],at:number,minimum=.8){
  if(![.7,.8,.9].includes(minimum))throw new Error("Unversioned stability parameter");
  const rows=observations.filter(o=>o.sourceHealthy&&o.availableAtMs<=at&&o.receivedAtMs>=at-15000);
  const last=rows.at(-1),side=last?last.probabilityUp>.5?"UP":last.probabilityUp<.5?"DOWN":null:null;
  const supporting=side?rows.filter(o=>(o.probabilityUp>.5?"UP":o.probabilityUp<.5?"DOWN":null)===side).length:0;
  const adverse=rows.slice(1).map((o,i)=>Math.max(0,side==="UP"?rows[i].probabilityUp-o.probabilityUp:
    o.probabilityUp-rows[i].probabilityUp));
  return {version:"support-fraction-shadow-v1",active:false,minimum,observations:rows.length,
    supportFraction:rows.length?supporting/rows.length:null,
    componentPass:side!==null&&rows.length>=3&&supporting/rows.length>=minimum,
    maximumAdverseMove:adverse.length?Math.max(...adverse):null,
    reversals:rows.slice(1).filter((o,i)=>(o.probabilityUp>.5)!==(rows[i].probabilityUp>.5)).length,
    note:"Diagnostic only. Adverse moves and reversals remain visible; no smoothing or parameter selection from final TEST."};
}
