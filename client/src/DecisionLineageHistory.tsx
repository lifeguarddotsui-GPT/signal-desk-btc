import React,{useEffect,useState} from "react";
import {RealFillAuditPanel} from "./RealFillAuditPanel";

type Choice={
  state:string;side:"UP"|"DOWN"|null;score:string;decisionId:string|null;
  savedAtMs:number|null;acknowledgedAtMs:number|null;probabilityUp:number|null;
  policyVersion:string|null;modelVersion:string|null;source:string|null;reason:string|null;
};
type Row={
  roundId:string;intervalMinutes:5|15;startMs:number;expiryMs:number;marketId:string|null;
  outcome:"UP"|"DOWN"|null;settlementStatus:string;primary:Choice;early:Choice;
  confirmation:Choice;checkpoint:Choice|null;congruence:string;learningNote:string;
};
type Stats={locked:number;correct:number;incorrect:number;scored:number;accuracy:number|null;coverage:number|null;
  brier:number|null;probabilityScoredN:number;medianSecondsRemainingAtAck:number|null};
type Payload={asOfMs:number;window:string;interval:string;cohortN:number;truncated:boolean;source:string;
  stats:{primary:Stats;early:Stats;confirmation:Stats};
  paired:{verifiedN:number;agree:number;disagree:number;earlyWrongPrimaryCorrect:number;earlyCorrectPrimaryWrong:number;
    earlyConfirmationVerifiedN:number;confirmationCorrectedEarly:number;confirmationReversedCorrectEarly:number};
  timingBands?:{stage:"primary"|"early"|"confirmation";intervalMinutes:5|15;
    band:"FIRST_THIRD"|"MIDDLE_THIRD"|"LAST_THIRD";locked:number;
    verifiedN:number;correct:number;incorrect:number;descriptiveAccuracy:number|null;minimumSampleN:number}[];
  rows:Row[]};
const stamp=(n:number|null|undefined)=>n==null?"Not recorded":new Date(n).toLocaleString(undefined,{dateStyle:"short",timeStyle:"short"});
const percentage=(n:number|null)=>n==null?"Not measurable":`${(n*100).toFixed(1)}%`;
const direction=(c:Choice)=>c.side??(c.reason?.includes("CONFIRMATION_POLICY_NOT_QUALIFIED")?"Model not qualified":c.state==="NO_LOCK"?"No saved choice":c.state.replaceAll("_"," "));
const result=(c:Choice)=>c.score==="NO_LOCK"?c.reason?.includes("CONFIRMATION_POLICY_NOT_QUALIFIED")?
  "INACTIVE MODEL":"NO LOCK":c.score.replaceAll("_"," ");
