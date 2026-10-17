import * as React from "react";
import {researchVerifiedFills,type EntryFillEvidence} from "../../shared/filled-entry-training";

/** File remains inside this browser session. No server upload, wallet API or model promotion. */
export function VerifiedFillLearningPanel({interval}:{interval:5|15}){
  const [rows,setRows]=React.useState<EntryFillEvidence[]|null>(null);
  const [error,setError]=React.useState("");
  const [name,setName]=React.useState("");
  const report=React.useMemo(()=>rows?researchVerifiedFills(rows,interval,Date.now()):null,[rows,interval]);
  async function receiveFile(file:File|undefined){
    setRows(null);setError("");setName("");
    if(!file)return;
    try{
      if(file.size>2_000_000)throw new Error("File exceeds the 2MB research import limit.");
      const parsed:unknown=JSON.parse(await file.text());
      if(!Array.isArray(parsed)||parsed.length>10000)
        throw new Error("Expected a JSON array of at most 10,000 externally verified WaterX fill records.");
      if(!parsed.every(record=>record!==null&&typeof record==="object"&&!Array.isArray(record)))
        throw new Error("Every imported fill record must be a structured object.");
      setRows(parsed as EntryFillEvidence[]);setName(file.name);
    }catch(e){setError(e instanceof Error?e.message:"Unable to read research file.");}
  }
  return <section className="fill-research-panel" aria-label="Verified fill timing research">
    <div className="eyebrow">EXECUTED FILLS / OFFLINE TRAINING</div>
    <h2>Did early entries actually earn more?</h2>
    <p>Compare <strong>actual WaterX execution prices</strong> and externally verified post-expiry Chainlink TWAP settlement evidence. This research reports historical outcomes by entry time and side; it does not turn market odds into an independent prediction.</p>
    <label className="fill-research-file">Import independently reconciled fill-receipt JSON (local only)
      <input type="file" accept=".json,application/json" onChange={e=>void receiveFile(e.currentTarget.files?.[0])}/>
    </label>
    <p className="fill-research-disclaimer">The file stays on your device. Nothing is uploaded, saved in the production database, or used to initiate trades. The import does not cryptographically verify claims inside the file.</p>
    {error&&<p role="alert">{error}</p>}
    {!report?<p className="fill-research-empty">No verified actual-fill dataset imported. Model advantage and optimal entry timing remain unqualified.</p>:<>
      <strong>{name} · BTC {interval}m · {report.status.replaceAll("_"," ")}</strong>
      <div className="fill-research-facts">
        <span>Eligible unique rounds <b>{report.acceptedUniqueRounds}</b></span>
        <span>Held-out test fills <b>{report.testN}</b></span>
        <span>Held-out net P&L <b>{report.testNetUsd.toFixed(2)} USD</b></span>
        <span>Trading authority <b>OFF</b></span>
      </div>
      {report.researchSelection&&<div className="fill-research-selected">
        <strong>Research timing candidate · {report.researchSelection.band.replaceAll("_"," ")} · {report.researchSelection.side}</strong>
        <p>Selected with {report.researchSelection.trainN} training and {report.researchSelection.calibrationN} calibration fills; then evaluated on {report.researchSelection.heldOutN} untouched test fills. Held-out mean net: {report.researchSelection.heldOutMeanNetUsd==null?"Insufficient observations":`${report.researchSelection.heldOutMeanNetUsd.toFixed(2)}`}.</p>
        <p>This is a retrospective, selection-biased research candidate. It cannot be promoted to a trade timing recommendation.</p>
      </div>}
      {report.reasons.map(x=><p key={x}>{x}</p>)
      <div className="fill-research-scroll"><table>
        <thead><tr><th>Entry period</th><th>Side</th><th>Fills</th><th>Correct</th><th>Mean net</th><th>+$1–$2 if won</th></tr></thead>
        <tbody>{report.testCohorts.map(row=><tr key={row.band+row.side}>
          <td>{row.band.replaceAll("_"," ").toLowerCase()}</td><td>{row.side}</td>
          <td>{row.count}</td><td>{row.accuracy==null?"—":`${(row.accuracy*100).toFixed(1)}%`}</td>
          <td>{row.meanNetUsd==null?"—":`$${row.meanNetUsd.toFixed(2)}`}</td>
          <td>{row.targetPriceN}</td></tr>)}</tbody>
      </table></div>
      <p className="fill-research-disclaimer">{report.limitation} Nothing in this report constitutes an approved forecast, automated trade instruction or positive expected return.</p>
    </>}
  </section>;
}
