import React, { useEffect, useMemo, useState } from "react";
import type { PairedRow, Stage, Score, PairedWinner } from "../../shared/paired-history";
import "./paired-history.css";

type Window = "24h" | "7d" | "lifetime" | "20" | "50" | "100";
type Interval = "all" | "5" | "15";
type Response = {
  status: "ok"; asOfMs: number; summary: {
    rounds: number; paired: number; scoredPairs: number; agree: number; disagree: number;
    early: StageStats; confirmation: StageStats; benchmark: StageStats; pendingSettlements: number; disputedSettlements: number;
  }; rows: PairedRow[]; totalRows: number; rowsTruncated: boolean; note: string;
};
type StageStats = {correct:number;incorrect:number;unrecorded:number;pending:number;disputed:number;
  abstained:number;dataFailures:number;locks:number;accuracy:number|null};
type Load = {kind:"loading"} | {kind:"error";message:string} | {kind:"ready";data:Response};
const time=(ms:number)=>new Date(ms).toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"});
const date=(ms:number)=>new Date(ms).toLocaleDateString(undefined,{month:"short",day:"numeric"});
const rate=(n:number|null)=>n===null?"—":(n*100).toFixed(1)+"%";
const label=(value:string)=>value.replaceAll("_"," ").toLowerCase();
const resultLabel=(result:Score)=>result==="UNRECORDED"?"No lock":result==="DATA_FAILURE"?"Data failure":
  result==="ABSTAINED"?"Abstained":result==="PENDING"?"Awaiting result":result==="DISPUTED"?"Disputed":
  result==="CORRECT"?"Correct":"Incorrect";