function Stage({title,choice}:{title:string;choice:Choice}){
  return <div className="two-stage-fact">
    <span>{title}</span><b>{direction(choice)} · {result(choice)}</b>
    {choice.side&&<small>Frozen {stamp(choice.savedAtMs)} · {choice.modelVersion?
      `Model ${choice.modelVersion}`:choice.policyVersion?.startsWith("confirmation-evidence-guard")?
        "Evidence guard · uncalibrated":"Market-evidence policy · uncalibrated"}</small>}
    {choice.reason&&<small>{choice.reason.replaceAll("_"," ")}</small>}
  </div>;
}
function StatsLine({label,data}:{label:string;data:Stats}){
  return <div className="two-stage-stat-grid">
    <div><span>{label} correct / incorrect</span><b>{data.correct} / {data.incorrect}</b></div>
    <div><span>Accuracy · verified saved n={data.scored}</span><b>{percentage(data.accuracy)}</b></div>
    <div><span>Prediction coverage · saved n={data.locked}</span><b>{percentage(data.coverage)}</b></div>
    <div><span>Frozen market-odds Brier · n={data.probabilityScoredN}</span><b>{data.brier==null?"Not measurable":data.brier.toFixed(4)}</b></div>
    <div><span>Median time remaining at durable acknowledgement</span><b>{data.medianSecondsRemainingAtAck==null?"Not available":`${Math.round(data.medianSecondsRemainingAtAck)}s`}</b></div>
  </div>;
}
export default function DecisionLineageHistory(){
  const [interval,setInterval]=useState("all");
  const [window,setWindow]=useState("24h");
  const [beforeLocal,setBeforeLocal]=useState("");
  const [reload,setReload]=useState(0);
  const [data,setData]=useState<Payload|null>(null);
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(true);
  useEffect(()=>{
    const abort=new AbortController();setLoading(true);setError("");setData(null);
    const query=new URLSearchParams({interval,window,limit:"40"});
    const before=beforeLocal?new Date(beforeLocal).getTime():NaN;
    if(Number.isFinite(before)&&before>0)query.set("beforeMs",String(before));
    fetch(`/api/waterx/decision-lineage?${query.toString()}`,{signal:abort.signal})
      .then(async r=>{if(!r.ok)throw new Error(`History unavailable (${r.status}). No data inferred.`);return r.json();})
      .then((p:Payload)=>{if(!abort.signal.aborted)setData(p);})
      .catch(e=>{if(!abort.signal.aborted)setError(String((e as Error).message));})
      .finally(()=>{if(!abort.signal.aborted)setLoading(false);});
    return ()=>abort.abort();
  },[interval,window,beforeLocal,reload]);
  return <section className="two-stage-history" aria-label="Unified verified decision history" aria-busy={loading}>
    <header className="two-stage-history-heading"><div>
      <h2>One round · independent predictions</h2>
      <p>Primary benchmark, Early research, and evidence/learned Confirmation are independent,
      frozen only after storage acknowledgement. This history makes no trades and performs no background polling.</p>
    </div></header>
    <div className="two-stage-filters">
      <label>Market<select value={interval} onChange={e=>setInterval(e.target.value)}>
        <option value="all">BTC 5m + 15m</option><option value="5">BTC 5m</option><option value="15">BTC 15m</option>
      </select></label>
      <label>Observed window<select value={window} onChange={e=>setWindow(e.target.value)}>
        <option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option>
      </select></label>
      <label>Show history before (device time)
        <input type="datetime-local" value={beforeLocal} onChange={e=>setBeforeLocal(e.target.value)}/>
      </label>
      {beforeLocal&&<button type="button" onClick={()=>setBeforeLocal("")}>Back to latest</button>}
      <button type="button" onClick={()=>setReload(x=>x+1)}>Refresh once</button>
    </div>
    {loading&&<p>Loading bounded, verified exact-round records…</p>}
    {error&&<p role="alert">{error} Historical data and correctness are not inferred.</p>}
    {data&&<div>
      <p className="two-stage-cohort">{data.cohortN} discovered rounds on this page · {data.window} ·
        as of {stamp(data.asOfMs)} · no predictions invented for visitor-idle clock slots.
        {beforeLocal?" Filtered to earlier completed rounds.":""}
        {data.truncated?" Showing latest 40; older records not included in these statistics.":""}</p>
      <StatsLine label="Primary 30-second benchmark" data={data.stats.primary}/>
      <StatsLine label="Early research" data={data.stats.early}/>
      <StatsLine label="Confirmation experiment" data={data.stats.confirmation}/>
      <details className="history-timing-bands">
        <summary>Historical lock timing by round third · exploratory, not trade entry</summary>
        <p>These groups use saved prediction acknowledgement time, not actual WaterX purchase time.
          The same market can change price between a saved decision and an order fill.
          Accuracy is withheld for fewer than 20 verified observations in a matching cohort.</p>
        <div className="history-timing-scroll">
          <table><thead><tr><th>Signal</th><th>Interval</th><th>Frozen window</th><th>Verified n</th>
            <th>Correct / incorrect</th><th>Historical accuracy</th></tr></thead>
            <tbody>{(data.timingBands??[]).map(r=><tr key={`${r.stage}-${r.intervalMinutes}-${r.band}`}>
              <td>{r.stage}</td><td>{r.intervalMinutes}m</td>
              <td>{r.band==="FIRST_THIRD"?"Early":r.band==="MIDDLE_THIRD"?"Middle":"Late"}</td>
              <td>{r.verifiedN}</td><td>{r.correct} / {r.incorrect}</td>
              <td>{r.descriptiveAccuracy==null?"Insufficient sample":percentage(r.descriptiveAccuracy)}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </details>
      <section className="two-stage-paired" aria-label="Primary and early decision congruence">
        <h3>Matched early / primary comparison</h3>
        <p>Verified paired rounds n={data.paired.verifiedN} · same direction {data.paired.agree} ·
          different direction {data.paired.disagree} · primary corrected Early {data.paired.earlyWrongPrimaryCorrect} ·
          primary reversed a correct Early {data.paired.earlyCorrectPrimaryWrong}.
          Verified Early/Confirmation pairs n={data.paired.earlyConfirmationVerifiedN} · Confirmation corrected Early
          {data.paired.confirmationCorrectedEarly} · Confirmation reversed a correct Early
          {data.paired.confirmationReversedCorrectEarly}.</p>
      </section>
      {data.rows.length?<div className="two-stage-round-list">
        {data.rows.map(r=><article className="two-stage-history-row" key={`${r.roundId}:${r.intervalMinutes}:${r.startMs}`}>
          <details>
            <summary><b>{stamp(r.startMs)} · BTC {r.intervalMinutes}m</b>
              <span>Primary {r.primary.side??"—"} · {result(r.primary)}</span>
              <span>WaterX {r.settlementStatus==="VERIFIED"?r.outcome:r.settlementStatus}</span>
            </summary>
            <div className="two-stage-row-body">
              <Stage title="Bluewater primary · 30-second benchmark" choice={r.primary}/>
              <Stage title="Early research · independent frozen candidate" choice={r.early}/>
              <Stage title="Confirmation · rule guard or qualified model" choice={r.confirmation}/>
              {r.checkpoint&&<Stage title="Separate historical champion/market checkpoint" choice={r.checkpoint}/>}
              <div className="two-stage-fact"><span>Official WaterX result</span>
                <b>{r.settlementStatus==="VERIFIED"?`VERIFIED · ${r.outcome}`:r.settlementStatus}</b></div>
              <div className="two-stage-fact"><span>Primary vs Early direction</span><b>{r.congruence.replaceAll("_"," ")}</b></div>
              <p><strong>Learning interpretation:</strong> {r.learningNote}</p>
              <RealFillAuditPanel round={r}/>
              <details><summary>Evidence IDs, policy and acknowledgement timing</summary>
                <pre>{JSON.stringify({marketId:r.marketId,roundId:r.roundId,startMs:r.startMs,expiryMs:r.expiryMs,
                  primary:r.primary,early:r.early,confirmation:r.confirmation,checkpoint:r.checkpoint},null,2)}</pre>
              </details>
            </div>
          </details>
        </article>)}
      </div>:<p>No prospectively discovered exact-round records in the selected window. Idle periods are not classified as failures.</p>}
      <p className="two-stage-footnote">Accuracies apply only to verified saved decisions in this bounded page, not all trading opportunities.
        Market-implied Brier scores are diagnostics, not evidence of an independent calibrated Bluewater model. They are not executable quotes; never infer P/L.</p>
    </div>}
  </section>;
}
