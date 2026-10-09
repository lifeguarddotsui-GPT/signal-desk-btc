import {readFileSync,mkdirSync,writeFileSync} from "node:fs";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {EventChallengerPanel} from "../client/src/EventChallengerPanel";
import type {EventLockProjection} from "../shared/event-lock";

// Render the real production component with explicitly synthetic states.
// This is visual QA, not a market replay or evidence of provider uptime.
const startMs=Date.UTC(2026,9,7,12),roundId="visual-qa-not-a-market-round";
const round={id:roundId,startMs,expiryMs:startMs+300000};
const qualification={strategyVersion:"waterx-event-lock-v1",sourceAgeMs:1000,
  liveSide:"UP",liveProbabilityUp:.8,requirementsMet:4,requirementsTotal:4,
  components:{strength:.8,requiredStrength:.72,sameSideMs:24000,requiredSameSideMs:24000,validCount:5,requiredCount:3,recentReversals:0,
    probabilityRange:.02,maximumRange:.045,trendKind:"STRENGTHENING"}};
const projection={intervalMinutes:5,roundId,startMs,expiryMs:round.expiryMs,
  strategyVersion:"waterx-event-lock-v1",benchmarkVersion:"waterx-qualification-gates-v3",
  shadowOnly:true,activePolicyChanged:false,automaticExecutionAllowed:false,
  state:"WATCHING",qualification,saved:null,firstQualifiedAtMs:null,persistence:"OBSERVING",
  blocker:"Waiting for fresh market probabilities",acceptedObservations:0,duplicateDeliveries:0,
  outOfOrderInputs:0,droppedInputs:0,postLockObservations:0} as unknown as EventLockProjection;
const locked={status:"LOCKED",id:"fixture-not-a-durable-choice",side:"UP",probabilityUp:.8,probabilityDown:.2,
  decisionAtMs:startMs+74000,committedAtMs:startMs+74060,
  automaticExecutionAllowed:false};
const states=[
  {title:"WATCHING · no fresh quote",at:startMs+10000,change:{state:"WATCHING",qualification:{
    ...qualification,sourceAgeMs:null,liveSide:null,liveProbabilityUp:null,requirementsMet:0,components:null}}},
  {title:"LEANING UP · stability pending",at:startMs+56000,change:{state:"LEANING_UP",blocker:"SAME_SIDE_PERSISTENCE_INCOMPLETE",
    acceptedObservations:2,qualification:{...qualification,requirementsMet:2,liveProbabilityUp:.77,
      components:{...qualification.components,sameSideMs:6000,validCount:2}}}},
  {title:"SAVING · no saved choice yet",at:startMs+74000,change:{state:"SAVING",persistence:"SAVING",
    firstQualifiedAtMs:startMs+74000,acceptedObservations:5,blocker:"CONDITIONS_SATISFIED"}},
  {title:"LOCKED UP · immutable market odds",at:startMs+75000,change:{state:"LOCKED_UP",persistence:"COMMITTED",saved:locked,
    firstQualifiedAtMs:startMs+74000,acceptedObservations:5,blocker:"CONDITIONS_SATISFIED"}},
  {title:"DATA LOSS · saved choice remains",at:startMs+95000,change:{state:"LOCKED_UP",persistence:"COMMITTED",saved:locked,
    firstQualifiedAtMs:startMs+74000,acceptedObservations:7,blocker:"NO_VALID_PROBABILITY_INPUT",
    qualification:{...qualification,sourceAgeMs:null,liveSide:null,liveProbabilityUp:null,requirementsMet:0,components:null}}},
  {title:"ROUND COMPLETE · saved choice retained",at:startMs+300001,change:{
    state:"ROUND_COMPLETE",persistence:"COMMITTED",saved:locked,blocker:"ROUND_COMPLETE",
    firstQualifiedAtMs:startMs+74000,acceptedObservations:7}},
] as const;
const panelsFor=(intervalMinutes:5|15)=>states.map((s,i)=>{
  const change=s.change as unknown as Partial<EventLockProjection>,q=change.qualification??projection.qualification;
  const expiryMs=startMs+intervalMinutes*60000,qualifiedAt=startMs+(intervalMinutes===5?74000:236000);
  const components=q.components?{...q.components,requiredSameSideMs:intervalMinutes===5?24000:45000,
    sameSideMs:q.components.sameSideMs*(intervalMinutes===5?1:3)}:null;
  const p={...projection,...change,intervalMinutes,expiryMs,
    qualification:{...q,components},firstQualifiedAtMs:change.firstQualifiedAtMs==null?null:qualifiedAt,
    saved:change.saved?{...change.saved,decisionAtMs:qualifiedAt,committedAtMs:qualifiedAt+60}:null} as EventLockProjection;
  const elapsed15=[30000,200000,236000,237000,260000,900001][i];
  return `<article class="qa-case" id="state-${i+1}">
  <h2>${intervalMinutes}m · ${s.title}</h2><p class="qa-watermark">SYNTHETIC UI FIXTURE · no provider or production claim</p>
  ${renderToStaticMarkup(React.createElement(EventChallengerPanel,{
    projection:p,round:{...round,expiryMs},now:intervalMinutes===5?s.at:startMs+elapsed15}))}
</article>`;
}).join("\n");
const panels=panelsFor(5);
const css=readFileSync("client/src/ManualOpportunity.css","utf8");
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bluewater event-lock · synthetic lifecycle UI evidence</title>
<style>:root{color-scheme:dark;--desk-muted:#98b7ac;--desk-paper:#e6eee5;--desk-line:#43625a;--desk-lime:#a9d978}
*{box-sizing:border-box}body{font:14px/1.45 Inter,ui-sans-serif,system-ui,sans-serif;background:#071b21;color:#e6eee5;margin:0;padding:24px}
h1{font-size:24px;margin:0 0 8px}header.qa-head{max-width:1220px;margin:0 auto 24px}header.qa-head p{margin:0;color:#b0c6bf}
.qa-grid{max-width:1220px;margin:auto;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}
.qa-case{min-width:0;padding:15px;background:#09232a;border:1px solid #315650;border-radius:14px}
.qa-case h2{font-size:14px;letter-spacing:.03em;margin:0 0 4px}.qa-watermark{font-size:11px;color:#e4ad79;margin:0 0 12px}
@media(max-width:700px){body{padding:12px}.qa-grid{display:block}.qa-case{margin:0 0 15px;padding:12px}}
${css}</style></head><body><header class="qa-head"><h1>Event-driven challenger · lifecycle</h1>
<p>Real UI component, synthetic states. The 30-second policy remains the active benchmark. No funded trading.</p></header>
<main class="qa-grid">${panels}</main></body></html>`;
mkdirSync("reports/event-lock",{recursive:true});
writeFileSync("reports/event-lock/ui-evidence.html",html);
writeFileSync("client/public/__event-lock-visual-qa.html",html);
const interval15=html.replace(panels,panelsFor(15))
  .replace("<h1>Event-driven challenger · lifecycle</h1>","<h1>15-minute event challenger · synthetic lifecycle</h1>")
  ;
writeFileSync("reports/event-lock/ui-evidence-15m.html",interval15);
writeFileSync("client/public/__event-lock-visual-qa-15m.html",interval15);
console.log("Rendered six synthetic lifecycle states from the production component.");
