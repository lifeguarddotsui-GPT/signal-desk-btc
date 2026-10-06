import fs from "node:fs";
import { createHash } from "node:crypto";

const read=p=>JSON.parse(fs.readFileSync(p,"utf8"));
const reports=[5,15].map(i=>read(`/tmp/lock-delivery-api-${i}.json`));
const collectors=[5,15].map(i=>read(`/tmp/lock-delivery-collector-${i}.json`));
const models=[5,15].map(i=>read(`/tmp/lock-final-model-${i}.json`));
const bootstrap=[5,15].map(i=>read(`/tmp/lock-report-api-${i}.json`));
const esc=v=>String(v??"—").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
const num=(v,n=3)=>v==null?"Unavailable":Number(v).toFixed(n);
const percent=v=>v==null?"Unavailable":`${num(v*100,2)}%`;
const table=(headers,rows)=>`<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(v=>`<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const tests=fs.readFileSync("/tmp/lock-full-tests.log","utf8");
const build=fs.readFileSync("/tmp/lock-build.log","utf8");
if(!/# pass 429\b/.test(tests)||!/# fail 0\b/.test(tests)||!/# skipped 0\b/.test(tests)||!build.includes("dist/waterx-worker.mjs"))
  throw new Error("Final verification outputs are incomplete");
for(const report of reports)if(report.schemaStatus!=="available")throw new Error("Development report unavailable");
const generated=new Date().toISOString();
const counts=table(["Interval","Pinned exact rounds","Observed samples","First-READY candidates","Matched verified rounds"],
  reports.map(r=>[`${r.intervalMinutes}m`,r.counts.rounds,r.counts.observations,r.counts.candidates,r.counts.matched]));
const comparisonRows=[];
for(const r of reports){
  const c=r.comparison;
  comparisonRows.push([`${r.intervalMinutes}m first READY`,c.early.n,percent(c.early.accuracy),num(c.early.brier,8),num(c.early.logLoss,8),
    num(c.averageSecondsBeforeEarlyLock),num(c.averageSecondsGained),num(c.averageSecondsGainedVsFallback)]);
  comparisonRows.push([`${r.intervalMinutes}m matched canonical`,c.canonical.n,percent(c.canonical.accuracy),num(c.canonical.brier,8),
    num(c.canonical.logLoss,8),num(c.averageSecondsBeforeCanonicalLock),"Reference","Reference"]);
}
const delta=table(["Interval","Accuracy difference (early − canonical)","Brier difference","Log-loss difference","Conclusion"],
  reports.map(r=>[`${r.intervalMinutes}m`,r.comparison.accuracyDifference==null?"Unavailable":`${num(r.comparison.accuracyDifference*100,3)} pp`,
    num(r.comparison.brierDifference,8),num(r.comparison.logLossDifference,8),r.comparison.state]));
const checkpoints=[];
for(const r of reports)for(const c of r.checkpoints)checkpoints.push([
  `${r.intervalMinutes}m / ${c.lockSeconds}s`,c.early.n,percent(c.early.accuracy),num(c.early.brier,8),num(c.canonical.brier,8),
  num(c.early.logLoss,8),num(c.canonical.logLoss,8),num(c.averageSecondsGained)]);
const latency=[];
for(const r of reports)for(const [key,value] of Object.entries(r.latency))
  latency.push([`${r.intervalMinutes}m`,key,value.n,num(value.p50Ms),num(value.p95Ms)]);
const initialTotals=[];
for(const r of bootstrap)for(const [key,value] of Object.entries(r.latency))if(key.endsWith(":totalMs"))
  initialTotals.push([`${r.intervalMinutes}m`,new Date(r.asOfMs).toISOString(),key,value.n,num(value.p50Ms),num(value.p95Ms)]);
const diagnostics=[];
for(const r of reports)for(const d of r.missedWindows)diagnostics.push([
  `${r.intervalMinutes}m`,d.roundId,`${d.lockSeconds}s`,d.code,new Date(d.atMs).toISOString(),d.reason]);
const speed=[];
for(const r of reports)for(const s of r.recentSpeeds)speed.push([
  `${r.intervalMinutes}m`,s.roundId,num(s.startToLeanSeconds),num(s.leanToFinalSeconds),num(s.secondsRemainingAtFinal),
  percent(s.probabilityAtLean),percent(s.probabilityAtEligibility),percent(s.probabilityAtFinal),s.reversals,
  percent(s.minProbabilityDuringLean),percent(s.maxProbabilityDuringLean),
  s.marketMovementSinceLean==null?"Unavailable":`${num(s.marketMovementSinceLean*100,3)} pp`,
  num(s.captureLatencyMs)]);
const screens=[
  ["Desktop · 1440 × 1500", "reports/bluewater-lock-readiness-desktop.jpg"],
  ["Narrow phone · 320 × 2000", "reports/bluewater-lock-readiness-phone.jpg"],
  ["Phone · 375 × 1600", "reports/bluewater-lock-readiness-phone-375.jpg"],
  ["Phone · 390 × 1600", "reports/bluewater-lock-readiness-phone-390.jpg"],
  ["Phone · 430 × 1600", "reports/bluewater-lock-readiness-phone-430.jpg"],
];
const imageRows=screens.map(([title,path])=>{
  const b=fs.readFileSync(path);
  return {title,path,sha256:createHash("sha256").update(b).digest("hex"),data:`data:image/jpeg;base64,${b.toString("base64")}`};
});
const provenance={generatedAt:generated,scope:"DEVELOPMENT ONLY — no publish, production changes or trading",
  reports,collectors,qualification:models.map(m=>({intervalMinutes:m.intervalMinutes,asOf:m.asOf,status:m.status,
    champion:m.champion,qualifiedCalibration:m.qualifiedCalibration,currentForecast:m.currentForecast})),
  bootstrapReceiptToCommit:bootstrap.map(r=>({intervalMinutes:r.intervalMinutes,asOfMs:r.asOfMs,
    validTotals:Object.fromEntries(Object.entries(r.latency).filter(([k])=>k.endsWith(":totalMs")))})),
  screenshots:imageRows.map(({data,...rest})=>rest),verification:{pass:429,fail:0,skipped:0,typecheck:"passed",webBuild:"passed",serverBuild:"passed",workerBuild:"passed"}};
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bluewater · Development lock-speed and readiness evidence</title><style>
*{box-sizing:border-box}body{margin:0;background:#071319;color:#e6f1ef;font:15px/1.6 system-ui,sans-serif}
main{max-width:1240px;margin:auto;padding:44px 26px 90px}h1{font-size:36px;line-height:1.15;max-width:800px;margin:18px 0}
h2{font-size:23px;border-top:1px solid #294046;padding-top:26px;margin-top:36px}h3{font-size:18px}p,li{max-width:1050px}
.tag{font:12px monospace;letter-spacing:1px;color:#b0ee74}.notice{background:#17261f;border-left:3px solid #b0ee74;padding:16px 20px}
.warn{background:#2a241b;border-left:3px solid #e7b568;padding:15px 20px}a{color:#b0ee74}.muted,small{color:#b3c6c4}
.table-wrap{overflow:auto;border:1px solid #2b4349;border-radius:6px;margin:18px 0}table{border-collapse:collapse;width:100%;font-size:13px}
th{text-align:left;background:#142a30;color:#b0ee74}td,th{padding:10px 12px;border-bottom:1px solid #284048;vertical-align:top}
code{font:13px ui-monospace,monospace;color:#b9e2ce}pre{overflow:auto;white-space:pre-wrap;background:#0d2128;padding:18px;border:1px solid #29454c;font:12px/1.55 monospace}
details{margin:18px 0;padding:14px;background:#0c2027;border:1px solid #29454c;border-radius:6px}summary{cursor:pointer;font-weight:600}
figure{margin:24px 0}figcaption{color:#c2d4d1;margin:10px 0;font-size:13px}img{max-width:100%;height:auto;border:1px solid #3a5156;border-radius:6px}
.phones{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:22px;align-items:start}.phones img{width:100%}
@media(max-width:600px){main{padding:24px 14px}h1{font-size:27px}h2{font-size:20px}.phones{grid-template-columns:1fr}.phones img{max-width:430px}}
@media print{body{background:white;color:#111}h2{break-before:auto}.phones{grid-template-columns:repeat(2,1fr)}table{font-size:10px}pre{color:#111}details{display:block}}
</style></head><body><main>
<div class="tag">BLUEWATER / DEVELOPMENT-ONLY RESEARCH</div>
<h1>Lock-speed and lock-readiness upgrade: implementation and evidence</h1>
<p class="muted">Generated ${esc(generated)}. API snapshots: ${reports.map(r=>`${r.intervalMinutes}m ${new Date(r.asOfMs).toISOString()}`).map(esc).join("; ")}. Times are UTC; this work occurred on October 2 in America/Belize.</p>
<div class="notice"><strong>Implemented and development-verified.</strong> Canonical fallbacks remain 5m/60s and 15m/180s. Early locks remain immutable shadow candidates. No publication, production migration/change, model promotion or trading was performed.</div>
<div class="warn"><strong>Not a predictive-quality acceptance.</strong> ${reports.map(r=>`${r.intervalMinutes}m: ${r.comparison.early.n} verified matched rounds`).join("; ")}. Neither interval has enough evidence to choose an optimal policy. Readiness is mechanical progress, not win probability.</div>

<h2>1. Existing canonical lock logic</h2>
<p>The append-only WATCHING → LEANING → FINAL_CHOICE → RESULT lifecycle remains authoritative. A lean can change before the checkpoint; FINAL_CHOICE cannot. The pinned primary target is 60 seconds before 5-minute expiry or 180 seconds before 15-minute expiry. Exact round identity, genuine decision-time evidence, compatible model qualification and verified post-expiry settlement remain required. A valid WaterX Market Baseline is not an independent Bluewater model.</p>
<p>The requested READY and BUILDING LOCK states live in a separate research/UI layer. A READY candidate cannot update the canonical choice. The original fallback also remains the reference row in matched evaluation.</p>

<h2>2. Causes of decision delay and operational changes</h2>
<ul>
<li><strong>Intentional policy waiting:</strong> the existing primary fallback is scheduled late in the round. Earlier stable odds never authorized an official earlier lock.</li>
<li><strong>Opportunistic scheduling:</strong> the ordinary collector starts a subsequent poll after the preceding read completes (5s for 5m, 10s for 15m outside early windows), adding network/parse duration to its cadence. It did not previously pre-arm these research checkpoints.</li>
<li><strong>Persistence/enrichment coupling:</strong> legacy first-odds persistence and optional model/feature lookups could occupy the queue needed for a subsequent canonical observation. Development now has separate priority canonical and adaptive queues. Optional model enrichment cannot hold the committed canonical client or delay the next canonical sample.</li>
<li><strong>Late discovery and restart:</strong> checkpoints that already passed cannot be recovered prospectively. The first development bootstrap missed five earlier checkpoints; they are data-health diagnostics, not intelligent hesitation.</li>
<li><strong>Unavailable model and settlement evidence:</strong> no champion or calibration is qualified. Historical round identity/closing-boundary mismatch and unresolved settlements are withheld; neither is repaired by inventing model forecasts or labels.</li>
</ul>
<p>For each discovered exact round, timers request fresh reads at checkpoint −1.5s, checkpoint, and checkpoint +2s. Old-round timers are cancelled. Development polls at up to 3s cadence in the early window, with existing read coalescing, retry and watchdog protections. Timers request reads; they never lock cached odds. The existing five-second checkpoint tolerance was not widened.</p>
<p>These changes remove specific operational dependencies and have produced on-time live candidates. There is no controlled before/after benchmark proving a general latency improvement or uninterrupted coverage. Collectors remain process-memory scoped across restarts.</p>

<h2>3. Deterministic readiness formula</h2>
<p>Let <code>E</code> be the earliest permitted time and <code>F</code> the unchanged canonical fallback. Define <code>u = clamp((now − E)/(F − E), 0, 1)</code>. Required preferred-side strength is <code>0.72 − 0.07u</code>. Required observed same-side persistence is <code>24s − 12su</code> for 5m and <code>45s − 25su</code> for 15m.</p>
<pre>readiness = round(100 × (
  0.35 × clamp((preferredProbability − 0.50)/(requiredStrength − 0.50))
+ 0.30 × clamp(observedSameSideDuration/requiredPersistence)
+ 0.20 × stable
+ 0.10 × fresh
+ 0.05 × sourceHealthy
))
READY requires every rule below, including the permitted window.
Non-READY scores are capped at 99; READY scores are 100.
This is not a model probability or prediction confidence.</pre>
<p>Persistence ends at the latest actual observation, not the reporting clock. Reversals, missing-observation gaps and unhealthy observations reset it. Restarts replay pinned policy and ordered stored observations. Conditional earliest-lock time solves the relaxing strength/persistence curves under unchanged future conditions; it is not a promise or interpolated evidence. Impossible estimates, stale sources and times at/after fallback are withheld.</p>

<h2>4. Exact thresholds and persisted components</h2>
${table(["Component","5m","15m"],[
["Policy version","adaptive-waterx-lock-v1","adaptive-waterx-lock-v1"],
["Windows (seconds before expiry)","120, 90; canonical 60","360, 300, 240; canonical 180"],
["Strength curve","72% → 65%","72% → 65%"],
["Persistence curve","24s → 12s","45s → 20s"],
["Latest observation/known source age","≤10s","≤10s"],
["Largest permitted consecutive observation gap","12s; larger gap resets persistence","12s; larger gap resets persistence"],
["Stability window / probability range","15s / ≤4.5 percentage points","15s / ≤4.5 percentage points"],
["Minimum recent observations","3","3"],
["Recent reversals","≤1 in 30s","≤1 in 30s"],
["Absolute probability velocity","≤0.012 probability units/s","≤0.012 probability units/s"],
["Absolute acceleration","≤0.008 probability units/s²","≤0.008 probability units/s²"],
["Checkpoint grace","5s, unchanged","5s, unchanged"],
["Source health","Fresh exact-round live WaterX evidence","Fresh exact-round live WaterX evidence"]])}
<p>Each observation retains received/provider timestamps, both side probabilities, source health, state, score, preferred side, evaluation time, remaining time, same-side span, condition/reason, strength and duration thresholds, range, reversal count, recent count, age, gap reset, velocity, acceleration, window membership, freshness and stability. Full versioned policy is pinned once per exact round.</p>

<h2>5. Evidence storage, lookahead and settlement safety</h2>
<p>Six additive development-only tables hold pinned policies, observations, candidates, latency, missed-window diagnostics and result events. All are append-only. Candidate checkpoint 0 means the first continuously evaluated READY eligibility; positive checkpoint values are separate bounded research observations.</p>
<p>Database guards reject expired/backfilled policy, future observations/decisions, stale sources, wrong probability/round/version, out-of-window checkpoints and fabricated persistence/strength thresholds. The candidate guard independently checks persisted observation count, range, reversals, same-side duration and the pinned time curve. Application evaluation also enforces velocity and acceleration. No early candidate writes canonical choices or champion events.</p>
<p>Scoring requires exact interval/round/start/expiry identity, a verified undisputed and unquarantined label, positive coherent settlement prices, provider settlement time and first verified time strictly after expiry, and correct Brier/log-loss mathematics. Missing/null settlement provenance is rejected. Later invalidation appends WITHDRAWN, not a rewrite. Read-only reporting never captures candidates, refits models or grows persistence from elapsed wall time.</p>

<h2>6. Live candidate counts</h2>
${counts}
<p>“First-READY candidates” counts checkpoint 0 only. Additional positive-checkpoint candidate rows are separate forecasts; their timing events are included in early-candidate latency samples. Counts are development observations, not test fixtures. Historical rounds without prospective new candidate evidence are not backfilled.</p>

<h2>7. Matched accuracy versus time</h2>
${table(["Cohort","Matched n","Accuracy","Brier","Log loss","Mean seconds before expiry","Seconds gained vs actual canonical","Seconds gained vs nominal fallback"],comparisonRows)}
${delta}
<p>Differences are early minus canonical: positive Brier/log-loss differences are worse. The visible 100% hit rate in the tiny 5m cohort must not be interpreted as an expected success rate. No optimal timing policy was selected. At 90 or more labels the software changes the display only to DESCRIPTIVE_ONLY; it still cannot auto-promote or replace policy.</p>
<h3>Requested checkpoint cohorts</h3>
${table(["Interval / checkpoint","Matched n","Early accuracy","Early Brier","Canonical Brier","Early log loss","Canonical log loss","Seconds gained vs actual canonical"],checkpoints)}
<p>Zero-label rows remain unavailable rather than becoming 0% accuracy or a winning-policy claim. The report is bounded to a 14-day cohort, the latest 30 exact rounds for speed details, and explicit history limits; exceeding limits fails rather than silently accepting a partial matched set.</p>

<h2>8. Latency measurements and precision</h2>
<p><strong>Current definition: final-write-v1.</strong> Evaluation time is the actual final state-evaluation boundary. Transaction-start denotes the final evidence/choice write boundary <em>inside</em> an already-open lifecycle/adaptive transaction, not its literal outer BEGIN. “Commit” measures that boundary through successful commit, including intervening guarded writes and diagnostics; it is not isolated PostgreSQL COMMIT execution time. Millisecond wall-clock resolution can produce 0ms between adjacent boundaries; that is not proof of zero cost.</p>
${latency.length?table(["Interval","Measurement","n","p50 ms","p95 ms"],latency):'<p>No corrected-definition samples were available at this snapshot.</p>'}
<p>High-resolution evaluationComputeMs measures deterministic calculation, not trained-model inference. No qualified model inference was executed, so there is no honest qualified-model inference latency to report. Provider odds sourceAtMs is not supplied with trusted provenance; provider-to-receipt latency remains unknown with zero usable samples. HTTP Date is not used as an odds tick timestamp.</p>
<h3>Bootstrap receipt-to-commit totals (valid total boundaries only)</h3>
${table(["Interval","Snapshot UTC","Kind","n","p50 ms","p95 ms"],initialTotals)}
<p>These earlier total timestamps genuinely measured receipt to persisted evidence and remain retained. Their adaptive intermediate boundaries initially represented transaction setup, not final evaluation/write; those intermediate samples are excluded from current-version summaries and are not merged with the corrected definition. Small-sample p95 values are descriptive interpolated percentiles, not service guarantees.</p>

<h2>9. Decision-speed and opportunity movement</h2>
${table(["Interval","Exact round","Start → lean s","Lean → final s","Remaining at final s","Chosen-side p at first lean","p at eligibility","p at final","Reversals before lock","Min lean p","Max lean p","Movement since lean","Receipt → persisted lock ms"],speed)}
<p>Ranges and reversals are over actually recorded immutable LEANING events plus new observations, not a continuous/executable market-price history. Missing finals or unavailable timing samples stay unavailable. When there is a final choice, movement is projected onto that chosen side, so the first lean can have favored the opposite side. No historical choice is rewritten. Market movement since first lean is probability movement only: no dollar decay, executable payout, fees or profit claim.</p>

<h2>10. Missed-window and current collector evidence</h2>
${diagnostics.length?table(["Interval","Round","Checkpoint","Code","Diagnostic UTC","Reason"],diagnostics):'<p>No missing checkpoint diagnostics at this snapshot.</p>'}
<p>The initial five misses correspond to starting this optional research collector after its earlier checkpoints had passed. They cannot be legitimately backfilled. An old tick evaluated after the cutoff remains DATA_COLLECTOR_DELAY; READY evidence that fails to persist becomes DATA_COMMIT_DELAY. Timely fresh evidence that genuinely lacks the rule is WAITING_FOR_EVIDENCE.</p>
${table(["Interval","Collector status","Observation age ms","Last attempted read UTC","Last successful read UTC","Last background error"],
  collectors.map(c=>[`${c.intervalMinutes}m`,c.collector?.collectorStatus,c.collector?.lastObservationAgeMs,c.collector?.lastFetchAttemptAt,c.collector?.lastFetchSuccessAt,c.collector?.lastBackgroundError]))}
<p>Restarted workflow served requests and /health/live returned readOnly:true. Existing retrospective OBSERVED_ROUND_MISSING_FINAL, incompatible historical-round identity/boundary, and SHADOW_ARTIFACT_UNAVAILABLE warnings were observed and were not suppressed. These are unresolved evidence/availability conditions, not a clean-coverage certification. Production deployment logs were not treated as development test evidence.</p>

<h2>11. UI screenshots: desktop and mobile</h2>
<p>Actual development app screenshots, live API mode, no fixture. The 320px capture demonstrates stale input being withheld while an immutable official choice and historical shadow candidate stay separately labeled. The 375–430px captures show fresh building-lock progress before the permitted window. Captures are responsive browser emulation, not physical-phone or interaction testing. Panels that require expansion were checked through component/server-render tests, not by claiming the screenshot clicked them. All screenshots preceded the final backend-only timing-definition refinement; the UI code/layout was unchanged by that refinement.</p>
<figure><figcaption>${esc(imageRows[0].title)}</figcaption><img src="${imageRows[0].data}" alt="Desktop development readiness panel with immutable canonical choice and explicit stale data health"></figure>
<div class="phones">${imageRows.slice(1).map(im=>`<figure><figcaption>${esc(im.title)}</figcaption><img src="${im.data}" alt="${esc(im.title)} live development lock-readiness panel"></figure>`).join("")}</div>
<p>Primary-card indicators cover strength, stability, freshness and recent reversals, with preferred side/probability, observed duration, countdown, conditional earliest time, exact blocking reason, rail and explicit “Lock readiness is not win probability.” Matched comparisons, latency, movement and diagnostics remain expandable.</p>

<h2>12. Model qualification remains unchanged</h2>
${table(["Interval","Model status","Qualified champion","Qualified calibration","Current champion forecast"],
  models.map(m=>[`${m.intervalMinutes}m`,m.status,m.champion?m.champion.version??"Present":"None",m.qualifiedCalibration?"Yes":"No",m.currentForecast?"Present":"Unavailable"]))}
<p>Raw WaterX probabilities remain labeled WaterX Market Baseline. No model forecast was substituted, no qualification threshold lowered, no calibration invented and no champion promoted.</p>

<h2>13. Tests and complete regression</h2>
<ul>
<li><strong>25 deterministic/source-contract tests:</strong> exact windows/fallbacks, single-spike rejection, persistence, relaxing curves, weak/tied signals, reversal/gap resets and recovery, stale/failed/future input, oscillation/density, policy validation/restart replay, independent 15m persistence, unknown provider latency, conditional lock equation, bounded exact timers, speed/movement, exact matched scoring, priority queue separation, late evaluation diagnostics and production-disabled read-only report.</li>
<li><strong>Five UI tests:</strong> development/interval/exact-round gates, canonical/shadow separation, all requested components, current versus stale/expired server-render states, responsive and reduced-motion rules.</li>
<li><strong>One end-to-end disposable PostgreSQL integration test:</strong> idempotent migration, policy pinning, replay, positive candidate insertion, append-only restrictions, duplicate input, read-only/wrong-round/failed-source report, forged persistence/odds/future and missed checkpoint rejection, pre-settlement score rejection, actual-clock positive canonical and post-expiry scoring, matched Brier/timing, null verification rejection and append-only dispute withdrawal. The fixture waited for actual expiry; triggers were not bypassed and no synthetic evidence was inserted in the application database.</li>
</ul>
<pre>node --import tsx --test --test-concurrency=4 scripts/*.test.ts client/src/*.test.ts
Disposable loopback waterx_reference_test database explicitly enabled.
429 passed • 0 failed • 0 skipped
31 added tests relative to the prior 398-test baseline.
npm run check: PASS
npm run build: PASS (Vite web, server bundle, worker bundle)</pre>
<p>Fresh full regression was run after the final timing correction. The migration was explicitly tested in isolation and applied only through the development database target. Workflow restart and real API checks followed the app changes. Ordinary React development-console messages appeared; no browser runtime error was shown in the captures.</p>

<h2>14. Scope confirmation and acceptance limits</h2>
<ul><li>No publish action, production write/migration, external service reconfiguration or secret change was performed.</li>
<li>No execution, wallet control, trading or model/policy promotion was enabled.</li>
<li>The official 60s/180s fallbacks, immutable canonical choices and existing anti-lookahead/settlement safety remain in place.</li>
<li>The adaptive implementation and read-only UI/report are delivered. Predictive-quality and persistent-host continuity are not accepted from this small development cohort.</li></ul>
<details><summary>Frozen raw development evidence and screenshot provenance</summary><pre>${esc(JSON.stringify(provenance,null,2))}</pre></details>
</main></body></html>`;
fs.writeFileSync("reports/bluewater-lock-readiness-report.html",html);
fs.writeFileSync("reports/bluewater-lock-readiness-evidence.json",JSON.stringify(provenance,null,2));
console.log(JSON.stringify({file:"reports/bluewater-lock-readiness-report.html",bytes:Buffer.byteLength(html),
  generatedAt:generated,counts:reports.map(r=>r.counts),matched:reports.map(r=>r.comparison),latencyKinds:reports.map(r=>Object.keys(r.latency))},null,2));