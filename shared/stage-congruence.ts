/** Compare frozen research directions without counting correlated evidence twice.
 *  Agreement is descriptive, never model confidence, and conflict always wins. */
export type ResearchSide="UP"|"DOWN";
export type TriadAlignment="NONE"|"SINGLE"|"AGREE_TWO"|"AGREE_THREE"|"CONFLICT";
export type TriadSummary={
  state:TriadAlignment;
  direction:ResearchSide|null;
  frozenCount:number;
  agreeCount:number;
  display:string;
  permitsTrading:false;
};
export function summarizeTriad(input:{
  primary:ResearchSide|null;early:ResearchSide|null;confirmation:ResearchSide|null;
}):TriadSummary {
  const stages=([input.early,input.confirmation,input.primary] as const)
    .filter((side):side is ResearchSide=>side==="UP"||side==="DOWN");
  const different=new Set(stages),n=stages.length;
  const state:TriadAlignment=n===0?"NONE":n===1?"SINGLE":different.size>1?"CONFLICT":
    n===3?"AGREE_THREE":"AGREE_TWO";
  const direction=state==="CONFLICT"||state==="NONE"?null:stages[0];
  const display=state==="NONE"?"No saved stage decisions":
    state==="SINGLE"?"One saved research decision · no cross-check":
    state==="CONFLICT"?"Saved stages disagree · do not infer a unified direction":
    `${n} saved stages agree · shared market evidence is NOT independent validation`;
  return {state,direction,frozenCount:n,agreeCount:state==="CONFLICT"?Math.max(
    stages.filter(x=>x==="UP").length,stages.filter(x=>x==="DOWN").length):n,display,permitsTrading:false};
}
