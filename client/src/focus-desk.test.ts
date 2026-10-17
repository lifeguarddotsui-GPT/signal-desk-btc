import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import * as React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {FocusRail} from "./FocusRail";

const now=1_760_000_100_000;
const common={interval:5 as const,now,
 round:{id:"live-5m",startMs:now-120000,expiryMs:now+180000},
 probabilityUp:.61,probabilityDown:.39,probabilityReceivedAtMs:now-3000,
 lean:"UP" as const,lockedSide:null,decisionState:"LEANING UP",decisionReason:"Provisional research",
 nextGateAtMs:now+10000,verifiedModelEdge:false,stages:null,
 asks:{up:70,down:30},quoteFresh:true,quoteAtMs:now-2000};
const markup=(v:Partial<typeof common>={})=>renderToStaticMarkup(React.createElement(FocusRail,{...common,...v}));
test("large odds lead the decision rail; all five requested information groups are always rendered",()=>{
 const html=markup();
 for(const part of ["WaterX market ratios","BlueWater decision","Early lock","Confirmation lock","Timing window","UP ask","DOWN ask"])
  assert.ok(html.includes(part),part);
 assert.match(html,/61\.0%/); assert.match(html,/39\.0%/);
 assert.match(html,/LEANING UP/);
 assert.match(html,/3:00/);
 assert.match(html,/\+\$2\.14/);
 assert.doesNotMatch(html,/type="number"|Buy now|Execute trade/i);
});
test("stale or mismatched quote data never becomes actionable pricing",()=>{
 const html=markup({quoteAtMs:now-20000,probabilityReceivedAtMs:now-20000});
 assert.match(html,/No fresh ask/);assert.match(html,/Odds unavailable/);
 assert.doesNotMatch(html,/\+\$2\.14/);
 const invalid=markup({probabilityUp:.9,probabilityDown:.9});
 assert.match(invalid,/Odds unavailable/);
});
test("new layout is chart-first without hidden primary panels or 3 competing desktop columns",()=>{
 const app=readFileSync(new URL("./App.tsx",import.meta.url),"utf8");
 const manual=readFileSync(new URL("./ManualOpportunity.tsx",import.meta.url),"utf8");
 const styles=readFileSync(new URL("./FocusDesk.css",import.meta.url),"utf8");
 assert.match(manual,/className="bw-focus-layout"/);
 assert.ok(manual.indexOf('className="bw-focus-chart"')<manual.indexOf("<FocusRail "));
 assert.match(styles,/grid-template-columns:minmax\(0,1\.65fr\) minmax\(355px,\.9fr\)/);
 assert.match(styles,/height:calc\(100dvh - 145px\)/);
 assert.match(styles,/@media\(max-width:1023px\)/);
 assert.match(app,/computeAreaSummary/);
 assert.match(styles,/\.bw-focus-odds-pair strong/);
 assert.match(styles,/\.bw-focus-layout \.chart-measure/);
});
