/** A *tentative* comparison for WaterX Activity screenshots that show
 *  "Placed at" but not a market ID or a verified fill timestamp.
 *  Never used in performance scoring, settlement or trade authority.
 */
export type CandidateState="OUTSIDE_DISPLAYED_ROUND"|"TIME_ONLY_CANDIDATE";
export type CandidateStage="AVAILABLE_BEFORE_PLACEMENT"|"SAVED_AFTER_PLACEMENT"|"NOT_RECORDED";
export type CandidateResult={
  state:CandidateState;reason:string;marketIdentityVerified:false;
  canAttributeLoss:false;side:"UP"|"DOWN";
  stages:{name:"Primary"|"Early"|"Confirmation";status:CandidateStage;
    savedSide:"UP"|"DOWN"|null;supportsSelection:boolean|null}[];
};
export function comparePlacementCandidate(input:{
  startMs:number;expiryMs:number;placedAtMs:number;side:"UP"|"DOWN";
  stages:{primary:{side:"UP"|"DOWN"|null;acknowledgedAtMs:number|null};
    early:{side:"UP"|"DOWN"|null;acknowledgedAtMs:number|null};
    confirmation:{side:"UP"|"DOWN"|null;acknowledgedAtMs:number|null}};
}):CandidateResult {
  const valid=Number.isSafeInteger(input.placedAtMs)&&
    input.placedAtMs>=input.startMs&&input.placedAtMs<input.expiryMs;
  const stages=(["primary","early","confirmation"] as const).map(key=>{
    const d=input.stages[key];
    const before=valid&&d.side!=null&&Number.isSafeInteger(d.acknowledgedAtMs)&&
      d.acknowledgedAtMs!>=input.startMs&&d.acknowledgedAtMs!<=input.placedAtMs;
    const status:CandidateStage=!valid||!d.side||d.acknowledgedAtMs==null?
      "NOT_RECORDED":before?"AVAILABLE_BEFORE_PLACEMENT":"SAVED_AFTER_PLACEMENT";
    return {name:(key[0].toUpperCase()+key.slice(1)) as "Primary"|"Early"|"Confirmation",
      status,savedSide:d.side??null,supportsSelection:before?d.side===input.side:null};
  });
  return {state:valid?"TIME_ONLY_CANDIDATE":"OUTSIDE_DISPLAYED_ROUND",
    reason:valid?"Placement time falls in this displayed Blue Water round. Exact WaterX market and fill identity remain UNVERIFIED.":
      "Placement timestamp does not belong to the displayed round; do not infer a match.",
    marketIdentityVerified:false,canAttributeLoss:false,side:input.side,stages};
}
