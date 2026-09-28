import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, Route, Switch, useLocation } from "wouter";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, CircleHelp, Copy, Download, ExternalLink, FileDown, Menu, RefreshCw, X } from "lucide-react";

type Point={at:number;price:number|null;source?:string;sourceAt?:number|string|null;sourceAgeMs?:number|null;gap?:boolean;reason?:string;receivedAt?:string;serverEventAt?:string;serverSentAt?:string;sourceToServerLatencyMs?:number|null;clientReceivedAt?:number;eventId?:number};
type ChartRange="current-round"|"5m"|"15m";
type ChartResponse={windowMinutes:5|15;source:string;points:Point[]};
type AuditCheck={id:string;label:string;status:"PASS"|"BLOCKED"|"NOT_EVALUATED";observed:string;required:string;source:string;asOf:string|null;explanation:string};
type Live={serverTime?:string;status?:string;reason?:string;round:{id:string;expiryMs:number;startMs:number;referencePrice:number;mintPaused?:boolean}|null;indicative:{up:number;down:number;asOf:string;source:string}|null;comparison:{price:number;asOf:string;source:string}|null;oraclePrice:number|null;points:Point[];forecast?:{up:number;down:number;modelVersion:string;asOf:string}|null;advisor?:{bias:"UP BIAS"|"DOWN BIAS"|"BALANCED"|"WAITING FOR DATA";source:"Market-derived bias"|"Model-derived bias"|null;explanation:string;reliability:"Unrated"|"Limited"|"Moderate"|"Strong";tradeValue:"EDGE DETECTED"|"NO DEMONSTRATED EDGE"|"ECONOMICS UNAVAILABLE"|"TOO LATE";tradeReason:string};confidence?:{label:string;reasons:string[]};evidence?:{score:number;maxScore:number;label:string;meaning:string;checksPassed?:number;checksTotal?:number;factors:{label:string;passed:boolean;points:number}[]};decisionAudit?:{evaluatedAt:string;policy:{minRemainingSeconds:number;minCalibratedSamples:number;minNetEdge:number};checks:AuditCheck[];summary:string};decisionSupport?:{marketTilt:"UP"|"DOWN"|"BALANCED"|"UNAVAILABLE";indicativeUp:number|null;comparisonDistance:number|null;comparisonChange:number|null;comparisonWindowSeconds?:number;comparisonSampleCount?:number;caveat:string};recommendation:{action:"UP"|"DOWN"|"HOLD";reason:string};health?:Record<string,string>};
 type History={rows:{id:string;expiryMs:number;referencePrice:number|null;settlementPrice:number|null;outcome:string;firstSeenAt:string;lastSeenAt:string;quoteCount:number;quality:string}[];coverage?:{earliest?:string;latest?:string;observed:number;settled:number;eligible?:number;evaluated?:number;unresolved?:number;quoteSnapshots:number;legacyUnstamped?:number;missingHistory?:boolean;reason?:string;gaps?:{start:string;end:string;minutes:number}[]};page?:number;pageSize?:number;totalPages?:number;total?:number};
type Score={name:string;brier:number;logLoss:number;count:number};
type Model={status?:string;reason?:string;sampleCount?:number;eligible?:number;evaluated?:number;trainingRequirements?:{eligibleRounds?:number;minimumRounds?:number;elapsedHistoryHours?:number;minimumElapsedHours?:number;maximumGapHours?:number;maximumAllowedGapHours?:number;eligibleForShadow?:boolean};baselines?:Score[];retrospectiveBaselines?:Score[];champion?:{version:string;trainedThrough:string;calibratedAt:string;metrics?:{brier?:number;logLoss?:number;count?:number}}|null;challenger?:{version:string;trainedThrough:string;calibratedAt:string;metrics?:{brier?:number;logLoss?:number;count?:number}}|null;lastTrainingAt?:string;lastCalibrationAt?:string};
type Prediction={roundId:string;predictionAt:string;remainingSeconds:number;modelVersion?:string;indicativeUp?:number|null;calibratedUp?:number|null;forecast_up?:number|null;action?:string;reason?:string;outcome?:string|null;quality?:string;evaluated?:boolean};
type ModelWindows={train?:string;calibration?:string;test?:string};
type ShadowEvaluation={brier?:number;logLoss?:number;count?:number;window?:string;metrics?:{brier?:number;logLoss?:number;count?:number}};
type About={sources?:{name:string;url:string;role:string}[];limitations?:string[]};
type Settings={edgeThreshold:number;refreshSeconds:number};
type EconomicsSide={status:string;quantity:number|null;entryProbability:number|null;premium:number|null;fees:{trading:number|null;builder:number|null;penalty:number|null;inventoryImpact:number|null};feeIncentiveSubsidy:number|null;netTradingFee:number|null;allInCost:number|null;grossWinningPayout:number|null;winningNetBeforeNetworkCosts:number|null;losingNetBeforeNetworkCosts:number|null;breakEvenProbability:number|null;networkCostsIncluded:boolean};
type Economics={status:string;marketId:string;expiryMs:number;asOf:string;ageMs:number;sizing:{mode:string;requestedPayoutQuantity:number;totalSpendBudget:number|null;note:string};up:EconomicsSide|null;down:EconomicsSide|null;referencePrice:number|null;referenceAsOf:string|null;oracleSourceTimes:unknown;assumptions:unknown;reason:string|null};
type AccuracyMetrics={hitRate?:number|null;brier?:number|null;logLoss?:number|null;coverage?:number|null};
type AccuracyCandidate={matchedRoundCount?:number;metrics?:AccuracyMetrics|null;marketOnMatchedRounds?:AccuracyMetrics|null;unavailableReason?:string|null};
type AccuracyPeriod={evaluatedUniqueRounds?:number;rawMarket?:(AccuracyMetrics&{metrics?:AccuracyMetrics|null})|null;shadowChallenger?:AccuracyCandidate|null;promotedChampion?:AccuracyCandidate|null;calibratedMarketBaseline?:{available:boolean;unavailableReason?:string|null}|null;issuedActions?:{directionalCalls?:number;abstentions?:number;actionSource?:string|null}|null;excludedRoundCount?:number;exclusions?:unknown;lastIssuedAt?:string|null;lastScoredAt?:string|null;horizon?:string|{name:string;sameHorizonMatchedRounds?:boolean}|null;provenanceLimitations?:string[]};
type Accuracy={status:"OK"|"PARTIAL"|"INCOMPLETE_DATASET";asOf:string;scope:string;periods:{daily?:AccuracyPeriod|null;sevenDay?:AccuracyPeriod|null;lifetime?:AccuracyPeriod|null};unavailablePeriods?:Partial<Record<"daily"|"sevenDay"|"lifetime",string>>;limitations?:string[];timeline?:AccuracyTimeline|null};
type AccuracyTimelineEntry={startUtc:string;endUtc:string;evaluatedUniqueRounds:number;rawMarketBrier:number|null;rawMarketLogLoss:number|null;shadowBrier:number|null;shadowMatchedMarketBrier:number|null;directionalCalls:number;abstentions:number;excludedRoundCount:number};
type AccuracyTimeline={kind:"rolling_24h_utc";entries:(AccuracyTimelineEntry|null)[]|null;unavailableReason:string|null};
type Health={warning?:string;buildId?:string;buildIdentity?:string;build?:{id?:string;identity?:string;buildId?:string}|string;lastQuoteAt?:string;quoteAgeSeconds?:number;ingestionLagSeconds?:number;newestCapturedRoundId?:string;worker?:{lastTickAt?:string;lastErrorAt?:string;lastError?:string;status?:string;lagSeconds?:number;providerFailures?:number;lastRoundId?:string;lastSettlementAt?:string;lastEvaluationAt?:string};coverage?:{observed:number;settled:number;eligible:number;prospectiveEligible?:number;evaluated:number;observed24h?:number;observed7d?:number;unresolved:number;missingUnknown:number;quoteSnapshots:number;legacyUnstamped?:number;earliest?:string;latest?:string;gaps?:{start:string;end:string;minutes:number}[]};lastSettlementAt?:string;lastEvaluatedAt?:string};

async function get<T>(url:string):Promise<T>{const r=await fetch(url);if(!r.ok)throw new Error(`Request failed (${r.status})`);return r.json()}
function useApi<T>(url:string, interval?:number){const [data,setData]=useState<T|null>(null);const [error,setError]=useState("");const [loading,setLoading]=useState(true);const load=()=>{setLoading(true);setError("");get<T>(url).then(setData).catch(e=>setError(e instanceof Error?e.message:"Unable to load")).finally(()=>setLoading(false))};useEffect(()=>{load();if(interval){const t=setInterval(load,interval*1000);return()=>clearInterval(t)}},[url,interval]);return{data,error,loading,reload:load}}
const time=(v?:string|number)=>v?new Date(v).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit",timeZone:"UTC"}):"—";
const fullUtc=(v?:string|number)=>v?new Date(v).toLocaleString([],{year:"numeric",month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false,timeZone:"UTC"}):"Unavailable";
const age=(v?:string)=>{if(!v)return "unknown";const seconds=Math.max(0,Math.round((Date.now()-new Date(v).getTime())/1000));if(seconds<60)return `${seconds}s ago`;const minutes=Math.floor(seconds/60);if(minutes<60)return `${minutes}m ago`;const hours=Math.floor(minutes/60);if(hours<24)return `${hours}h ${minutes%60}m ago`;const days=Math.floor(hours/24);return `${days}d ${hours%24}h ago`};
const humanHours=(v?:number)=>{if(v==null||!Number.isFinite(v))return "—";const minutes=Math.max(0,Math.round(v*60)),days=Math.floor(minutes/1440),hours=Math.floor((minutes%1440)/60),remaining=minutes%60;return days?`${days}d ${hours}h`:hours?`${hours}h ${remaining}m`:`${remaining}m`};
const money=(v?:number|null)=>v==null?"Unavailable":v.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const dollars=(v?:number|null)=>v==null?"—":`$${money(v)}`;
const probability=(v:number)=>v<.01?"<1%":v>.99?">99%":`${Number.isInteger(v*100)?Math.round(v*100):(v*100).toFixed(1)}%`;
const completeEconomicSide=(side:EconomicsSide|null|undefined)=>!!side&&side.status==="AVAILABLE"&&[side.quantity,side.entryProbability,side.premium,side.allInCost,side.grossWinningPayout,side.breakEvenProbability].every(v=>typeof v==="number"&&Number.isFinite(v));
const plainEconomicsReason=(status:string,reason:string)=>/MOVE[_ -]?ABORT/i.test(`${status} ${reason}`)
  ?"MoveAbort means the quote moved or failed a consistency check while being read. No order was placed; the displayed price is withheld."
  :/STALE/i.test(status)
    ?"This quote is older than the freshness limit. Prices and costs are hidden rather than carried forward."
    :/REFRESH FAILED/i.test(status)
      ?"The quote refresh failed. Any retained quote may no longer describe this round, so its prices are hidden."
      :reason||"A complete, current quote for both sides is not available. No cost is inferred.";