const winnerLabel=(winner:PairedWinner)=>({
  BOTH_CORRECT:"Both correct",EARLY_ONLY_CORRECT:"Early correct",
  CONFIRMATION_ONLY_CORRECT:"Confirmation correct",BOTH_INCORRECT:"Both incorrect",
  NOT_COMPARABLE:"Not comparable"
})[winner];
function Decision({title,stage}:{title:string;stage:Stage}) {
  return <div className="pair-decision">
    <span className="pair-small">{title}</span>
    <strong className={stage.side==="UP"?"pair-up":stage.side==="DOWN"?"pair-down":"pair-no-lock"}>
      {stage.side??"No lock"}
    </strong>
    <span className={`pair-result pair-result-${stage.result.toLowerCase()}`}>{resultLabel(stage.result)}</span>
    {stage.secondsBeforeExpiry!==null && <span className="pair-small">{Math.round(stage.secondsBeforeExpiry)}s before end</span>}
  </div>;
}
function Stat({title,stats}:{title:string;stats:StageStats}) {
  return <div className="pair-stat-card">
    <div className="pair-stat-heading">{title}</div>
    <div className="pair-stat-ratio">
      <span className="pair-correct">{stats.correct}</span><span>:</span>
      <span className="pair-incorrect">{stats.incorrect}</span><span>:</span>
      <span className="pair-missing">{stats.unrecorded}</span>
    </div>
    <div className="pair-stat-caption">Correct : Incorrect : No saved lock</div>
    <div className="pair-stat-footer">
      <strong>{rate(stats.accuracy)} <small>accuracy</small></strong>
      <span>{stats.pending} pending · {stats.disputed} disputed</span>
    </div>
  </div>;
}
export default function PairedHistory() {
  const [interval,setInterval]=useState<Interval>("all");
  const [windowFilter,setWindowFilter]=useState<Window>("24h");
  const [filter,setFilter]=useState<"all"|"paired"|"unrecorded"|"scored">("all");
  const [refresh,setRefresh]=useState(0);
  const [load,setLoad]=useState<Load>({kind:"loading"});
  useEffect(()=>{
    const controller=new AbortController(),params=new URLSearchParams({interval,window:windowFilter});
    setLoad({kind:"loading"});
    fetch(`/api/waterx/paired-history?${params}`,{signal:controller.signal,credentials:"include",headers:{Accept:"application/json"}})
      .then(async response=>{
        const json=await response.json() as Partial<Response>&{error?:string;reason?:string};
        if(!response.ok||json.status!=="ok")throw new Error(json.reason??json.error??"Paired history is unavailable");
        if(!controller.signal.aborted)setLoad({kind:"ready",data:json as Response});
      }).catch(error=>{if(!controller.signal.aborted)setLoad({kind:"error",message:error instanceof Error?error.message:"History unavailable"});});
    return ()=>controller.abort();
  },[interval,windowFilter,refresh]);
  const rows=useMemo(()=>load.kind!=="ready"?[]:load.data.rows.filter(row=>
    filter==="all" || (filter==="paired"&&row.congruence!=="NOT_COMPARABLE") ||
    (filter==="scored"&&(row.early.result==="CORRECT"||row.early.result==="INCORRECT"||
      row.confirmation.result==="CORRECT"||row.confirmation.result==="INCORRECT")) ||
    (filter==="unrecorded"&&(row.early.status!=="LOCKED"||row.confirmation.status!=="LOCKED"||
      row.settlement!=="VERIFIED"))),[load,filter]);
  return <section className="paired-history" aria-label="Paired prediction history">
    <header className="pair-page-title">
      <div><span className="pair-eyebrow">BLUEWATER AI · ROUND RESEARCH</span>
        <h1>Round History</h1>
        <p>Early Lock, qualification-gate Confirmation Lock, and the separately frozen Bluewater Decision market benchmark. Only prospective saved choices are scored against verified WaterX outcomes.</p>
      </div>
      <button className="pair-refresh" onClick={()=>setRefresh(n=>n+1)}>Refresh</button>
    </header>
    <div className="pair-filters">
      <label>Market <select value={interval} onChange={e=>setInterval(e.target.value as Interval)}>
        <option value="all">All BTC rounds</option><option value="5">BTC 5 min</option><option value="15">BTC 15 min</option>
      </select></label>
      <label>Period <select value={windowFilter} onChange={e=>setWindowFilter(e.target.value as Window)}>
        <option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option>
        <option value="20">Last 20 rounds</option><option value="50">Last 50 rounds</option>
        <option value="100">Last 100 rounds</option><option value="lifetime">Lifetime (bounded)</option>
      </select></label>
    </div>
    {load.kind==="loading"&&<p className="pair-notice" role="status">Loading verified round records…</p>}
    {load.kind==="error"&&<p className="pair-notice" role="alert">Data unavailable: {load.message}. No example predictions have been substituted.</p>}
    {load.kind==="ready"&&<>
      <div className="pair-stats">
        <Stat title="Early Lock" stats={load.data.summary.early}/>
        <Stat title="Confirmation Lock · qualified" stats={load.data.summary.confirmation}/>
        <Stat title="Bluewater Decision · market benchmark" stats={load.data.summary.benchmark}/>
        <div className="pair-stat-card pair-pairing">
          <div className="pair-stat-heading">Lock agreement</div>
          <div className="pair-stat-ratio">{load.data.summary.agree} <span>/</span> {load.data.summary.paired}</div>
          <div className="pair-stat-caption">Agree / both locks recorded</div>
          <div className="pair-stat-footer"><strong>{load.data.summary.disagree} disagree</strong>
            <span>{load.data.summary.scoredPairs} verified pairs</span></div>
        </div>
      </div>
      <div className="pair-toolbar">
        <div><h2>Recorded rounds</h2><span>{load.data.summary.rounds} observed · {load.data.summary.pendingSettlements} settlement checks pending</span></div>
        <label>Show <select value={filter} onChange={e=>setFilter(e.target.value as typeof filter)}>
          <option value="all">All rounds</option><option value="paired">Both locks recorded</option>
          <option value="scored">Scored predictions</option><option value="unrecorded">Missing / pending</option>
        </select></label>
      </div>
      <div className="pair-list">
        {rows.map(row=><article className="pair-round" key={`${row.intervalMinutes}-${row.roundId}-${row.startMs}`}>
          <div className="pair-round-main">
            <div className="pair-identity"><strong>{time(row.startMs)}</strong><span>{date(row.startMs)} · BTC {row.intervalMinutes}m</span></div>
            <Decision title="Early Lock" stage={row.early}/>
            <Decision title="Qualified confirmation" stage={row.confirmation}/>
            <div className="pair-compare"><span className="pair-small">Congruence</span>
              <strong>{row.congruence==="AGREE"?"Agree":row.congruence==="DISAGREE"?"Disagree":"No pair"}</strong>
              <span className="pair-small">{winnerLabel(row.pairedWinner)}</span>
            </div>
            <div className="pair-outcome"><span className="pair-small">Final outcome</span>
              <strong className={row.settlement==="VERIFIED"?(row.outcome==="UP"?"pair-up":"pair-down"):"pair-no-lock"}>
                {row.settlement==="VERIFIED"?row.outcome:row.settlement==="DISPUTED"?"Disputed":row.settlement==="WITHHELD"?"Withheld":row.settlement==="NOT_OBSERVED"?"No source record":"Pending"}
              </strong>
              <span className="pair-small">{row.settlement==="VERIFIED"?"Verified WaterX result":row.settlement==="WITHHELD"?"Evidence withheld · unscored":row.settlement==="NOT_OBSERVED"?"Source outcome not observed":"Not independently scored"}</span>
            </div>
          </div>
          <details className="pair-details"><summary>Round details & capture diagnostics</summary>
            <div className="pair-detail-grid">
              <div><span>Round ID</span><strong>{row.roundId}</strong></div>
              <div><span>Early decision</span><strong>{row.early.decisionAtMs===null?"Not recorded":new Date(row.early.decisionAtMs).toLocaleString()}</strong></div>
              <div><span>Confirmation decision</span><strong>{row.confirmation.decisionAtMs===null?"Not recorded":new Date(row.confirmation.decisionAtMs).toLocaleString()}</strong></div>
              <div><span>Confirmation record status</span><strong>{label(row.confirmation.status)}</strong></div>
              <div><span>Bluewater Decision · frozen benchmark</span><strong>{row.benchmark.recordStatus==="FROZEN"?`${row.benchmark.side} · ${resultLabel(row.benchmark.result)}`:row.benchmark.recordStatus==="AMBIGUOUS"?"Multiple conflicting baseline rows · unscored":row.benchmark.recordStatus==="INVALID"?"Invalid frozen benchmark · unscored":"No frozen market baseline recorded"}</strong></div>
              <div><span>Benchmark lock timestamp</span><strong>{row.benchmark.decisionAtMs===null?"Not recorded":new Date(row.benchmark.decisionAtMs).toLocaleString()}</strong></div>
              <div><span>Failure classification</span><strong>{label(row.diagnostics.confirmationCause)}</strong></div>
              <div><span>Gate journal</span><strong>{row.diagnostics.gateCount} recorded · {row.diagnostics.missedGates} missed · {row.diagnostics.waitsForFreshData} awaiting fresh data · {row.diagnostics.qualifiedGates} qualified</strong></div>
              <div><span>Early probability UP</span><strong>{rate(row.early.probabilityUp)}</strong></div>
              <div><span>Confirmation probability UP</span><strong>{rate(row.confirmation.probabilityUp)}</strong></div>
            </div>
          </details>
        </article>)}
      </div>
      {!rows.length&&<p className="pair-notice">No matching recorded rounds. Missing decisions are not counted as incorrect.</p>}
      <p className="pair-help">No saved lock includes abstentions, source failures, and missing decisions; these are not incorrect predictions. Confirmation Lock requires its own qualification-gate record. Bluewater Decision is a separate frozen market benchmark, never silently substituted as confirmation. Settlement pending, evidence withheld, and no provider record are different states. Percent accuracy is calculated only from correct + incorrect verified choices. No trades or realized P/L are inferred.</p>
      {load.data.rowsTruncated&&<p className="pair-help">Showing {load.data.rows.length} newest of {load.data.totalRows} observed rounds. Cohort totals include all returned rounds.</p>}
    </>}
  </section>;
}