function Shell({children}:{children:ReactNode}){const [path]=useLocation();const [open,setOpen]=useState(false);useEffect(()=>{let icon=document.querySelector<HTMLLinkElement>('link[rel="icon"]');if(!icon){icon=document.createElement("link");icon.rel="icon";document.head.appendChild(icon)}icon.href="/favicon.svg";icon.type="image/svg+xml"},[]);const links=[["/","Live"],["/history","History"],["/model","Model"],["/about","Data health"],["/settings","Settings"]];return <div className="shell"><header className="topbar"><Link href="/" className="brand" aria-label="BluewaterAI home"><img className="brand-mark" src="/favicon.svg" alt=""/><span>BluewaterAI <small>BTC · ONE-MINUTE</small></span></Link><img className="brand-mark-mono" src="/favicon-mono.svg" alt="" aria-hidden="true"/><button className="menu" aria-label={open?"Close navigation":"Open navigation"} onClick={()=>setOpen(!open)}>{open?<X/>:<Menu/>}</button><nav className={open?"nav open":"nav"}>{links.map(([href,label])=><Link key={href} href={href} className={path===href?"active":""} onClick={()=>setOpen(false)}>{label}</Link>)}</nav></header>{children}<footer className="footer"><span>READ-ONLY RESEARCH CONSOLE · MANUAL DECISIONS ONLY</span><span>UTC · no wallet · no execution</span></footer></div>}
function Load({error,reload}:{error?:string;reload?:()=>void}){return error?<div className="error"><strong>Data unavailable</strong><p>{error}. No estimate is being fabricated.</p>{reload&&<button className="button" onClick={reload}><RefreshCw size={13}/> Retry</button>}</div>:<div className="skeleton"/>}
function Badge({children,tone=""}:{children:ReactNode;tone?:string}){return <span className={`chip ${tone}`}>{children}</span>}
function EconomicsPanel({data,available,status,reason}:{data:Economics|null;available:boolean;status:string;reason:string}){
  const upReady=!!(available&&data&&completeEconomicSide(data.up)),downReady=!!(available&&data&&completeEconomicSide(data.down));
  const ready=!!(data?.status==="AVAILABLE"&&upReady&&downReady);
  const partial=!!(data?.status==="PARTIAL"&&(upReady||downReady));
  const availableSides:{label:"UP"|"DOWN";side:EconomicsSide}[]=[];
  if(data?.up&&upReady)availableSides.push({label:"UP",side:data.up});
  if(data?.down&&downReady)availableSides.push({label:"DOWN",side:data.down});
  const partialCaveat=availableSides.length===1
    ?`Only the ${availableSides[0].label} side is verified; opposite-side costs are unavailable, so no paired comparison, edge assessment, or action is available.`
    :"The response is marked partial; side estimates are shown independently, with no paired comparison, edge assessment, or action.";
  const json=(value:unknown)=>typeof value==="string"?value:JSON.stringify(value,null,2)||"Not reported";
  const feeRows=(label:string,side:EconomicsSide)=><div className="economics-fees"><h4>{label}</h4><dl><div><dt>Quantity</dt><dd>{side.quantity?.toLocaleString(undefined,{maximumFractionDigits:6})??"—"}</dd></div><div><dt>Entry probability</dt><dd>{side.entryProbability==null?"—":probability(side.entryProbability)}</dd></div><div><dt>Premium</dt><dd>{dollars(side.premium)}</dd></div><div><dt>Trading fee</dt><dd>{dollars(side.fees.trading)}</dd></div><div><dt>Builder fee</dt><dd>{dollars(side.fees.builder)}</dd></div><div><dt>Penalty</dt><dd>{dollars(side.fees.penalty)}</dd></div><div><dt>Inventory impact</dt><dd>{dollars(side.fees.inventoryImpact)}</dd></div><div><dt>Fee incentive subsidy</dt><dd>{dollars(side.feeIncentiveSubsidy)}</dd></div><div><dt>Net trading fee</dt><dd>{dollars(side.netTradingFee)}</dd></div></dl></div>;
  const sideCards=(sides:{label:"UP"|"DOWN";side:EconomicsSide}[],isPartial=false)=> <div className={`economics-sides ${isPartial?"partial":""}`}>{sides.map(({label,side})=><article className={`economics-side ${label.toLowerCase()}`} key={label}><div className="economics-side-title">{label}<span>BREAK-EVEN {probability(side.breakEvenProbability!)}</span></div><div className="economics-values"><div><span>All-in cost</span><strong>{dollars(side.allInCost)}</strong></div><div><span>Gross winning payout</span><strong>{dollars(side.grossWinningPayout)}</strong></div></div></article>)}</div>;
  const detailBlock=(sides:{label:"UP"|"DOWN";side:EconomicsSide}[])=>data?<details className="economics-details"><summary>{partial?"Available-side fees & quote sources":"Assumptions, fees & quote sources"}</summary><div className="economics-detail-content"><div className="economics-fee-grid">{sides.map(({label,side})=>feeRows(`${label} side`,side))}</div><dl className="economics-reference"><div><dt>Reference price</dt><dd>{money(data.referencePrice)}</dd></div><div><dt>Reference as of · UTC</dt><dd>{fullUtc(data.referenceAsOf||undefined)}</dd></div><div><dt>Quote as of · UTC</dt><dd>{fullUtc(data.asOf)}</dd></div><div><dt>Quote age</dt><dd>{(data.ageMs/1000).toFixed(1)}s</dd></div><div><dt>Spend budget</dt><dd>{data.sizing.totalSpendBudget==null?"Not specified":dollars(data.sizing.totalSpendBudget)}</dd></div></dl><p className="economics-detail-label">Sizing note</p><p className="economics-note">{data.sizing.note}</p><p className="economics-detail-label">Assumptions</p><pre>{json(data.assumptions)}</pre><p className="economics-detail-label">Oracle source times</p><pre>{json(data.oracleSourceTimes)}</pre></div></details>:null;
  return <section className={`economics-panel live-economics ${ready?"is-available":partial?"is-partial":"is-unavailable"}`} aria-label="Anonymous quote economics">
    <div className="economics-heading"><div><span className="eyebrow">Anonymous quote · estimated</span><h3>Round economics</h3></div><Badge tone={ready?"live":partial?"warn":["LOADING","STALE_QUOTE","TOO_LATE","EXPIRED","LIVE SNAPSHOT STALE","ROUND MISMATCH","NO ACTIVE ROUND"].includes(status)?"warn":"bad"}>{ready?"QUOTE AVAILABLE":partial?"PARTIAL · ONE-SIDED":status==="AVAILABLE"?"INCOMPLETE QUOTE":status.replace(/_/g," ")}</Badge></div>
    {ready&&data&&data.up&&data.down?<><p className="economics-sizing"><strong>{dollars(data.sizing.requestedPayoutQuantity)} payout quantity</strong><span>Not a spend budget · anonymous quote, not a guaranteed fill.</span></p>
      {sideCards(availableSides)}
      <p className="economics-caveat">{data.up.networkCostsIncluded&&data.down.networkCostsIncluded?"Network costs included.":"Network gas excluded."} Quote is an estimate; execution and fill are not guaranteed.</p>
      {detailBlock(availableSides)}
    </>:partial&&data?<><div className="economics-partial-note"><strong>PARTIAL · {availableSides.map(side=>side.label).join(" + ")} estimate only</strong><span>Quote as of {fullUtc(data.asOf)} UTC · age {(data.ageMs/1000).toFixed(1)}s.</span><p>{partialCaveat}</p></div>
      <p className="economics-sizing"><strong>{dollars(data.sizing.requestedPayoutQuantity)} payout target</strong><span>Estimated side cost, not a spend budget or guaranteed fill.</span></p>
      {sideCards(availableSides,true)}
      <p className="economics-caveat">{partialCaveat} This estimate is not a guaranteed fill.</p>
      {detailBlock(availableSides)}
    </>:<div className="economics-unavailable"><p>{plainEconomicsReason(status,reason||data?.reason||"")}</p><details className="economics-details"><summary>Why these prices are withheld</summary><div className="economics-detail-content"><p>{reason||data?.reason||`Quote status: ${status.replace(/_/g," ")}.`}</p><p>Both UP and DOWN prices must be current, match the active round, and include complete costs. This is an anonymous estimate only; it is not a guaranteed fill and no transaction is sent.</p></div></details></div>}
  </section>
}
function EconomicsMini({data,available,status}:{data:Economics|null;available:boolean;status:string}){
  const upReady=!!(available&&data&&completeEconomicSide(data.up)),downReady=!!(available&&data&&completeEconomicSide(data.down));
  const ready=!!(data?.status==="AVAILABLE"&&upReady&&downReady),partial=!!(data?.status==="PARTIAL"&&(upReady||downReady));
  const availableSides:{label:"UP"|"DOWN";side:EconomicsSide}[]=[];
  if(data?.up&&upReady)availableSides.push({label:"UP",side:data.up});
  if(data?.down&&downReady)availableSides.push({label:"DOWN",side:data.down});
  const partialNote=availableSides.length===1
    ?`As of ${fullUtc(data?.asOf)} UTC. Opposite-side costs unavailable; no comparison or action.`
    :`As of ${fullUtc(data?.asOf)} UTC. Partial response; independent sides are not compared.`;
  return <section className={`economics-mini ${ready?"is-available":partial?"is-partial":"is-unavailable"}`} aria-label="Compact anonymous quote economics">
    <div className="economics-mini-heading"><span>{ready&&data?`EST. COST · ${dollars(data.sizing.requestedPayoutQuantity)} PAYOUT TARGET`:partial?"PARTIAL · ONE-SIDED ESTIMATE":"ESTIMATED ROUND COSTS"}</span><Badge tone={ready?"live":"warn"}>{ready?"QUOTE LIVE":partial?"PARTIAL":status.replace(/_/g," ")}</Badge></div>
    {ready||partial?<><div className={`economics-mini-grid ${partial?"partial":""}`}>{availableSides.map(({label,side})=><div className={`economics-mini-side ${label.toLowerCase()}`} key={label}><strong>{label}{partial&&<small>VERIFIED SIDE</small>}</strong><span>Cost <b>{dollars(side.allInCost)}</b></span><small>Gross {dollars(side.grossWinningPayout)} · BE {probability(side.breakEvenProbability!)}</small></div>)}</div>{partial&&<p className="economics-mini-partial-note">{partialNote}</p>}</>:<p className="economics-mini-unavailable">Costs withheld · no current verified UP/DOWN quote.</p>}
  </section>
}
function Chart({round}:{round:Live["round"]}){
  const [range,setRange]=useState<ChartRange>("current-round");
  const [history,setHistory]=useState<ChartResponse|null>(null),[historyAt,setHistoryAt]=useState(0),[historyLoading,setHistoryLoading]=useState(true),[historyError,setHistoryError]=useState("");
  const [reloadHistory,setReloadHistory]=useState(0),[streamPoints,setStreamPoints]=useState<Point[]>([]),[streamState,setStreamState]=useState<"CONNECTING"|"LIVE"|"RECONNECTING">("CONNECTING");
  const [selectedAt,setSelectedAt]=useState<number|null>(null);
  const lastEventId=useRef(0),pendingEvents=useRef<Point[]>([]),flushFrame=useRef<number|null>(null);
  const svgRef=useRef<SVGSVGElement|null>(null),touchSelection=useRef(false);
  // The server contract is window=5|15; current-round is a client-side clip of its 5m history.
  const windowMinutes=range==="15m"?15:5;

  useEffect(()=>{
    const controller=new AbortController();
    setHistoryLoading(true);setHistoryError("");setHistory(null);setHistoryAt(0);
    fetch(`/api/chart?window=${windowMinutes}`,{signal:controller.signal})
      .then(async response=>{
        if(!response.ok)throw new Error(`Chart history request failed (${response.status})`);
        return response.json() as Promise<ChartResponse>;
      })
      .then(result=>{
        if(!Array.isArray(result.points))throw new Error("Chart response did not include a points array.");
        setHistory(result);setHistoryAt(Date.now());
      })
      .catch(error=>{if(error instanceof DOMException&&error.name==="AbortError")return;setHistoryError(error instanceof Error?error.message:"Chart history unavailable")})
      .finally(()=>{if(!controller.signal.aborted)setHistoryLoading(false)});
    return()=>controller.abort();
  },[windowMinutes,reloadHistory]);

  useEffect(()=>{
    let disposed=false,source:EventSource|null=null,retryTimer:ReturnType<typeof setTimeout>|undefined;
    let retryDelay=1_000;
    const flush=()=>{
      flushFrame.current=null;
      const batch=pendingEvents.current.splice(0);
      if(batch.length)setStreamPoints(previous=>[...previous,...batch].slice(-512));
    };
    const queue=(point:Point)=>{
      pendingEvents.current.push(point);
      if(pendingEvents.current.length>512)pendingEvents.current.shift();
      if(flushFrame.current===null)flushFrame.current=requestAnimationFrame(flush);
    };
    const connect=()=>{
      if(disposed)return;
      setStreamState("CONNECTING");
      source=new EventSource(`/api/chart/stream?after=${lastEventId.current}`);
      const current=source;
      current.onopen=()=>{if(!disposed)setStreamState("LIVE")};
      const receiveReset=()=>{
        if(disposed)return;
        if(retryTimer)clearTimeout(retryTimer);
        lastEventId.current=0;retryDelay=1_000;pendingEvents.current=[];
        if(flushFrame.current!==null){cancelAnimationFrame(flushFrame.current);flushFrame.current=null}
        setStreamPoints([]);setHistory(null);setHistoryAt(0);setHistoryError("");setHistoryLoading(true);setSelectedAt(null);
        setReloadHistory(value=>value+1);setStreamState("RECONNECTING");
        source=null;current.close();retryTimer=setTimeout(connect,0);
      };
      const receive=(event:Event)=>{
        const message=event as MessageEvent<string>,id=Number(message.lastEventId);
        if(Number.isSafeInteger(id)&&id>0&&id<=lastEventId.current)return;
        let body:Record<string,unknown>={};
        try{body=JSON.parse(message.data) as Record<string,unknown>}catch{}
        const at=typeof body.at==="number"&&Number.isFinite(body.at)?body.at:Date.now();
        const isGap=message.type==="gap"||body.gap===true||typeof body.price!=="number"||!Number.isFinite(body.price);
        const serverSentAt=typeof body.serverSentAt==="string"?body.serverSentAt:undefined;
        const point:Point=isGap
          ?{at,price:null,gap:true,reason:typeof body.reason==="string"?body.reason:"Comparison feed gap reported.",serverSentAt,clientReceivedAt:Date.now(),eventId:Number.isSafeInteger(id)?id:undefined}
          :{at,price:body.price as number,source:typeof body.source==="string"?body.source:undefined,sourceAt:typeof body.sourceAt==="string"?body.sourceAt:null,sourceAgeMs:typeof body.sourceAgeMs==="number"?body.sourceAgeMs:null,sourceToServerLatencyMs:typeof body.sourceToServerLatencyMs==="number"?body.sourceToServerLatencyMs:null,receivedAt:typeof body.receivedAt==="string"?body.receivedAt:undefined,serverEventAt:typeof body.serverEventAt==="string"?body.serverEventAt:undefined,serverSentAt,clientReceivedAt:Date.now(),eventId:Number.isSafeInteger(id)?id:undefined};
        if(Number.isSafeInteger(id)&&id>0)lastEventId.current=id;
        retryDelay=1_000;setStreamState("LIVE");queue(point);
        if(isGap&&/replay buffer exhausted/i.test(point.reason||""))setReloadHistory(value=>value+1);
      };
      current.addEventListener("tick",receive);
      current.addEventListener("gap",receive);
      current.addEventListener("reset",receiveReset);
      current.onerror=()=>{
        if(source!==current)return;
        current.close();
        source=null;
        if(disposed)return;
        setStreamState("RECONNECTING");
        retryTimer=setTimeout(connect,retryDelay);
        retryDelay=Math.min(30_000,retryDelay*2);
      };
    };
    connect();
    return()=>{
      disposed=true;
      if(retryTimer)clearTimeout(retryTimer);
      source?.close();
      if(flushFrame.current!==null)cancelAnimationFrame(flushFrame.current);
      flushFrame.current=null;pendingEvents.current=[];
    };
  },[]);

  const sourcePoints=useMemo(()=>{
    const byKey=new Map<string,Point>();
    for(const point of [...(history?.points||[]),...streamPoints]){
      if(!Number.isFinite(point.at))continue;
      byKey.set(`${point.at}:${point.gap||point.price==null?"gap":"tick"}`,point);
    }
    return Array.from(byKey.values()).sort((a,b)=>a.at-b.at).slice(-512);
  },[history,streamPoints]);
  const durationMs=windowMinutes*60_000;
  const latestAt=sourcePoints.at(-1)?.at||historyAt||Date.now();
  const domainStart=range==="current-round"?(round?.startMs??latestAt-60_000):Math.max(0,Math.max(historyAt,latestAt)-durationMs);
  const domainEnd=range==="current-round"?(round?.expiryMs??latestAt):Math.max(domainStart+1,Math.max(historyAt,latestAt));
  const visiblePoints=useMemo(()=>{
    if(range==="current-round"&&!round)return [];
    const inRange=sourcePoints.filter(point=>point.at>=domainStart&&point.at<=domainEnd);
    const withGaps:Point[]=[];
    for(const point of inRange){
      const previous=withGaps.at(-1);
      if(previous&&!previous.gap&&!point.gap&&previous.price!==null&&point.price!==null&&point.at-previous.at>15_000){
        withGaps.push({at:previous.at+(point.at-previous.at)/2,price:null,gap:true,reason:"No comparison sample for more than 15 seconds."});
      }
      withGaps.push(point);
    }
    return withGaps.slice(-512);
  },[sourcePoints,domainStart,domainEnd,range,round]);
  const valid=visiblePoints.filter((point):point is Point&{price:number}=>!point.gap&&typeof point.price==="number"&&Number.isFinite(point.price));
  const selected=valid.find(point=>point.at===selectedAt)||valid.at(-1);
  const prices=valid.map(point=>point.price).concat(round?.referencePrice!=null?[round.referencePrice]:[]);
  const rawLow=Math.min(...prices),rawHigh=Math.max(...prices),pricePadding=Math.max(.5,(rawHigh-rawLow)*.12);
  const bottom=prices.length?rawLow-pricePadding:0,top=prices.length?rawHigh+pricePadding:1;
  const plot={left:76,right:980,top:25,bottom:258},plotWidth=plot.right-plot.left,plotHeight=plot.bottom-plot.top;
  const x=(at:number)=>plot.left+((at-domainStart)/Math.max(1,domainEnd-domainStart))*plotWidth;
  const y=(price:number)=>plot.bottom-((price-bottom)/Math.max(.01,top-bottom))*plotHeight;
  const segments:Point[][]=[],gapPoints:Point[]=[];let current:Point[]=[];
  for(const point of visiblePoints){
    if(point.gap||point.price===null){if(current.length)segments.push(current);current=[];gapPoints.push(point)}
    else current.push(point);
  }
  if(current.length)segments.push(current);
  const pathFor=(segment:Point[])=>segment.map((point,index)=>`${index?"L":"M"} ${x(point.at)} ${y(point.price!)}`).join(" ");
  const markerX=(at:number)=>at>=domainStart&&at<=domainEnd?x(at):null;
  const startX=round?markerX(round.startMs):null,expiryX=round?markerX(round.expiryMs):null,referenceY=round?y(round.referencePrice):null;
  const axisTicks=[domainStart,domainStart+(domainEnd-domainStart)/2,domainEnd];
  const shortTime=(at:number)=>new Date(at).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit",timeZone:"UTC"});
  const latency=(value:number|null|undefined)=>typeof value==="number"&&Number.isFinite(value)?`${value.toFixed(0)} ms`:"Unavailable";
  const networkDelay=selected?.clientReceivedAt&&selected.serverSentAt?selected.clientReceivedAt-Date.parse(selected.serverSentAt):null;
  const chooseNearest=(clientX:number)=>{
    const bounds=svgRef.current?.getBoundingClientRect();
    if(!bounds||!valid.length)return;
    const value=(clientX-bounds.left)/Math.max(1,bounds.width),target=domainStart+value*(domainEnd-domainStart);
    const nearest=valid.reduce((best,point)=>Math.abs(point.at-target)<Math.abs(best.at-target)?point:best,valid[0]);
    setSelectedAt(nearest.at);
  };
  const moveByKey=(event:KeyboardEvent<SVGSVGElement>)=>{
    if(!valid.length)return;
    const foundIndex=valid.findIndex(point=>point.at===selectedAt);
    const currentIndex=selectedAt===null?valid.length-1:Math.max(0,foundIndex);
    let index=currentIndex;
    if(event.key==="ArrowRight")index=Math.min(valid.length-1,currentIndex+1);
    else if(event.key==="ArrowLeft")index=Math.max(0,currentIndex-1);
    else if(event.key==="Home")index=0;
    else if(event.key==="End")index=valid.length-1;
    else if(event.key==="Escape"){setSelectedAt(null);touchSelection.current=false;return}
    else return;
    event.preventDefault();setSelectedAt(valid[index].at);
  };
  const seriesLabel=range==="current-round"?"Current round":`${windowMinutes}-minute history`;
  const source=history?.source||"Coinbase comparison only; not settlement oracle";
  return <div className="chart-box interactive-chart">
    <div className="chart-tools">
      <div className="chart-ranges" role="group" aria-label="Chart time range">{([
        ["current-round","Current round"],["5m","5 min"],["15m","15 min"],
      ] as const).map(([value,label])=><button key={value} type="button" className={range===value?"selected":""} aria-pressed={range===value} onClick={()=>{setRange(value);setSelectedAt(null);touchSelection.current=false}}>{label}</button>)}</div>
      <span className={`chart-stream-status ${streamState.toLowerCase()}`} role="status"><i/>{streamState}</span>
    </div>
    {historyError&&<div className="chart-history-error" role="alert"><span>History reload failed: {historyError}{streamPoints.length?" Showing only ticks received on this connection.":""}</span><button type="button" onClick={()=>setReloadHistory(value=>value+1)}>Retry</button></div>}
    {range==="current-round"&&!round?<div className="chart-empty">No active round is reported. Select a fixed history window to inspect comparison samples.</div>:
    historyLoading&&!history?<div className="skeleton chart-loading"/>:
    !valid.length&&!gapPoints.length?<div className="chart-empty">{historyError?"No chart data is available until history or a live tick arrives.":"No comparison ticks are available in this interval. No prices are fabricated."}</div>:
    <>
      <svg ref={svgRef} className="chart interactive-chart-svg" viewBox="0 0 1000 320" preserveAspectRatio="none" role="application" tabIndex={0}
        aria-label={`${seriesLabel}, Coinbase comparison ticks only; not the settlement oracle. Focus chart and use left or right arrows to inspect actual ticks.`}
        aria-describedby="chart-selected-readout" aria-keyshortcuts="ArrowLeft ArrowRight Home End Escape" onKeyDown={moveByKey}
        onPointerMove={event=>{if(event.pointerType!=="touch")chooseNearest(event.clientX)}}
        onPointerDown={event=>{if(event.pointerType==="touch")touchSelection.current=true;chooseNearest(event.clientX)}}
        onPointerLeave={()=>{if(!touchSelection.current)setSelectedAt(null)}} onPointerCancel={()=>{touchSelection.current=false;setSelectedAt(null)}}>
        {prices.length>0&&[0,.5,1].map(fraction=>{const price=bottom+(top-bottom)*fraction,py=y(price);return <g key={fraction}><line x1={plot.left} y1={py} x2={plot.right} y2={py} className="chart-grid-line"/><text x={plot.left-8} y={py+4} textAnchor="end" className="chart-axis-label">{money(price)}</text></g>})}
        {axisTicks.map((at,index)=><g key={index}><line x1={x(at)} y1={plot.top} x2={x(at)} y2={plot.bottom} className="chart-grid-line chart-grid-vertical"/><text x={x(at)} y="279" textAnchor={index===0?"start":index===2?"end":"middle"} className="chart-axis-label">{shortTime(at)} UTC</text></g>)}
        {startX!==null&&<g><line x1={startX} y1={plot.top} x2={startX} y2={plot.bottom} className="chart-round-start"/><text x={Math.min(plot.right-4,startX+5)} y="14" className="chart-marker-label start">ROUND START</text></g>}
        {expiryX!==null&&<g><line x1={expiryX} y1={plot.top} x2={expiryX} y2={plot.bottom} className="chart-round-expiry"/><text x={Math.max(plot.left+4,expiryX-5)} y="14" textAnchor={expiryX>plot.right-90?"end":"start"} className="chart-marker-label expiry">ROUND EXPIRY</text></g>}
        {referenceY!==null&&<g><line x1={plot.left} y1={referenceY} x2={plot.right} y2={referenceY} className="chart-reference-line"/><text x={plot.right-4} y={Math.max(plot.top+12,referenceY-5)} textAnchor="end" className="chart-marker-label reference">REF {money(round!.referencePrice)}</text></g>}
        {gapPoints.map((point,index)=><g key={`gap-${point.at}-${index}`}><line x1={x(point.at)} y1={plot.top} x2={x(point.at)} y2={plot.bottom} className="chart-gap-mark"/><title>{point.reason||"Explicit comparison feed gap"}</title></g>)}
        {segments.map((segment,index)=><g key={`segment-${index}`}><path d={pathFor(segment)} className="chart-price-line"/>{segment.map(point=><circle key={`${point.at}`} cx={x(point.at)} cy={y(point.price!)} r="2.1" className="chart-price-dot"/>)}</g>)}
        {selected&&<g className="chart-crosshair" pointerEvents="none"><line x1={x(selected.at)} y1={plot.top} x2={x(selected.at)} y2={plot.bottom} className="chart-crosshair-line"/><circle cx={x(selected.at)} cy={y(selected.price)} r="5" className="chart-crosshair-point"/></g>}
      </svg>
      <div className="chart-ticks"><span>{seriesLabel} · {source}</span><span>{valid.length} observed tick{valid.length===1?"":"s"} · {gapPoints.length} gap{gapPoints.length===1?"":"s"}</span></div>
      <p className="chart-scope">{range==="current-round"?"Current round only; no points outside the reported start/expiry are shown.":`Rolling ${windowMinutes}-minute window; source timestamps are preserved.`} Coinbase is comparison data, not settlement evidence.</p>
      <div className="chart-legend"><span><i className="line-blue"/> Coinbase observed ticks</span>{round&&<><span><i className="line-dash"/> Round reference</span><span><i className="line-expiry"/> Contract start / expiry</span></>}{gapPoints.length>0&&<span><i className="line-gap"/> Gaps · no connecting line</span>}</div>
      <div className="chart-interaction-readout" id="chart-selected-readout" aria-live="polite">
        {selected?<><strong>{money(selected.price)} · {fullUtc(selected.at)} UTC</strong><span>Provider → server: {latency(selected.sourceToServerLatencyMs)}</span><span>Browser received − server sent: {latency(networkDelay)} <small>clock skew affects this estimate</small></span></>:<span>Focus the plot and use ← / → to inspect actual ticks; touch or move a pointer to select.</span>}
      </div>
      <details className="chart-provenance"><summary>Source times, transport delay &amp; explicit gaps</summary>
        <div className="chart-provenance-content"><p>Source: {source}</p><p>Provider observation: {selected?.sourceAt?fullUtc(selected.sourceAt):"Not reported"}</p><p>Provider → server delay: {latency(selected?.sourceToServerLatencyMs)}</p><p>Server received sample: {selected?.receivedAt?fullUtc(selected.receivedAt):"Unavailable"}</p><p>Server sent SSE event: {selected?.serverSentAt?fullUtc(selected.serverSentAt):"Historical HTTP point; send time not reported"}</p><p>Browser received − server sent: {latency(networkDelay)} · wall-clock skew can make this estimate inaccurate.</p>
          {!!gapPoints.length&&<ul className="chart-gap-list">{gapPoints.map((point,index)=><li key={`${point.at}-${index}`}>{fullUtc(point.at)} UTC · {point.reason||"Comparison feed gap; no line drawn."}</li>)}</ul>}
        </div>
      </details>
    </>}
    {historyLoading&&history&&<span className="chart-refreshing" role="status">Refreshing archive…</span>}
  </div>;
}
function pointFeedState(points:Point[],now:number){
  const ordered=points.filter(p=>Number.isFinite(p.at)).sort((a,b)=>a.at-b.at),tail=ordered.at(-1);
  const lastPrice=[...ordered].reverse().find(p=>!p.gap&&typeof p.price==="number"&&Number.isFinite(p.price));
  if(!lastPrice)return {label:"AWAITING DATA",tone:"awaiting" as const};
  if(tail?.gap||tail?.price==null)return {label:"FEED PAUSED · GAP",tone:"paused" as const};
  const timestampMs=lastPrice.sourceAt==null?NaN:typeof lastPrice.sourceAt==="number"?lastPrice.sourceAt:Date.parse(lastPrice.sourceAt);
  const timestampAge=Number.isFinite(timestampMs)?Math.max(0,now-timestampMs):null;
  if(lastPrice.sourceAgeMs==null&&timestampAge==null)return {label:"AGE UNVERIFIED",tone:"stale" as const};
  const staleMs=Math.max(lastPrice.sourceAgeMs??0,timestampAge??0);
  if(staleMs>30_000)return {label:`STALE · ${Math.floor(staleMs/1000)}s`,tone:"stale" as const};
  return {label:`LIVE TRACE · ${(staleMs/1000).toFixed(1)}s`,tone:"fresh" as const};
}
function LivePage(){
  const [cadence,setCadence]=useState(Number(localStorage.getItem("signal-refresh-seconds")||"5"));
  const [mode,setMode]=useState<"simple"|"research">("simple");
  const q=useApi<Live>("/api/live",cadence);
  const economicsQ=useApi<Economics>("/api/economics",5);
  const [now,setNow]=useState(Date.now());
  const lastRoundId=useRef<string|null>(null);
  const [roundChanged,setRoundChanged]=useState(false);
  useEffect(()=>{const i=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(i)},[]);
  useEffect(()=>{const fn=()=>setCadence(Number(localStorage.getItem("signal-refresh-seconds")||"5"));addEventListener("storage",fn);return()=>removeEventListener("storage",fn)},[]);
  useEffect(()=>{const id=q.data?.round?.id;if(id){if(lastRoundId.current&&lastRoundId.current!==id)setRoundChanged(true);lastRoundId.current=id}},[q.data?.round?.id]);
  if(q.loading&&!q.data)return <main className="page"><Load/></main>;
  if(!q.data)return <main className="page"><Load error={q.error} reload={q.reload}/></main>;
  const d=q.data,serverTimeMs=d.serverTime?Date.parse(d.serverTime):NaN,serverSnapshotStale=d.status==="STALE"||!Number.isFinite(serverTimeMs)||now-serverTimeMs>14_000,expired=(!!d.round&&d.round.expiryMs<=now)||/EXPIRED/i.test(d.status||""),remaining=d.round?Math.max(0,d.round.expiryMs-now):0,disconnected=!!q.error||/DISCONNECT|OFFLINE/i.test(d.status||""),staleSnapshot=disconnected||serverSnapshotStale,minimumRemainingSeconds=d.decisionAudit?.policy?.minRemainingSeconds,timeGate=!!d.round&&!expired&&minimumRemainingSeconds!=null&&remaining<=minimumRemainingSeconds*1000&&!staleSnapshot,settling=/SETTL|RESOLV/i.test(d.status||""),liveContext=!expired&&!settling&&!staleSnapshot&&!timeGate&&d.status==="LIVE"&&!!d.round,safeSupport=liveContext?d.decisionSupport:undefined,safeReference=liveContext?d.round?.referencePrice:undefined,action=liveContext?d.recommendation?.action||"HOLD":"HOLD",delta=liveContext&&d.comparison&&d.round?d.comparison.price-d.round.referencePrice:null,evidence=d.evidence,audit=d.decisionAudit,checks=audit?.checks||[],blocked=checks.filter(c=>c.status==="BLOCKED"),holdReason=expired?"This round has expired. Waiting for verified settlement and a new eligible round.":settling?"Settlement is in progress; no forecast or direction is carried into the next round.":disconnected?"Live feed disconnected. Retained snapshot is not eligible for a current decision.":serverSnapshotStale?"Snapshot is stale; wait for a fresh market read before treating this round as eligible.":timeGate?`Too little time remains: current policy requires more than ${minimumRemainingSeconds} seconds.`:!d.round?"No active round is reported; HOLD until a new round is verified.":d.recommendation?.reason||"No verified decision basis is available; hold.",factorTotal=evidence?.factors.reduce((sum,f)=>sum+(f.passed?f.points:0),0),roundState=disconnected?"DISCONNECTED":expired?"EXPIRED":settling?"SETTLING":serverSnapshotStale?"STALE":timeGate?"INELIGIBLE":roundChanged?"ROUND CHANGED":liveContext?"FRESH · ACTIVE":d.round?"NOT ELIGIBLE":"NO ACTIVE ROUND",checkedAt=audit?.evaluatedAt||d.serverTime,isHistoricalAudit=expired||settling||staleSnapshot,evidenceHeadline=evidence?.checksPassed!=null&&evidence.checksTotal!=null?`${evidence.checksPassed}/${evidence.checksTotal} input checks`:null,comparisonWindow=d.decisionSupport?.comparisonWindowSeconds,comparisonSamples=d.decisionSupport?.comparisonSampleCount;
  const feedState=pointFeedState(d.points||[],now);
  const marketContext=!expired&&!settling&&!staleSnapshot&&d.status==="LIVE"&&!!d.round;
     const economics=economicsQ.data,economicsAsOfMs=economics?.asOf?Date.parse(economics.asOf):NaN,economicsBrowserAge=Number.isFinite(economicsAsOfMs)?now-economicsAsOfMs:Infinity,economicsRoundMatches=!!(economics&&d.round&&economics.marketId===d.round.id&&economics.expiryMs===d.round.expiryMs),economicsFresh=!!(economics&&economicsBrowserAge>=-1_000&&economicsBrowserAge<15_000&&Number.isFinite(economics.ageMs)&&economics.ageMs>=0&&economics.ageMs<15_000),economicsServerFresh=!!(d.status==="LIVE"&&d.round&&!expired&&!settling&&!disconnected&&!q.error&&!serverSnapshotStale&&Number.isFinite(serverTimeMs)&&now-serverTimeMs>=-1_000&&now-serverTimeMs<15_000),economicsUpAvailable=completeEconomicSide(economics?.up),economicsDownAvailable=completeEconomicSide(economics?.down),economicsBothSidesAvailable=economicsUpAvailable&&economicsDownAvailable,economicsPartialHasSide=economicsUpAvailable||economicsDownAvailable,economicsStatusUsable=economics?.status==="AVAILABLE"?economicsBothSidesAvailable:economics?.status==="PARTIAL"&&economicsPartialHasSide,showEconomics=!!(economics&&economicsStatusUsable&&economicsRoundMatches&&economicsFresh&&economicsServerFresh&&remaining>=18_000&&!economicsQ.error);
   const economicsStatus=economicsQ.error?"REFRESH FAILED":!economics?"LOADING":!d.round?"NO ACTIVE ROUND":expired?"EXPIRED":settling?"SETTLING":!economicsServerFresh?"LIVE SNAPSHOT STALE":remaining<18_000?"TOO LATE":!economicsRoundMatches?"ROUND MISMATCH":!economicsFresh?"STALE QUOTE":economics.status==="PARTIAL"?economics.status:economics.status!=="AVAILABLE"?economics.status:!economicsBothSidesAvailable?"QUOTE INCOMPLETE":"AVAILABLE";
   const economicsReason=economicsQ.error?`Economics refresh failed: ${economicsQ.error}. Retained quotes are hidden.`:!economics?economicsQ.loading?"Requesting current anonymous quote…":"No quote response is available.":!d.round?"No active round is reported.":expired?"The active round expired; previous quote costs are hidden.":settling?"Settlement is in progress; no quote is carried forward.":!economicsServerFresh?"Live market snapshot is stale or disconnected; quote costs are hidden.":remaining<18_000?"Less than 18 seconds remain; quote costs are hidden.":!economicsRoundMatches?"Quote round ID or expiry does not match the live round.":!economicsFresh?"Quote is older than 15 seconds or its timestamp is invalid.":economics.status==="PARTIAL"&&economicsPartialHasSide?"Only a verified side is available; the opposite-side comparison is withheld.":economics.status!=="AVAILABLE"?economics.reason||`Quote unavailable (${economics.status.replace(/_/g," ").toLowerCase()}).`:!economicsBothSidesAvailable?"A verified UP and DOWN quote with complete costs is not available.":"";
  const forecastTime=d.forecast?Date.parse(d.forecast.asOf):NaN,forecastCurrent=!!(marketContext&&d.round&&d.forecast&&Number.isFinite(forecastTime)&&forecastTime>=d.round.startMs&&forecastTime<=serverTimeMs&&serverTimeMs-forecastTime<=14_000&&Number.isFinite(d.forecast.up)&&Number.isFinite(d.forecast.down)&&d.forecast.up>=0&&d.forecast.up<=1&&d.forecast.down>=0&&d.forecast.down<=1),forecast=forecastCurrent?d.forecast:null;
  const appReadCompletedAt=d.indicative?Date.parse(d.indicative.asOf):NaN,indicativeCurrent=!!(marketContext&&d.round&&d.indicative&&Number.isFinite(appReadCompletedAt)&&appReadCompletedAt>=d.round.startMs&&appReadCompletedAt<=serverTimeMs+1_000&&serverTimeMs-appReadCompletedAt<=14_000&&Number.isFinite(d.indicative.up)&&Number.isFinite(d.indicative.down)&&d.indicative.up>=0&&d.indicative.up<=1&&d.indicative.down>=0&&d.indicative.down<=1&&Math.abs(d.indicative.up+d.indicative.down-1)<=.03),marketProbability=indicativeCurrent?d.indicative:null;
  const probabilitySource=forecast?"Model forecast":marketProbability?"DeepBook market probability":"Waiting for fresh probabilities";
  const probabilityUnavailableReason=expired?"Round expired; waiting for the next verified round.":settling?"Round is settling; its probabilities are not carried forward.":staleSnapshot?"Live snapshot is stale or disconnected.":!d.round?"No active round is reported.":d.indicative?"DeepBook probability is stale, mismatched, or invalid.":"No DeepBook market probability was reported.";
  const edgePercent=audit?`${(audit.policy.minNetEdge*100).toFixed(1)}%`:null;
  return <main className={`page live-page ${mode}-mode`}>
     <div className="page-head"><div><p className="eyebrow">Manual research console</p><h1>Live round</h1><p className="subtle">Read-only evidence. You make the decision.</p></div><div className="statusbar"><div className="mode-toggle" aria-label="Presentation mode"><button className={mode==="simple"?"selected":""} onClick={()=>setMode("simple")}>Simple</button><button className={mode==="research"?"selected":""} onClick={()=>setMode("research")}>Research</button></div><Badge tone={expired||disconnected?"bad":liveContext?"live":"warn"}>{roundState}</Badge><span className="snapshot-age-inline" aria-label={`Snapshot age ${age(d.serverTime)}`}>SNAPSHOT {age(d.serverTime)}</span></div></div>
     {q.error&&<div className="notice refresh-notice"><AlertTriangle size={15}/><span>Refresh failed: {q.error}<b className="snapshot-age">Retained snapshot age: {age(d.serverTime)}.</b> Its reported timestamps are unchanged.<button className="text-button" onClick={q.reload}>Retry</button></span></div>}
    {serverSnapshotStale&&!q.error&&<div className="notice refresh-notice"><AlertTriangle size={15}/><span>API snapshot is older than 14 seconds. Treat displayed market and audit values as historical until refreshed.<button className="text-button" onClick={q.reload}>Retry</button></span></div>}
     {timeGate&&mode==="research"&&<div className="notice refresh-notice"><AlertTriangle size={15}/><span>Time gate: {minimumRemainingSeconds} seconds or less remain; current policy requires more than {minimumRemainingSeconds} seconds.</span></div>}
     {d.reason&&mode==="research"&&<div className="notice"><AlertTriangle size={15}/><span>{d.reason}</span></div>}
        <section className="hero-card"><div className="market-head"><div className="pair"><span className="coin" aria-hidden="true">BTC</span><span>BTC · 1-minute round<small>Manual market view</small></span></div><div className="settles"><span>{expired?"ROUND ENDED":"ROUND COUNTDOWN"}</span><strong>{d.round&&!expired?`${Math.floor(remaining/1000)}s`:"—"}</strong></div></div><div className="price-row"><strong className="price">{money(d.comparison?.price)}</strong><span className="price-label">COINBASE · BTC/USD</span>{delta!==null&&<span className={`change ${delta>=0?"positive":"negative"}`}>{delta>=0?"+":""}{delta.toFixed(2)}</span>}</div><details className="market-provenance"><summary>Round reference, ID &amp; source timestamps</summary><div className="hero-meta"><span>Reference · round source<b>{money(d.round?.referencePrice)}</b></span><span>Settlement oracle<b>{money(d.oraclePrice)}</b></span><span>Coinbase captured · UTC<b>{fullUtc(d.comparison?.asOf)}</b></span><span>Round expiry · UTC<b>{fullUtc(d.round?.expiryMs)}</b></span><span>Round ID<b>{d.round?.id||"Unavailable"}</b></span></div></details></section>
       <section className="chart-section live-chart" aria-label="Live comparison price chart"><div className="chart-heading"><div><p className="eyebrow">BTC · LIVE PRICE TRACE</p><h2>Comparison price</h2></div><span className={`chart-live ${feedState.tone}`}><i/> {feedState.label}</span></div><Chart round={d.round}/></section>
     <section className="forecast-panel live-decision" aria-label="Current decision and forecast">
         <div className="probability-heading"><div><p className="eyebrow">{probabilitySource}</p><h2>Round probabilities</h2></div><span>{forecast?`Model ${forecast.modelVersion} · ${fullUtc(forecast.asOf)} UTC`:marketProbability?`APP READ COMPLETED · ${time(marketProbability.asOf)} UTC`:"No current source timestamp"}</span></div>
         <div className={`forecast-grid ${forecast||marketProbability?"":"forecast-grid-empty"}`} aria-label={forecast?"Validated model forecast":marketProbability?"DeepBook market probability":"Waiting for fresh probabilities"}>
           <div className="forecast up"><span>UP</span><strong>{forecast?probability(forecast.up):marketProbability?probability(marketProbability.up):"—"}</strong></div>
           <div className="forecast down"><span>DOWN</span><strong>{forecast?probability(forecast.down):marketProbability?probability(marketProbability.down):"—"}</strong></div>
        </div>
         {!forecast&&!marketProbability&&<div className="forecast-empty-caption" role="status"><strong>Waiting for fresh probabilities</strong><span>{probabilityUnavailableReason}</span></div>}
            {marketProbability&&!forecast&&<details className="probability-provenance"><summary>Probability source details</summary><p className="market-read-time">{marketProbability.source} · app read completed {fullUtc(marketProbability.asOf)} UTC · provider observation timestamp not reported · market odds only; no independently validated model.</p></details>}
            {(() => {
              const reportedBias=marketContext&&safeSupport?.marketTilt!=="UNAVAILABLE"?safeSupport?.marketTilt:null;
              const waitReason=action==="HOLD"?(d.recommendation?.reason||d.advisor?.tradeReason||holdReason):null;
              const biasLabel=reportedBias||"UNAVAILABLE";
              const healthLabel=staleSnapshot?"STALE SNAPSHOT":feedState.label;
              return <div className={`advisor-block ${reportedBias==="UP"?"up":reportedBias==="DOWN"?"down":""} ${action==="HOLD"?"advisor-waiting":""}`}>
                <div className="advisor-readouts">
                  <div className="advisor-bias"><span>Market-derived bias</span><strong>{biasLabel}</strong><small>Market context only · not a call</small></div>
                  <div className="advisor-reliability"><span>Reliability</span><strong>{marketContext&&d.advisor?d.advisor.reliability:"Unrated"}</strong><small>{d.advisor?.source==="Model-derived bias"?`Model view: ${d.advisor.bias}`:"Qualification, not direction"}</small></div>
                  <div className="advisor-health"><span>Data health</span><strong>{healthLabel}</strong><small>{staleSnapshot?"Current decision context withheld":feedState.tone==="fresh"?"Comparison feed timestamped":"Feed condition is separate from bias"}</small></div>
                </div>
                <div className="advisor-outcome"><span>ADVISORY</span><strong>{action==="HOLD"?"WAIT":action}</strong></div>
                {waitReason&&<p className="advisor-wait-reason"><b>Why WAIT</b>{waitReason}</p>}
                {action!=="HOLD"&&d.advisor?.explanation&&<p className="advisor-explanation">{d.advisor.explanation}</p>}
              </div>;
            })()}
           <EconomicsMini data={economicsQ.data} available={showEconomics} status={economicsStatus}/>
      </section>
      <EconomicsPanel data={economicsQ.data} available={showEconomics} status={economicsStatus} reason={economicsReason}/>
     <details className="why-signal"><summary><span><i className="why-rule"/>Comparison, model and audit details</span><span className="why-hint">SECONDARY PROVENANCE</span></summary><div className="why-content">
    <section className="evidence-panel"><div className="evidence-summary"><div><p className="eyebrow">Evidence completeness</p><strong>{evidenceHeadline||"Weighted score"}</strong><span>{evidence?`${evidence.score} / ${evidence.maxScore} policy-weighted availability`:"Unavailable"}</span></div><p>{evidence?.meaning||"Evidence completeness describes reported inputs only. It is not a measure of predictive confidence."}<br/><b className="not-predictive">Not predictive confidence.</b></p></div><div className="factor-list evidence-factors"><div className="factor-arithmetic"><span>WEIGHTED SUM</span><b>{factorTotal==null?"Unavailable":`${factorTotal} points from passed factors · score ${evidence?.score??"Unavailable"} / ${evidence?.maxScore??"Unavailable"}`}</b></div>{evidence?.factors?.length?evidence.factors.map((f,i)=><div key={`${f.label}-${i}`}><span className={f.passed?"pass":"fail"}>{f.passed?"PASS":"NOT MET"}</span><span>{f.label}</span><b>{f.passed?`${f.points>0?"+":""}${f.points}`:`0 / ${f.points}`}</b></div>):<p className="empty-factors">Factor detail unavailable from this response.</p>}</div></section>
    <section className={`decision-audit panel ${isHistoricalAudit?"historical-audit":""}`}><div className="section-title"><div><p className="eyebrow">Decision provenance</p><h2>Policy checks</h2></div><Badge>{isHistoricalAudit?"HISTORICAL SNAPSHOT":checks.length?`${checks.length} CHECKS`:"NOT REPORTED"}</Badge></div>{isHistoricalAudit&&<p className="audit-caveat historical-label">Historical decision snapshot · its prior gate statuses are not current PASS results.{q.error?" Refresh failed; the retained audit may be stale.":" The round has expired."}</p>}<p className="subtle audit-caveat">Each result reflects the API decision audit at its reported time. Source timestamps may be stale or expired; review their age.</p>{audit?<><div className="policy-row"><span>Minimum remaining <b>{audit.policy.minRemainingSeconds}s</b></span><span>Minimum calibrated samples <b>{audit.policy.minCalibratedSamples}</b></span><span>Minimum net edge <b>{edgePercent}</b></span></div><p className="audit-checked">Evaluated at {fullUtc(audit.evaluatedAt)} · UTC</p>{checks.length?<div className="gate-list">{checks.map((c,i)=><article className={`gate-item ${c.status.toLowerCase()}`} key={`${c.id}-${i}`}><div className="gate-title"><strong>{c.label}</strong><Badge tone={c.status==="PASS"?"live":c.status==="BLOCKED"?"bad":"warn"}>{isHistoricalAudit?"Historical · ":""}{c.status.replace("_"," ")}</Badge></div><p>{c.explanation}</p><dl><div><dt>Observed</dt><dd>{c.observed||"Not reported"}</dd></div><div><dt>Required</dt><dd>{c.required||"Not reported"}</dd></div><div><dt>Source</dt><dd>{c.source||"Not reported"}</dd></div><div><dt>As of · UTC</dt><dd>{fullUtc(c.asOf||undefined)}</dd></div></dl></article>)}</div>:<div className="audit-empty">The API reported no individual gate checks.</div>}</>:<div className="audit-empty">Decision audit is not yet available in this API response. No gate results are inferred by the client.</div>}<p className="audit-caveat"><b>Freshness caveat:</b> this screen is read-only. A round can expire between refreshes; if expired, stale, or a source time is old, do not treat these checks as current authorization.</p></section>
     <section className="decision-strip"><div><span>BOARD TILT · MARKET OBSERVATION ONLY</span><strong className={(safeSupport?.marketTilt||"UNAVAILABLE").toLowerCase()}>{safeSupport?.marketTilt||"UNAVAILABLE"}</strong></div><div className="decision-metrics"><span>Indicative board UP <b>{safeSupport?.indicativeUp==null?"Unavailable":`${Math.round(safeSupport.indicativeUp*100)}%`}</b></span><span>Comparison change{comparisonWindow==null?"":` · observed ${comparisonWindow}s`}{comparisonSamples==null?"":` · n=${comparisonSamples}`} <b>{safeSupport?.comparisonChange==null?"Unavailable":`${safeSupport.comparisonChange>=0?"+":"−"}$${Math.abs(safeSupport.comparisonChange).toFixed(2)}`}</b></span></div><p>Non-actionable market context, not a recommendation or calibrated probability. {safeSupport?.caveat||"Unavailable unless reported by the API."}</p></section><div className="live-foot"><span>Round state: {roundState}</span><span>Predictive confidence: {liveContext&&d.confidence?.label||"unavailable"}</span></div></div></details>
  </main>;
}
function HistoryPage(){const [page,setPage]=useState(1),[search,setSearch]=useState("");const q=useApi<History>(`/api/history?page=${page}&pageSize=20`);if(q.loading&&!q.data)return <main className="page"><Load/></main>;if(!q.data)return <main className="page"><Load error={q.error} reload={q.reload}/></main>;const c=q.data.coverage||{observed:0,settled:0,quoteSnapshots:0};const rows=q.data.rows.filter(r=>r.id.toLowerCase().includes(search.toLowerCase())||r.outcome.toLowerCase().includes(search.toLowerCase()));const copy=(id:string)=>navigator.clipboard?.writeText(id);return <main className="page"><div className="page-head"><div><p className="eyebrow">Observed round archive</p><h1>History</h1><p className="subtle">Coverage first. Identifiers second. Gaps stay visible.</p></div><div className="toolbar"><a className="button" href="/api/exports/rounds.csv" download><Download size={13}/> CSV</a><a className="button" href="/api/exports/rounds.json" download><FileDown size={13}/> JSON</a></div></div><section className="coverage-strip"><div><span>Observed</span><b>{c.observed}</b></div><div><span>Settled</span><b>{c.settled}</b></div><div><span>Eligible</span><b>{c.eligible??"—"}</b></div><div><span>Evaluated</span><b>{c.evaluated??"—"}</b></div><div><span>Unknown / gaps</span><b>{(c.unresolved??0)+(c.missingHistory?1:0)}</b></div><div className={c.legacyUnstamped?"legacy-count":""}><span>Legacy unstamped verification</span><b>{c.legacyUnstamped??"—"}</b></div></section>{!!c.legacyUnstamped&&<div className="notice legacy-notice section"><AlertTriangle size={15}/><span><b>Legacy settlement labels lack verification timestamps.</b> {c.legacyUnstamped} archived record(s) are marked VERIFIED_SETTLEMENT without a recorded verification time.</span></div>}{(c.reason||c.gaps?.length)&&<div className="notice section"><AlertTriangle size={15}/><span>{c.reason||"Coverage gaps are retained as unknown; no rounds were invented."}{c.gaps?.length&&<small className="gap-list"> Gaps: {c.gaps.map(g=>`${fullUtc(g.start)}–${fullUtc(g.end)} (${g.minutes}m)`).join(" · ")}</small>}</span></div>}<section className="section"><div className="toolbar"><input className="input" aria-label="Search rounds" placeholder="Search round ID or outcome" value={search} onChange={e=>setSearch(e.target.value)}/></div><div className="table-wrap"><table><thead><tr><th>Round</th><th>Expiry UTC</th><th>Reference</th><th>Settlement</th><th>Outcome</th><th>Samples</th><th>Quality</th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td><span className="id">{r.id}</span><button className="icon-button" aria-label={`Copy ${r.id}`} onClick={()=>copy(r.id)}><Copy size={13}/></button></td><td>{fullUtc(r.expiryMs)}</td><td>{money(r.referencePrice)}</td><td>{money(r.settlementPrice)}</td><td className={r.outcome==="UP"?"uptext":r.outcome==="DOWN"?"downtext":"muted"}>{r.outcome}</td><td>{r.quoteCount}</td><td>{r.quality}</td></tr>)}</tbody></table>{!rows.length&&<div className="center-empty">No rounds match this search.</div>}</div><div className="pagination"><button className="icon-button" disabled={page<=1} onClick={()=>setPage(page-1)}><ChevronLeft size={15}/></button><span>Page {q.data.page||page} of {q.data.totalPages||1}</span><button className="icon-button" disabled={page>=(q.data.totalPages||1)} onClick={()=>setPage(page+1)}><ChevronRight size={15}/></button></div></section></main>}
const accuracyRate=(value?:number|null)=>value==null||!Number.isFinite(value)||value<0||value>1?"Unavailable":`${(value*100).toFixed(1)}%`;
const accuracyScore=(value?:number|null,kind:"brier"|"logLoss"="logLoss")=>value==null||!Number.isFinite(value)||value<0||(kind==="brier"&&value>1)?"Unavailable":value.toFixed(4);
function AccuracyMetricRow({label,count,metrics,unavailableReason}:{label:string;count?:number;metrics?:AccuracyMetrics|null;unavailableReason?:string|null}){
  const values=metrics;
  const hasAny=!!values&&[values.hitRate,values.brier,values.logLoss,values.coverage].some(v=>typeof v==="number"&&Number.isFinite(v));
  return <div className="accuracy-metric-row"><div className="accuracy-row-label"><strong>{label}</strong><span>n={count??"—"}{unavailableReason?` · ${unavailableReason}`:!hasAny?" · Unavailable":""}</span></div><span>{accuracyRate(values?.hitRate)}</span><span>{accuracyScore(values?.brier,"brier")}</span><span>{accuracyScore(values?.logLoss,"logLoss")}</span><span>{accuracyRate(values?.coverage)}</span></div>
}
function AccuracyTimelinePanel({data,error,loading,reload}:{data:AccuracyTimeline|null;error:string;loading:boolean;reload:()=>void}){
  const entries=data?.entries;
  const timelineReady=data?.kind==="rolling_24h_utc"&&Array.isArray(entries)&&entries.length===7;
  const series=[
    {key:"rawMarketBrier",label:"Raw market Brier",color:"#74c7ec"},
    {key:"shadowBrier",label:"Shadow Brier",color:"#edb969"},
    {key:"shadowMatchedMarketBrier",label:"Matched-market Brier",color:"#75d0aa"},
  ] as const;
  const validValue=(value:number|null|undefined)=>typeof value==="number"&&Number.isFinite(value)&&value>=0&&value<=1?value:null;
  const allValues=(entries||[]).flatMap(entry=>entry?series.map(item=>validValue(entry[item.key])).filter((value):value is number=>value!==null):[]);
  const ceiling=Math.max(.1,Math.min(1,Math.ceil(Math.max(...allValues,0)*10)/10));
  const view={left:44,right:690,top:14,bottom:190},plotWidth=view.right-view.left,plotHeight=view.bottom-view.top;
  const x=(index:number)=>view.left+(index+.5)*plotWidth/Math.max(1,entries?.length||1);
  const y=(value:number)=>view.bottom-value/ceiling*plotHeight;
  const dateLabel=(entry:AccuracyTimelineEntry|null,index:number)=>entry?new Date(entry.startUtc).toLocaleDateString(undefined,{month:"numeric",day:"numeric",timeZone:"UTC"}):`Day ${index+1}`;
  const pathSegments=(key:typeof series[number]["key"])=>{
    const segments:number[][]=[];let segment:number[]=[];
    (entries||[]).forEach((entry,index)=>{
      const value=entry?validValue(entry[key]):null;
      if(value===null){if(segment.length)segments.push(segment);segment=[]}
      else segment.push(index);
    });
    if(segment.length)segments.push(segment);
    return segments;
  };
  const callCoverage=(entry:AccuracyTimelineEntry)=>entry.evaluatedUniqueRounds>0
    ?`${(entry.directionalCalls/entry.evaluatedUniqueRounds*100).toFixed(1)}%`
    :"Unavailable";
  return <section className="accuracy-timeline panel" aria-label="Seven-day rolling accuracy trend">
    <div className="section-title"><div><p className="eyebrow">Chronological performance</p><h2>Seven-day trend</h2><p className="subtle">Seven consecutive rolling 24-hour UTC buckets. Gaps remain gaps; no values are interpolated.</p></div><Badge tone={error?"bad":timelineReady?"live":"warn"}>{error?"REFRESH FAILED":timelineReady?"ROLLING 7 DAYS":"NO COMPLETE WINDOW"}</Badge></div>
    {loading&&!data?<div className="skeleton accuracy-timeline-skeleton"/>:
      error&&!data?<div className="accuracy-timeline-empty" role="alert"><strong>Timeline unavailable</strong><span>{error}</span><button className="button" onClick={reload}><RefreshCw size={13}/> Retry</button></div>:
      !timelineReady?<div className="accuracy-timeline-empty"><strong>No complete seven-day trend</strong><span>{data?.unavailableReason||(entries?"The API did not return all seven rolling UTC buckets. No partial trend is shown.":"The API did not report timeline entries. No points are inferred.")}</span></div>:
      <div className="accuracy-timeline-content">
        {error&&<p className="accuracy-timeline-refresh-error" role="status">Refresh failed: {error}. Showing the last reported timeline snapshot; values are not updated.</p>}
        <div className="timeline-chart-wrap">
          <svg className="accuracy-timeline-chart" viewBox="0 0 710 222" role="img" aria-label="Observed rolling daily Brier scores in chronological UTC order; missing values are gaps">
            {[0,.5,1].map(fraction=>{const value=ceiling*fraction,cy=y(value);return <g key={fraction}><line x1={view.left} y1={cy} x2={view.right} y2={cy} className="timeline-grid-line"/><text x={view.left-7} y={cy+3} textAnchor="end" className="timeline-axis-label">{value.toFixed(2)}</text></g>})}
            {entries.map((entry,index)=><g key={entry?.startUtc||`empty-${index}`}><line x1={x(index)} y1={view.top} x2={x(index)} y2={view.bottom} className="timeline-slot-line"/><text x={x(index)} y="209" textAnchor="middle" className="timeline-axis-label">{dateLabel(entry,index)}</text></g>)}
            {series.map(item=><g key={item.key}>
              {pathSegments(item.key).map((segment,index)=>segment.length>1&&<path key={`${item.key}-${index}`} d={segment.map((entryIndex,pointIndex)=>`${pointIndex?"L":"M"} ${x(entryIndex)} ${y(validValue(entries?.[entryIndex]?.[item.key])!)}`).join(" ")} fill="none" stroke={item.color} strokeWidth="2" vectorEffect="non-scaling-stroke"/>)}
              {(entries||[]).map((entry,index)=>{const value=entry?validValue(entry[item.key]):null;return value===null?null:<circle key={`${item.key}-${entry?.startUtc||index}`} cx={x(index)} cy={y(value)} r="3.5" fill={item.color}><title>{`${dateLabel(entry,index)} · ${item.label}: ${value.toFixed(4)}`}</title></circle>})}
            </g>)}
          </svg>
          <div className="accuracy-timeline-legend">{series.map(item=><span key={item.key}><i style={{backgroundColor:item.color}}/>{item.label}</span>)}</div>
          <p className="timeline-scale-note">Brier scale starts at 0. A missing score creates a visible break; bucket positions follow the API’s UTC chronology.</p>
        </div>
        <div className="timeline-entry-list">{entries.map((entry,index)=>entry?<article className="timeline-entry" key={entry.startUtc}>
          <div className="timeline-entry-top"><strong>{dateLabel(entry,index)} UTC</strong><span>{entry.evaluatedUniqueRounds} evaluated · {entry.excludedRoundCount} excluded</span></div>
          <div className="timeline-entry-scores"><span>Market <b>{accuracyScore(entry.rawMarketBrier,"brier")}</b></span><span>Shadow <b>{accuracyScore(entry.shadowBrier,"brier")}</b></span><span>Matched market <b>{accuracyScore(entry.shadowMatchedMarketBrier,"brier")}</b></span></div>
          <div className="timeline-entry-calls"><span>Call coverage <b>{callCoverage(entry)}</b></span><span>{entry.directionalCalls} directional calls · {entry.abstentions} abstentions</span></div>
        </article>:<article className="timeline-entry timeline-entry-gap" key={`gap-${index}`}><strong>Bucket unavailable</strong><span>No data point reported for this position.</span></article>)}</div>
        <p className="timeline-call-definition">Call coverage = directional calls ÷ evaluated unique rounds. This describes action frequency, not probability coverage.</p>
      </div>}
  </section>
}
function AccuracyExports(){
  const [collection,setCollection]=useState<"predictions"|"outcomes"|"scores">("predictions");
  const [loading,setLoading]=useState(false),[error,setError]=useState(""),[progress,setProgress]=useState("");
  const abortRef=useRef<AbortController|null>(null);
  const exportUrl=(kind:string,format:"csv"|"json",cursor?:string)=>`/api/accuracy/export?collection=${kind}&format=${format}&limit=100${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`;
  const downloadAll=async(format:"csv"|"json")=>{
    abortRef.current?.abort();
    const controller=new AbortController();
    abortRef.current=controller;
    setLoading(true);setError("");setProgress("Preparing complete export…");
    try{
      let cursor:string|undefined, pages=0, rowCount=0;
      const jsonRows:Record<string,unknown>[]=[];
      let csvContent="";
      do{
        const response=await fetch(exportUrl(collection,format,cursor),{signal:controller.signal});
        if(!response.ok){
          let detail="";
          try{const body=await response.json();detail=typeof body.error==="string"?`: ${body.error}`:""}catch{}
          throw new Error(`Export request failed (${response.status})${detail}`);
        }
        pages++;
        if(format==="csv"){
          const pageText=await response.text();
          const firstBreak=pageText.indexOf("\n");
          if(!csvContent)csvContent=pageText;
          else if(firstBreak>=0)csvContent+=pageText.slice(firstBreak+1);
          cursor=response.headers.get("X-Next-Cursor")||undefined;
        }else{
          const body=await response.json() as {rows?:Record<string,unknown>[];nextCursor?:string|null};
          jsonRows.push(...(body.rows||[]));
          cursor=body.nextCursor||undefined;
        }
        rowCount=format==="json"?jsonRows.length:rowCount;
        setProgress(`${format==="json"?`${rowCount.toLocaleString()} rows · `:""}${pages} page${pages===1?"":"s"}${cursor?" · retrieving next page":" · complete"}`);
      }while(cursor);
      if(format==="json"){
        rowCount=jsonRows.length;
        const payload={collection,complete:true,count:rowCount,rows:jsonRows};
        // Preserve the server-provided records while making the client aggregation explicit.
        const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
        const url=URL.createObjectURL(blob),anchor=document.createElement("a");
        anchor.href=url;anchor.download=`btc-${collection}-complete.json`;anchor.click();URL.revokeObjectURL(url);
      }else{
        const blob=new Blob([csvContent],{type:"text/csv;charset=utf-8"});
        const url=URL.createObjectURL(blob),anchor=document.createElement("a");
        anchor.href=url;anchor.download=`btc-${collection}-complete.csv`;anchor.click();URL.revokeObjectURL(url);
      }
      setProgress(format==="json"?`Complete · ${rowCount.toLocaleString()} records across ${pages} page${pages===1?"":"s"}`:`Complete · ${pages} CSV page${pages===1?"":"s"}`);
    }catch(e){
      if(e instanceof DOMException&&e.name==="AbortError")setProgress("Export cancelled.");
      else{setError(e instanceof Error?e.message:"Unable to complete export");setProgress("")}
    }finally{if(abortRef.current===controller)abortRef.current=null;setLoading(false)}
  };
  return <div className="accuracy-exports">
    <div className="accuracy-export-toolbar">
      <label className="field">Accuracy dataset<select className="select" value={collection} disabled={loading} onChange={e=>setCollection(e.target.value as typeof collection)}><option value="predictions">Predictions</option><option value="outcomes">Outcomes</option><option value="scores">Scores</option></select></label>
      <div className="accuracy-export-actions"><button className="button" onClick={()=>void downloadAll("csv")} disabled={loading}><Download size={13}/>{loading?"Exporting…":"Download complete CSV"}</button><button className="button" onClick={()=>void downloadAll("json")} disabled={loading}><FileDown size={13}/>{loading?"Exporting…":"Download complete JSON"}</button>{loading&&<button className="button" onClick={()=>abortRef.current?.abort()}>Cancel</button>}</div>
    </div>
    <p className="accuracy-cursor-note">All cursor pages are followed until the server reports completion. Each request is bounded to 100 records; the downloaded file contains the full available collection.</p>
    {progress&&<p className="accuracy-export-progress" role="status">{progress}</p>}
    {error&&<div className="accuracy-export-error" role="alert"><strong>Export stopped before completion.</strong> {error} Retry to start again; no partial file was downloaded.</div>}
  </div>
}
function AccuracySection(){
  const q=useApi<Accuracy>("/api/accuracy"),[periodKey,setPeriodKey]=useState<"daily"|"sevenDay"|"lifetime">("daily");
  useEffect(()=>{if((q.data||q.error)&&window.location.hash==="#accuracy")requestAnimationFrame(()=>document.getElementById("accuracy")?.scrollIntoView({block:"start"}))},[q.data,q.error]);
  const period=q.data?.periods?.[periodKey],rawMetrics=period?.rawMarket?.metrics??period?.rawMarket,challenger=period?.shadowChallenger,champion=period?.promotedChampion;
  const exclusionsText=(value:unknown)=>typeof value==="string"?value:JSON.stringify(value,null,2)||"Not reported";
  if(q.loading&&!q.data)return <><section id="accuracy" className="accuracy-section panel"><div className="section-title"><div><p className="eyebrow">Prospective performance</p><h2>Accuracy</h2></div><Badge>LOADING</Badge></div><div className="skeleton accuracy-skeleton"/></section><AccuracyTimelinePanel data={null} error={q.error} loading={q.loading} reload={q.reload}/></>;
  if(!q.data)return <><section id="accuracy" className="accuracy-section panel"><div className="section-title"><div><p className="eyebrow">Prospective performance</p><h2>Accuracy</h2></div><Badge tone="bad">UNAVAILABLE</Badge></div><div className="accuracy-error"><strong>Accuracy data unavailable</strong><p>{q.error||"The API did not return a dataset. No scores are inferred."}</p><button className="button" onClick={q.reload}><RefreshCw size={13}/> Retry</button></div></section><AccuracyTimelinePanel data={null} error={q.error} loading={q.loading} reload={q.reload}/></>;
  const d=q.data;
  return <section id="accuracy" className="accuracy-section panel" aria-label="Prospective accuracy">
    <div className="section-title accuracy-title"><div><p className="eyebrow">Prospective · scored against observed outcomes</p><h2>Accuracy</h2><p className="subtle">Observed prospective records only. Shadow and champion rows are never simulated live accuracy.</p></div><Badge tone={d.status==="OK"?"live":"warn"}>{d.status==="OK"?"DATASET OK":"PARTIAL HISTORY"}</Badge></div>
    <div className="accuracy-meta"><span>Scope <b>{d.scope||"Not reported"}</b></span><span>As of · UTC <b>{fullUtc(d.asOf)}</b></span>{q.error&&<span className="accuracy-refresh-error">Refresh failed; showing retained accuracy snapshot.</span>}</div>
    {d.status!=="OK"&&<p className="accuracy-incomplete">Some periods exceed the reporting safety limit. Only complete periods are shown; no partial lifetime result is published.</p>}
    <div className="accuracy-periods" role="group" aria-label="Accuracy reporting period">{([["daily","Daily"],["sevenDay","7 days"],["lifetime","Lifetime"]] as const).map(([key,label])=><button key={key} className={periodKey===key?"selected":""} aria-pressed={periodKey===key} onClick={()=>setPeriodKey(key)}>{label}</button>)}</div>
    {!period?<div className="accuracy-empty">{d.unavailablePeriods?.[periodKey]||`No complete ${periodKey==="sevenDay"?"7-day":periodKey} accuracy period is reported.`}</div>:<>
      <div className="accuracy-summary-grid"><div><span>Evaluated unique rounds</span><strong>{period.evaluatedUniqueRounds??"Unavailable"}</strong></div><div><span>Excluded rounds</span><strong>{period.excludedRoundCount??"Unavailable"}</strong></div><div><span>Directional calls</span><strong>{period.issuedActions?.directionalCalls??"Unavailable"}</strong></div><div><span>Abstentions</span><strong>{period.issuedActions?.abstentions??"Unavailable"}</strong></div><div><span>Action source</span><strong>{period.issuedActions?.actionSource||"Unavailable"}</strong></div></div>
       <div className="accuracy-table" role="table" aria-label="Prospective accuracy metrics"><div className="accuracy-metric-row accuracy-metric-head" role="row"><span>Measured set</span><span>Hit rate</span><span>Brier</span><span>Log loss</span><span>Call coverage</span></div>
        <AccuracyMetricRow label="Raw market" count={period.evaluatedUniqueRounds} metrics={rawMetrics} unavailableReason={!rawMetrics?"No raw-market metrics reported":null}/>
        <AccuracyMetricRow label="Shadow challenger" count={challenger?.matchedRoundCount} metrics={challenger?.metrics} unavailableReason={challenger?.unavailableReason||(!challenger?.metrics?"No challenger metrics reported":null)}/>
        <AccuracyMetricRow label="Market · challenger-matched rounds" count={challenger?.matchedRoundCount} metrics={challenger?.marketOnMatchedRounds} unavailableReason={challenger?.unavailableReason||(!challenger?.marketOnMatchedRounds?"Matched market baseline unavailable":null)}/>
        <AccuracyMetricRow label="Promoted champion" count={champion?.matchedRoundCount} metrics={champion?.metrics} unavailableReason={champion?.unavailableReason||(!champion?.metrics?"No promoted champion metrics reported":null)}/>
        <AccuracyMetricRow label="Market · champion-matched rounds" count={champion?.matchedRoundCount} metrics={champion?.marketOnMatchedRounds} unavailableReason={champion?.unavailableReason||(!champion?.marketOnMatchedRounds?"Matched market baseline unavailable":null)}/>
      </div>
      <div className="accuracy-baseline-unavailable"><strong>Calibrated market baseline · unavailable</strong><span>{period.calibratedMarketBaseline?.available? "A baseline is reported, but calibrated scoring is not displayed without its metrics.":period.calibratedMarketBaseline?.unavailableReason||"No calibrated market baseline is available."}</span></div>
       <p className="accuracy-call-coverage-note">Call coverage is the share of scored rounds with a directional UP or DOWN action. It is not probability coverage.</p>
       <div className="accuracy-times"><span>Horizon <b>{typeof period.horizon==="string"?period.horizon:period.horizon?.name||"Unavailable"}</b></span><span>Last issued <b>{fullUtc(period.lastIssuedAt||undefined)}</b></span><span>Last scored <b>{fullUtc(period.lastScoredAt||undefined)}</b></span></div>
      <details className="accuracy-provenance"><summary>Exclusions, coverage limitations &amp; provenance</summary><div className="accuracy-provenance-content"><p><b>Exclusions</b></p><pre>{exclusionsText(period.exclusions)}</pre><p><b>API limitations</b></p><ul>{(d.limitations||[]).map((limitation,i)=><li key={`lim-${i}`}>{limitation}</li>)}</ul><p><b>Period provenance limitations</b></p><ul>{(period.provenanceLimitations||[]).map((limitation,i)=><li key={`prov-${i}`}>{limitation}</li>)}</ul></div></details>
    </>}
     <AccuracyTimelinePanel data={q.data?.timeline||null} error={q.error} loading={q.loading} reload={q.reload}/>
     <AccuracyExports/>
  </section>
}
function ModelPage(){
  const q=useApi<Model>("/api/model"),p=useApi<{rows:Prediction[];total?:number}>("/api/predictions?limit=20");
  if(q.loading&&!q.data)return <main className="page"><Load/></main>;
  if(!q.data)return <main className="page"><Load error={q.error} reload={q.reload}/></main>;
   const d=q.data,bs=d.baselines||[],rbs=d.retrospectiveBaselines||[],rows=p.data?.rows||[];
   const learningInterrupted=/interrupt|paused|failed|error/i.test(`${d.status||""} ${d.reason||""}`);
   const predictionFeedLabel=p.error?"UNAVAILABLE":p.loading&&!p.data?"LOADING":p.data?`${rows.length} RECORDS`:"EMPTY";
  const raw=d as Model&{historicalRows?:number;retrospectiveEligible?:number;prospective?:{eligible?:number;evaluated?:number};prospectiveEligible?:number;prospectiveEvaluated?:number;shadowEvaluation?:ShadowEvaluation|null;windows?:ModelWindows;trainingWindow?:string;calibrationWindow?:string;testWindow?:string};
  const windows=raw.windows||{train:raw.trainingWindow,calibration:raw.calibrationWindow,test:raw.testWindow},req=d.trainingRequirements;
  const retrospective=req?.eligibleRounds??raw.retrospectiveEligible??d.eligible,prospective=raw.prospective?.evaluated??raw.prospectiveEvaluated??d.evaluated;
   const minimumRounds=req?.minimumRounds??300,eligibleRounds=retrospective!=null&&retrospective>=minimumRounds,minimumElapsedHours=req?.minimumElapsedHours??48,elapsedHistoryHours=req?.elapsedHistoryHours,elapsedHistoryMet=elapsedHistoryHours!=null&&elapsedHistoryHours>=minimumElapsedHours,maximumAllowedGapHours=req?.maximumAllowedGapHours??12,maximumGapHours=req?.maximumGapHours,gapCoverageMet=maximumGapHours!=null&&maximumGapHours<=maximumAllowedGapHours,shadowEligible=req?.eligibleForShadow;
  const retrospectiveLabel=(name:string)=>/deepbook/i.test(name)&&/calibrat/i.test(name)?"DeepBook calibrated · shadow-only":/deepbook/i.test(name)?`${name} · shadow-only`:`${name} · shadow-only`;
  return <main className="page model-page">
    <div className="page-head"><div><p className="eyebrow">Learning engine / readiness ledger</p><h1>Model</h1><p className="subtle">A model is only useful here when its evidence is chronological, held out, and independently checked.</p></div><Badge tone={d.status==="READY"?"live":"warn"}>{d.status||"UNKNOWN"}</Badge></div>
     <section className="model-feed-status" aria-label="Learning and prediction feed status">
       <div><span>Learning pipeline</span><strong className={learningInterrupted?"status-failed":""}>{learningInterrupted?"INTERRUPTED":d.status||"STATUS NOT REPORTED"}</strong><small>{d.reason||"No interruption is reported by the model API."}</small></div>
       <div><span>Prediction record feed</span><strong className={p.error?"status-failed":""}>{predictionFeedLabel}</strong><small>{p.error?"This feed is separate from model readiness and health.":p.loading&&!p.data?"Requesting recent persisted predictions…":"Persisted prediction rows, not live forecast authorization."}</small></div>
     </section>
     {learningInterrupted&&<div className="notice learning-interrupted" role="alert"><AlertTriangle size={15}/><span><b>Learning interrupted.</b> The model API reports: {d.reason||d.status}. This is a learning-pipeline condition, not a market-feed status.</span></div>}
     {p.error&&<div className="notice prediction-feed-alert" role="alert"><AlertTriangle size={15}/><span><b>Prediction feed failed.</b> Recent prediction records could not be loaded: {p.error}<button className="text-button" onClick={p.reload}>Retry prediction feed</button></span></div>}
    <section className="readiness-hero"><div className="readiness-title"><div><p className="eyebrow">Readiness at a glance</p><h2>{d.champion?"Promoted model reported":"Learning is not ready"}</h2></div><span className="readiness-stamp">{d.champion?"ACTIVE":"NO PROMOTION"}</span></div>
        <div className="readiness-grid"><div className={eligibleRounds?"requirement met":"requirement"}><span>REQUIREMENT 01 · SAMPLE SIZE</span><strong>{eligibleRounds?"MET":retrospective==null?"NOT REPORTED":"NOT MET"}</strong><b>{retrospective??"—"} <small>/ {minimumRounds} eligible rounds</small></b><p>Eligible historical rounds available to the training pipeline.</p></div>
          <div className={elapsedHistoryMet?"requirement met":"requirement"}><span>REQUIREMENT 02 · ELAPSED HISTORY</span><strong>{elapsedHistoryMet?"MET":elapsedHistoryHours==null?"NOT REPORTED":"NOT MET"}</strong><b>{humanHours(elapsedHistoryHours)} <small>/ {minimumElapsedHours}h minimum</small></b><p>Elapsed evidence duration; crossing UTC dates alone does not satisfy this gate.</p></div>
          <div className={gapCoverageMet?"requirement met":"requirement"}><span>REQUIREMENT 03 · GAP COVERAGE</span><strong>{gapCoverageMet?"MET":maximumGapHours==null?"NOT REPORTED":"NOT MET"}</strong><b>{humanHours(maximumGapHours)} <small>/ {maximumAllowedGapHours}h maximum gap</small></b><p>Largest reported coverage gap must not exceed the allowed limit.</p></div>
         <div className={shadowEligible===true?"requirement met":shadowEligible===false?"requirement blocked":"requirement"}><span>REQUIREMENT 04 · SHADOW READINESS</span><strong>{shadowEligible===true?"ELIGIBLE":shadowEligible===false?"NOT ELIGIBLE":"NOT REPORTED"}</strong><b>{shadowEligible===true?"Eligible":shadowEligible===false?"Not eligible":"Not reported"} <small>for shadow evaluation</small></b><p>Readiness gates do not automatically promote a model or create predictive confidence.</p></div></div>
      <div className="readiness-foot"><span>Current status: {d.status||"UNKNOWN"}</span><span>Forecast confidence: unavailable without independent validation</span></div></section>
    <div className="notice section"><AlertTriangle size={15}/><span>{d.reason||"Baseline-only results describe observed history; they are not an active trained or calibrated forecast."}</span></div>
    <section className="metric-row model-metrics section"><div><span>Retrospective eligible</span><b>{retrospective??"—"}</b><em>historical training candidates</em></div><div><span>Prospective evaluated</span><b>{prospective??"—"}</b><em>pre-settlement rows scored</em></div><div><span>Historical rows</span><b>{raw.historicalRows??d.sampleCount??"—"}</b><em>observed archive</em></div><div><span>Last training</span><b>{time(d.lastTrainingAt)}</b><em>reported UTC</em></div><div><span>Last calibration</span><b>{time(d.lastCalibrationAt)}</b><em>reported UTC</em></div></section>
    <section className="model-grid section"><div className="model-card champion"><div className="card-top"><span className="eyebrow">Promoted forecast</span><Badge tone={d.champion?"live":"warn"}>{d.champion?"CHAMPION":"NONE"}</Badge></div><h2>{d.champion?.version||"No promoted champion"}</h2><p>{d.champion?"Reported by the API; review held-out metrics before interpreting it.":"Missing prerequisite: no promoted champion is active, so live calibrated predictive confidence remains unavailable."}</p></div>
      <div className="model-card shadow-card"><div className="card-top"><span className="eyebrow">Shadow track</span><Badge>{d.challenger?"CHALLENGER":"NONE"}</Badge></div><h2>{d.challenger?.version||"No challenger persisted"}</h2><p>{d.challenger?"Held out and not promoted. Its metrics are evaluation artifacts, not a live forecast.":"Missing prerequisite: no persisted challenger is currently reported."}</p>{d.challenger?.metrics&&<div className="shadow-score">Held-out Brier <b>{d.challenger.metrics.brier==null?"—":d.challenger.metrics.brier.toFixed(4)}</b> · Log loss <b>{d.challenger.metrics.logLoss==null?"—":d.challenger.metrics.logLoss.toFixed(4)}</b> · n={d.challenger.metrics.count??"—"}</div>}</div></section>
    <section className="panel section"><div className="section-title"><div><p className="eyebrow">Chronology gate</p><h2>Train → calibration → test</h2></div><Badge>ORDER MATTERS</Badge></div><p className="subtle window-copy">Each window must move forward in UTC. Training comes first, calibration is held out, and test is later and untouched. No pre-expiry quote, unsettled round, or equality/unknown outcome enters the evaluated set.</p><div className="window-grid audit-windows"><div><span>01 · Train</span><b>{windows.train||"Not reported"}</b></div><div><span>02 · Calibration</span><b>{windows.calibration||"Not reported"}</b></div><div><span>03 · Test</span><b>{windows.test||"Not reported"}</b></div></div></section>
    <section className="baseline-columns section"><section className="panel"><div className="section-title"><div><p className="eyebrow">Prospective</p><h2>Baseline scores</h2></div><Badge>{bs.length?"REPORTED":"EMPTY"}</Badge></div><p className="subtle">Append-only predictions captured before settlement. These are not a saved calibrated model forecast.</p><div className="score-stack">{bs.map(b=><div className="score-row" key={b.name}><span>{b.name}</span><b>{b.brier.toFixed(4)}</b><small>Brier · n={b.count}</small></div>)}</div>{!bs.length&&<div className="center-empty">No prospectively scored rounds yet.</div>}</section>
       <section className="panel"><div className="section-title"><div><p className="eyebrow">Retrospective</p><h2>Shadow-only baselines</h2></div><Badge>{rbs.length?"REPORTED":"EMPTY"}</Badge></div><p className="subtle">Historical-only metrics do not activate confidence. The calibrated DeepBook baseline remains shadow-only, separate from any promoted forecast.</p><div className="score-stack">{rbs.map(b=><div className="score-row" key={b.name}><span>{retrospectiveLabel(b.name)}</span><b>{b.brier.toFixed(4)}</b><small>Brier · Log loss {b.logLoss.toFixed(4)} · Matched rounds n={b.count} · shadow-only</small></div>)}</div>{!rbs.length&&<div className="center-empty">No retrospective baseline rows reported.</div>}</section></section>
     <AccuracySection/>
    <details className="panel section audit-details"><summary><span><p className="eyebrow">Audit trail</p><h2>Expand detailed prediction record</h2></span><Badge>{p.loading?"LOADING":`${rows.length} SHOWN`}</Badge></summary><p className="subtle">Append-only records from GET /api/predictions. Shadow-only prospective probabilities are artifacts, not qualified live calibrated forecasts; the recorded action remains a separate historical field.</p>
      {p.error?<div className="error compact-error"><strong>Predictions unavailable.</strong> {p.error}</div>:<div className="table-wrap"><table><thead><tr><th>Prediction UTC</th><th>Round</th><th>Remaining</th><th>Model</th><th>Indicative UP</th><th>Recorded probability · not live forecast</th><th>Recorded action · not recommendation</th><th>Outcome</th><th>Quality</th></tr></thead>
        <tbody>{rows.map((r,i)=>{const shadowOnly=r.modelVersion?.startsWith("btc-shadow-logistic-v1-")||false;const probability=shadowOnly?r.forecast_up:r.calibratedUp;return <tr key={`${r.roundId}-${r.predictionAt}-${i}`}><td>{fullUtc(r.predictionAt)}</td><td><span className="id">{r.roundId}</span></td><td>{r.remainingSeconds}s</td><td>{r.modelVersion||"Baseline"}</td><td>{r.indicativeUp==null?"—":`${Math.round(r.indicativeUp*100)}%`}</td><td>{shadowOnly?<span className="shadow-probability">SHADOW-ONLY PROSPECTIVE · {probability==null?"Unavailable":`${Math.round(probability*100)}%`}</span>:probability==null?"Unavailable":`${Math.round(probability*100)}%`}</td><td className={r.action==="UP"?"uptext":r.action==="DOWN"?"downtext":"muted"}>{r.action||"HOLD"}</td><td>{r.outcome||"Pending"}</td><td>{r.quality||"—"}{r.evaluated&&<span className="evaluated"> evaluated</span>}</td></tr>})}</tbody></table>{!p.loading&&!rows.length&&<div className="center-empty">No append-only predictions have been recorded.</div>}</div>}</details>
  </main>;
}
function AboutPage(){
  const q=useApi<About>("/api/about"),h=useApi<Health>("/api/health",15);
  if(q.loading&&!q.data)return <main className="page"><Load/></main>;
  if(!q.data)return <main className="page"><Load error={q.error} reload={q.reload}/></main>;
   const d=h.data,w=d?.worker,c=d?.coverage,roundId=d?.newestCapturedRoundId||w?.lastRoundId,buildId=d?.buildId||d?.buildIdentity||(typeof d?.build==="string"?d.build:d?.build?.id||d?.build?.identity||d?.build?.buildId);
  const coverageLabels:Record<string,string>={observed:"Observed rounds",settled:"Settled rounds",eligible:"Training-eligible rows (retrospective · 45–30s)",prospectiveEligible:"Prospective prediction records (pre-settlement)",evaluated:"Prospective evaluated rounds (baseline-scored)",observed24h:"Observed rounds · 24h",observed7d:"Observed rounds · 7d",unresolved:"Unresolved rounds",missingUnknown:"Missing / unknown",quoteSnapshots:"Quote snapshots",legacyUnstamped:"Legacy VERIFIED_SETTLEMENT labels without verification timestamp"};
  const copyRound=()=>roundId&&navigator.clipboard?.writeText(roundId);
   return <main className="page about-page">
    <div className="page-head"><div><p className="eyebrow">Provenance and boundaries</p><h1>Data health</h1><p className="subtle">A quiet monitor for the systems behind the signal.</p></div><Badge tone={w?.status==="ok"?"live":"warn"}>{w?.status||"UNKNOWN"}</Badge></div>
    {d?.warning&&<div className="notice"><AlertTriangle size={15}/><span>{d.warning}</span></div>}
    {!!c?.legacyUnstamped&&<div className="notice legacy-notice"><AlertTriangle size={15}/><span><b>Legacy settlement labels lack verification timestamps.</b> {c.legacyUnstamped} archived VERIFIED_SETTLEMENT label(s) have no recorded verification time; do not read those labels as timestamped verification.</span></div>}
     <section className="health-hero"><div><span>Worker heartbeat</span><strong>{age(w?.lastTickAt)}</strong><small>{d?.ingestionLagSeconds??w?.lagSeconds??"—"}s ingestion lag · {w?.providerFailures??0} provider failures</small></div><div><span>Newest captured round</span><strong className="health-id">{roundId?<><span>{roundId.slice(0,8)}…</span><button className="icon-button" aria-label="Copy newest captured round ID" onClick={copyRound}><Copy size={13}/></button></>:"—"}</strong><small>{age(d?.lastQuoteAt)} quote · {d?.quoteAgeSeconds??"—"}s old</small></div><div><span>Prospective evaluated</span><strong>{c?.evaluated??"—"}</strong><small>last {age(d?.lastEvaluatedAt||w?.lastEvaluationAt)}</small></div><div className="build-identity"><span>Build ID</span><strong title={buildId||"No build identity reported"}>{buildId||"Unavailable"}</strong><small>Runtime identity · not a deployed commit</small></div></section>
    <section className="health-details section"><div><span>Last settlement</span><b>{fullUtc(d?.lastSettlementAt||w?.lastSettlementAt)}</b></div><div><span>Last evaluation</span><b>{fullUtc(d?.lastEvaluatedAt||w?.lastEvaluationAt)}</b></div><div><span>Last quote</span><b>{fullUtc(d?.lastQuoteAt)}</b></div><div><span>Quote age</span><b>{d?.quoteAgeSeconds==null?"—":`${d.quoteAgeSeconds}s`}</b></div><div><span>Ingestion lag</span><b>{d?.ingestionLagSeconds==null?"—":`${d.ingestionLagSeconds}s`}</b></div><div><span>Worker errors</span><b>{w?.lastErrorAt?`${age(w.lastErrorAt)} · ${w.lastError||"reported"}`:"None reported"}</b></div></section>
    <div className="grid grid-2 section"><section className="panel"><h2>Coverage counters</h2><div className="kv">{Object.entries(c||{}).filter(([k])=>!["gaps","earliest","latest"].includes(k)).map(([k,v])=><div key={k}><span>{coverageLabels[k]||k}</span><strong>{String(v??"—")}</strong></div>)}</div><p className="counter-note">24h and 7d counts are observed rounds only. Expected published rounds are unknown, so Signal Desk does not claim a percentage coverage.</p></section><section className="panel"><h2>Sources</h2><ul className="source-list">{(q.data.sources||[]).map(s=><li key={s.name}><a href={s.url} target="_blank" rel="noreferrer">{s.name} <ExternalLink size={12}/></a><p>{s.role}</p></li>)}</ul></section></div>
    <section className="panel section"><h2>Boundaries</h2><ul className="limit-list">{(q.data.limitations||["No wallet, signing, order submission, or execution exists."]).map((x,i)=><li key={i}>{x}</li>)}</ul></section>
  </main>;
}
function SettingsPage(){const q=useApi<Settings>("/api/settings");const [refreshSeconds,setRefreshSeconds]=useState(5);const [saved,setSaved]=useState(false);useEffect(()=>{if(q.data)setRefreshSeconds(q.data.refreshSeconds??5)},[q.data]);const save=async()=>{localStorage.setItem("signal-refresh-seconds",String(refreshSeconds));const r=await fetch("/api/settings",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({refreshSeconds})});setSaved(r.ok)};if(q.loading&&!q.data)return <main className="page"><Load/></main>;return <main className="page"><div className="page-head"><div><p className="eyebrow">Local console preference</p><h1>Settings</h1><p className="subtle">Only refresh cadence is configurable here. The server owns the recommendation rule.</p></div><CircleHelp/></div><section className="panel settings-panel"><label className="field">Refresh cadence<select className="select" value={refreshSeconds} onChange={e=>setRefreshSeconds(Number(e.target.value))}><option value="5">5 seconds</option><option value="10">10 seconds</option><option value="30">30 seconds</option></select><small>Controls how often the live page asks for fresh data.</small></label><div className="notice section"><AlertTriangle size={15}/><span>Minimum edge was removed. This browser-only control did not affect the server rule, and there are no valid live economic inputs for a client-side edge calculation.</span></div><div className="section"><button className="button primary" onClick={save}><Check size={14}/> Save refresh cadence</button>{saved&&<span className="saved">Saved</span>}</div></section></main>}
function App(){return <Shell><Switch><Route path="/" component={LivePage}/><Route path="/history" component={HistoryPage}/><Route path="/model" component={ModelPage}/><Route path="/about" component={AboutPage}/><Route path="/settings" component={SettingsPage}/><Route><main className="page center-empty">Page not found</main></Route></Switch></Shell>}
export default App;