import {
  WATERX_RESEARCH_CONFIG as CONFIG,
  WATERX_RESEARCH_POLICY as POLICY,
  type ResearchInterval,
  type ResearchLifecycleState,
  type ResearchSide,
} from "../../shared/waterx-research";

export type LifecycleDb = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};
export type ExactResearchRound = {
  intervalMinutes: ResearchInterval;
  roundId: string;
  startMs: number;
  expiryMs: number;
};

export const researchRoundPolicyInsert = `INSERT INTO waterx_research_round_policy
  (interval_minutes,round_id,start_ms,expiry_ms,primary_lock_seconds,horizon_seconds,
   horizon_capture_grace_ms,policy_version)
  VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
  ON CONFLICT (interval_minutes,round_id) DO NOTHING`;

/** The first persisted policy wins for this exact round, even across restarts. */
export async function pinResearchRoundPolicy(db: LifecycleDb, round: ExactResearchRound) {
  const horizons = CONFIG.horizonSecondsBeforeClose[round.intervalMinutes];
  await db.query(researchRoundPolicyInsert, [
    round.intervalMinutes, round.roundId, round.startMs, round.expiryMs,
    CONFIG.primaryLockSeconds[round.intervalMinutes],
    JSON.stringify(horizons), POLICY.horizonCaptureGraceMs,
    CONFIG.policy.version,
  ]);
  const pinned = await db.query(`SELECT primary_lock_seconds,horizon_seconds,
      horizon_capture_grace_ms,policy_version
    FROM waterx_research_round_policy
    WHERE interval_minutes=$1 AND round_id=$2 AND start_ms=$3 AND expiry_ms=$4
    FOR UPDATE`,
  [round.intervalMinutes, round.roundId, round.startMs, round.expiryMs]);
  if (!pinned.rows.length) throw new Error("Unable to pin exact-round WaterX research policy.");
  const row = pinned.rows[0];
  const primaryLockSeconds=Number(row.primary_lock_seconds);
  const horizonSeconds=(typeof row.horizon_seconds === "string"
    ? JSON.parse(row.horizon_seconds) : row.horizon_seconds) as unknown;
  if(!Number.isSafeInteger(primaryLockSeconds)||primaryLockSeconds<1||
    primaryLockSeconds>=round.intervalMinutes*60||!Array.isArray(horizonSeconds)||
    !horizonSeconds.every(value=>Number.isSafeInteger(value)&&Number(value)>0&&
      Number(value)<round.intervalMinutes*60)||!horizonSeconds.includes(primaryLockSeconds)||
    new Set(horizonSeconds).size!==horizonSeconds.length||
    !Number.isSafeInteger(Number(row.horizon_capture_grace_ms))||
    Number(row.horizon_capture_grace_ms)<1000||Number(row.horizon_capture_grace_ms)>10000||
    !String(row.policy_version??"").trim()) {
    throw new Error("Pinned WaterX research policy row failed validation; refusing to claim confirmed availability.");
  }
  return {
    primaryLockSeconds,
    horizonSeconds: horizonSeconds.map(Number),
    horizonCaptureGraceMs:Number(row.horizon_capture_grace_ms),
    policyVersion: String(row.policy_version),
  };
}

export const researchLifecycleEventInsert = `INSERT INTO waterx_research_lifecycle_events
  (interval_minutes,round_id,start_ms,expiry_ms,event_type,side,result,outcome,actual_at_ms,details)
  SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb
  WHERE $9::bigint <= extract(epoch FROM clock_timestamp())*1000
    AND ($5 IN ('RESULT','RESULT_WITHDRAWN','NO_VALID_DATA')
      OR extract(epoch FROM clock_timestamp())*1000 < $4::bigint)
    AND ($5 NOT IN ('WATCHING','LEANING') OR NOT EXISTS (
      SELECT 1 FROM waterx_research_lifecycle_events final
      WHERE final.interval_minutes=$1 AND final.round_id=$2
        AND final.event_type IN ('FINAL_CHOICE','RESULT','RESULT_WITHDRAWN')))
    AND ($5<>'WATCHING' OR NOT EXISTS (
      SELECT 1 FROM waterx_research_lifecycle_events first_watch
      WHERE first_watch.interval_minutes=$1 AND first_watch.round_id=$2
        AND first_watch.event_type='WATCHING'))
    AND ($5<>'RESULT_WITHDRAWN' OR NOT EXISTS (
      SELECT 1 FROM waterx_research_lifecycle_events prior
      WHERE prior.interval_minutes=$1 AND prior.round_id=$2
        AND prior.event_type='RESULT_WITHDRAWN'))
  ON CONFLICT (interval_minutes,round_id,event_type,actual_at_ms) DO NOTHING
  RETURNING id`;

export async function recordResearchLifecycleEvent(db: LifecycleDb, input: ExactResearchRound & {
  eventType: ResearchLifecycleState | "RESULT_WITHDRAWN";
  actualAtMs: number;
  side?: ResearchSide | null;
  result?: "CORRECT" | "INCORRECT" | null;
  outcome?: ResearchSide | null;
  details?: unknown;
}) {
  const result = await db.query(researchLifecycleEventInsert, [
    input.intervalMinutes, input.roundId, input.startMs, input.expiryMs,
    input.eventType, input.side ?? null, input.result ?? null, input.outcome ?? null,
    input.actualAtMs, JSON.stringify(input.details ?? {}),
  ]);
  return result.rows.length > 0;
}

export const researchHorizonSnapshotInsert = `INSERT INTO waterx_research_horizon_snapshots
  (interval_minutes,round_id,start_ms,expiry_ms,lock_seconds,is_primary,actual_at_ms,
   odds_observed_at_ms,eligible,probability_up,probability_down,side,source,shadow_candidate,valid)
  SELECT $1::smallint,$2::text,$3::bigint,$4::bigint,$5::smallint,$6::boolean,
    $7::bigint,$8::bigint,$9::boolean,$10::numeric,$11::numeric,$12::text,$13::text,
    $14::jsonb,$15::boolean
  WHERE $7::bigint >= $3::bigint
    AND $7::bigint <= extract(epoch FROM clock_timestamp())*1000
    AND extract(epoch FROM clock_timestamp())*1000 < $4::bigint
    AND $7::bigint >= $4::bigint-$5::bigint*1000
    AND ($6 OR $7::bigint <= $4::bigint-$5::bigint*1000+$16::bigint)
  ON CONFLICT (interval_minutes,round_id,lock_seconds) DO NOTHING
  RETURNING round_id`;

export async function recordResearchHorizonSnapshot(db: LifecycleDb, input: ExactResearchRound & {
  lockSeconds: number;
  primary: boolean;
  actualAtMs: number;
  oddsObservedAtMs: number | null;
  eligible:boolean;
  horizonCaptureGraceMs:number;
  probabilityUp: number | null;
  probabilityDown: number | null;
  side: ResearchSide | null;
  source: string;
  shadowCandidate?: unknown;
  valid: boolean;
}) {
  const result = await db.query(researchHorizonSnapshotInsert, [
    input.intervalMinutes, input.roundId, input.startMs, input.expiryMs,
    input.lockSeconds, input.primary, input.actualAtMs, input.oddsObservedAtMs,
    input.eligible,input.probabilityUp, input.probabilityDown, input.side, input.source,
    JSON.stringify(input.shadowCandidate ?? null), input.valid,input.horizonCaptureGraceMs,
  ]);
  return result.rows.length > 0;
}
export async function hasResearchHorizonSnapshot(db:LifecycleDb,round:ExactResearchRound,lockSeconds:number) {
  const result=await db.query(`SELECT 1 FROM waterx_research_horizon_snapshots
    WHERE interval_minutes=$1 AND round_id=$2 AND start_ms=$3 AND expiry_ms=$4 AND lock_seconds=$5`,
  [round.intervalMinutes,round.roundId,round.startMs,round.expiryMs,lockSeconds]);
  return result.rows.length>0;
}

export const researchLiveObservationUpsert = `INSERT INTO waterx_research_live_observations
  (interval_minutes,round_id,start_ms,expiry_ms,probability_up,probability_down,side,source,observed_at_ms)
  SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
  WHERE $9::bigint >= $3::bigint
    AND $9::bigint <= extract(epoch FROM clock_timestamp())*1000
    AND extract(epoch FROM clock_timestamp())*1000-$9::bigint <= $10::bigint
    AND extract(epoch FROM clock_timestamp())*1000 < $4::bigint
    AND $5::numeric BETWEEN 0 AND 1 AND $6::numeric BETWEEN 0 AND 1
    AND abs($5::numeric+$6::numeric-1)<=0.000001
    AND $7=CASE WHEN $5::numeric >= $6::numeric THEN 'UP' ELSE 'DOWN' END
  ON CONFLICT (interval_minutes,round_id) DO UPDATE SET
    start_ms=EXCLUDED.start_ms,expiry_ms=EXCLUDED.expiry_ms,
    probability_up=EXCLUDED.probability_up,probability_down=EXCLUDED.probability_down,
    side=EXCLUDED.side,source=EXCLUDED.source,observed_at_ms=EXCLUDED.observed_at_ms,
    captured_at=clock_timestamp()
  WHERE waterx_research_live_observations.start_ms=EXCLUDED.start_ms
    AND waterx_research_live_observations.expiry_ms=EXCLUDED.expiry_ms
    AND waterx_research_live_observations.observed_at_ms<EXCLUDED.observed_at_ms
  RETURNING round_id`;

export async function recordResearchLiveObservation(db:LifecycleDb,input:ExactResearchRound & {
  probabilityUp:number|null;
  probabilityDown:number|null;
  side:ResearchSide|null;
  source:string;
  observedAtMs:number;
}) {
  if(input.probabilityUp===null||input.probabilityDown===null||input.side===null) return false;
  const result=await db.query(researchLiveObservationUpsert,[
    input.intervalMinutes,input.roundId,input.startMs,input.expiryMs,
    input.probabilityUp,input.probabilityDown,input.side,input.source,
    input.observedAtMs,POLICY.maxOddsAgeMs,
  ]);
  return result.rows.length>0;
}

export async function getResearchLiveObservation(db:LifecycleDb,round:ExactResearchRound,nowMs=Date.now()) {
  const result=await db.query(`SELECT probability_up,probability_down,side,source,observed_at_ms
    FROM waterx_research_live_observations
    WHERE interval_minutes=$1 AND round_id=$2 AND start_ms=$3 AND expiry_ms=$4`,
  [round.intervalMinutes,round.roundId,round.startMs,round.expiryMs]);
  const row=result.rows[0];
  if(!row) return {probabilityUp:null,probabilityDown:null,observedAt:null,source:"waterx_market_baseline",fresh:false};
  const observedAtMs=Number(row.observed_at_ms);
  const fresh=nowMs<round.expiryMs&&Number.isFinite(observedAtMs)&&
    observedAtMs<=nowMs&&nowMs-observedAtMs<=POLICY.maxOddsAgeMs;
  return {
    probabilityUp:fresh?Number(row.probability_up):null,
    probabilityDown:fresh?Number(row.probability_down):null,
    observedAt:new Date(observedAtMs).toISOString(),
    source:String(row.source),fresh,
  };
}

export async function getResearchLifecycleState(db:LifecycleDb,round:ExactResearchRound) {
  const result=await db.query(`SELECT e.event_type,e.side,e.result,e.outcome,e.actual_at_ms,e.details,
      p.primary_lock_seconds,c.state AS choice_state,c.side AS choice_side,c.decision_at_ms,
      l.label_status,l.outcome AS label_outcome,l.settlement_disputed
    FROM waterx_research_round_policy p
    LEFT JOIN LATERAL (SELECT * FROM waterx_research_lifecycle_events
      WHERE interval_minutes=p.interval_minutes AND round_id=p.round_id
        AND start_ms=p.start_ms AND expiry_ms=p.expiry_ms
      ORDER BY actual_at_ms DESC,id DESC LIMIT 1) e ON true
    LEFT JOIN waterx_research_choices c ON c.interval_minutes=p.interval_minutes
      AND c.round_id=p.round_id AND c.start_ms=p.start_ms AND c.expiry_ms=p.expiry_ms
    LEFT JOIN waterx_learning_rounds l ON l.interval_minutes=p.interval_minutes
      AND l.round_id=p.round_id AND l.start_ms=p.start_ms AND l.expiry_ms=p.expiry_ms
    WHERE p.interval_minutes=$1 AND p.round_id=$2 AND p.start_ms=$3 AND p.expiry_ms=$4`,
  [round.intervalMinutes,round.roundId,round.startMs,round.expiryMs]);
  const row=result.rows[0];
  if(!row) {
    const legacy=await db.query(`SELECT state,side,decision_at_ms FROM waterx_research_choices
      WHERE interval_minutes=$1 AND round_id=$2 AND start_ms=$3 AND expiry_ms=$4`,
    [round.intervalMinutes,round.roundId,round.startMs,round.expiryMs]);
    if(legacy.rows[0]?.state==="FROZEN") return {
      state:"FINAL_CHOICE" as const,side:legacy.rows[0].side as ResearchSide,
      result:null,occurredAt:new Date(Number(legacy.rows[0].decision_at_ms)).toISOString(),
      primaryLockSeconds:CONFIG.primaryLockSeconds[round.intervalMinutes],
    };
    if(legacy.rows[0]?.state==="NO_VALID_CHOICE") return {
      state:"NO_VALID_DATA" as const,side:null,result:null,occurredAt:null,
      primaryLockSeconds:CONFIG.primaryLockSeconds[round.intervalMinutes],
    };
    return {state:"WATCHING" as const,side:null,result:null,occurredAt:null,
      primaryLockSeconds:CONFIG.primaryLockSeconds[round.intervalMinutes]};
  }
  let state=String(row.event_type??"");
  let side=(row.side??row.choice_side??null) as ResearchSide|null;
  let resultValue=(row.result??null) as "CORRECT"|"INCORRECT"|null;
  let outcome=(row.outcome??null) as ResearchSide|null;
  let actualAt=row.actual_at_ms==null?null:Number(row.actual_at_ms);
  if(state==="RESULT"&&
    (row.label_status!=="verified"||row.settlement_disputed===true||
      String(row.label_outcome??"").toUpperCase()!==String(outcome??""))) {
    state="FINAL_CHOICE";resultValue=null;outcome=null;
  } else if(state==="RESULT_WITHDRAWN") {
    state="FINAL_CHOICE";resultValue=null;outcome=null;
  } else if(!state&&row.choice_state==="FROZEN") {
    state="FINAL_CHOICE";side=row.choice_side as ResearchSide;
    actualAt=Number(row.decision_at_ms);
  } else if(!state&&row.choice_state==="NO_VALID_CHOICE") state="NO_VALID_DATA";
  if(!state) state="WATCHING";
  return {
    state:state as ResearchLifecycleState,side,result:resultValue,
    occurredAt:actualAt===null?null:new Date(actualAt).toISOString(),
    primaryLockSeconds:Number(row.primary_lock_seconds),outcome,
  };
}

export async function recordNoValidData(db: LifecycleDb, round: ExactResearchRound, nowMs: number) {
  return recordResearchLifecycleEvent(db, {
    ...round, eventType: "NO_VALID_DATA", actualAtMs: nowMs,
    details: { reason: "No timely valid raw WaterX UP/DOWN probabilities were available before expiry." },
  });
}

export async function recordVerifiedResearchResult(db: LifecycleDb, input: ExactResearchRound & {
  side: ResearchSide;
  outcome: ResearchSide;
  actualAtMs: number;
  labelEvidence: unknown;
}) {
  const schema=await db.query(`SELECT to_regclass('waterx_research_round_policy') IS NOT NULL AS available`);
  if (schema.rows[0]?.available !== true) return false;
  const pinned=await db.query(`SELECT p.policy_version,c.policy_version AS choice_policy,c.side
    FROM waterx_research_round_policy p JOIN waterx_research_choices c
      ON c.interval_minutes=p.interval_minutes AND c.round_id=p.round_id
      AND c.start_ms=p.start_ms AND c.expiry_ms=p.expiry_ms
    WHERE p.interval_minutes=$1 AND p.round_id=$2 AND p.start_ms=$3 AND p.expiry_ms=$4`,
  [input.intervalMinutes,input.roundId,input.startMs,input.expiryMs]);
  // Historical frozen rows without an original pinned policy may still be
  // scored by the legacy research ledger, but no policy history is invented.
  if(!pinned.rows.length||pinned.rows[0].policy_version!==pinned.rows[0].choice_policy||
    String(pinned.rows[0].side)!==input.side) return false;
  return recordResearchLifecycleEvent(db, {
    ...input, eventType: "RESULT",
    result: input.side === input.outcome ? "CORRECT" : "INCORRECT",
    details: { verifiedUndisputedLabel: true, evidence: input.labelEvidence },
  });
}

export async function withdrawDisputedResearchResult(db: LifecycleDb, input: ExactResearchRound & {
  side: ResearchSide;
  previousOutcome: ResearchSide;
  actualAtMs: number;
  reason: string;
}) {
  return recordResearchLifecycleEvent(db, {
    ...input, eventType: "RESULT_WITHDRAWN",
    details: { previousOutcome: input.previousOutcome, reason: input.reason },
  });
}

/** Empirical horizon statistics use only exact, verified, undisputed labels.
 * matchedCohortN pairs each horizon against that round's pinned primary horizon. */
export const researchHorizonEvaluationSelect = `SELECT h.lock_seconds,
    count(*) FILTER (WHERE h.valid) AS recorded_n,
    count(*) FILTER (WHERE h.valid AND h.eligible) AS eligible_n,
    count(*) FILTER (WHERE h.valid AND h.eligible AND l.label_status='verified'
      AND NOT l.settlement_disputed AND l.outcome IN ('Up','Down')
      AND l.start_ms=h.start_ms AND l.expiry_ms=h.expiry_ms
      AND l.settled_at>h.expiry_ms AND l.settlement_observed_at IS NOT NULL
      AND l.settlement_observed_at>to_timestamp(h.expiry_ms::double precision/1000)
      AND l.settlement_observed_at<=clock_timestamp()) AS scored_n,
    count(*) FILTER (WHERE h.valid AND h.eligible AND l.label_status='verified'
      AND NOT l.settlement_disputed AND upper(l.outcome)=h.side
      AND l.start_ms=h.start_ms AND l.expiry_ms=h.expiry_ms
      AND l.settled_at>h.expiry_ms AND l.settlement_observed_at IS NOT NULL
      AND l.settlement_observed_at>to_timestamp(h.expiry_ms::double precision/1000)
      AND l.settlement_observed_at<=clock_timestamp()
      AND upper(l.outcome)=h.side) AS correct_n,
    avg((h.probability_up-CASE WHEN upper(l.outcome)='UP' THEN 1 ELSE 0 END)^2)
      FILTER (WHERE h.valid AND h.eligible AND l.label_status='verified' AND NOT l.settlement_disputed
        AND l.outcome IN ('Up','Down') AND l.start_ms=h.start_ms AND l.expiry_ms=h.expiry_ms
        AND l.settled_at>h.expiry_ms AND l.settlement_observed_at>to_timestamp(h.expiry_ms::double precision/1000)
        AND l.settlement_observed_at<=clock_timestamp()) AS brier,
    avg(-ln(greatest(1e-15,least(1-1e-15,
      CASE WHEN upper(l.outcome)='UP' THEN h.probability_up ELSE 1-h.probability_up END))))
      FILTER (WHERE h.valid AND h.eligible AND l.label_status='verified' AND NOT l.settlement_disputed
        AND l.outcome IN ('Up','Down') AND l.start_ms=h.start_ms AND l.expiry_ms=h.expiry_ms
        AND l.settled_at>h.expiry_ms AND l.settlement_observed_at>to_timestamp(h.expiry_ms::double precision/1000)
        AND l.settlement_observed_at<=clock_timestamp()) AS log_loss,
    count(*) FILTER (WHERE h.valid AND h.eligible AND p.valid AND p.eligible AND l.label_status='verified'
      AND NOT l.settlement_disputed AND l.outcome IN ('Up','Down')
      AND l.start_ms=h.start_ms AND l.expiry_ms=h.expiry_ms
      AND l.settled_at>h.expiry_ms AND l.settlement_observed_at>to_timestamp(h.expiry_ms::double precision/1000)
      AND l.settlement_observed_at<=clock_timestamp()) AS matched_cohort_n,
    avg((h.expiry_ms-h.actual_at_ms)/1000.0) FILTER (WHERE h.valid) AS mean_seconds_before_expiry,
    min((h.expiry_ms-h.actual_at_ms)/1000.0) FILTER (WHERE h.valid) AS min_seconds_before_expiry,
    max((h.expiry_ms-h.actual_at_ms)/1000.0) FILTER (WHERE h.valid) AS max_seconds_before_expiry
  FROM waterx_research_horizon_snapshots h
  JOIN waterx_research_round_policy rp USING(interval_minutes,round_id)
  LEFT JOIN waterx_learning_rounds l ON l.interval_minutes=h.interval_minutes
    AND l.round_id=h.round_id AND l.start_ms=h.start_ms AND l.expiry_ms=h.expiry_ms
  LEFT JOIN waterx_research_horizon_snapshots p ON p.interval_minutes=h.interval_minutes
    AND p.round_id=h.round_id AND p.start_ms=h.start_ms AND p.expiry_ms=h.expiry_ms
    AND p.lock_seconds=rp.primary_lock_seconds
  WHERE h.interval_minutes=$1
  GROUP BY h.lock_seconds
  ORDER BY h.lock_seconds DESC`;

export async function getResearchHorizonEvaluations(db: LifecycleDb, interval: ResearchInterval) {
  const [result,pinned] = await Promise.all([
    db.query(researchHorizonEvaluationSelect,[interval]),
    db.query(`SELECT DISTINCT h.value::integer AS lock_seconds
      FROM waterx_research_round_policy p
      CROSS JOIN LATERAL jsonb_array_elements_text(p.horizon_seconds) h(value)
      WHERE p.interval_minutes=$1`,[interval]),
  ]);
  const observed = new Map(result.rows.map(row => [Number(row.lock_seconds),row]));
  const horizons=new Set<number>([
    ...CONFIG.horizonSecondsBeforeClose[interval],
    ...pinned.rows.map(row=>Number(row.lock_seconds)),
  ]);
  return Array.from(horizons).sort((a,b)=>b-a).map(lockSeconds => {
    const row=observed.get(lockSeconds);
    return {
    lockSeconds,
    recordedN:row?Number(row.recorded_n):0,
    eligibleN:row?Number(row.eligible_n):0,
    scoredN:row?Number(row.scored_n):0,
    correctN:row?Number(row.correct_n):0,
    brier:!row||row.brier == null ? null : Number(row.brier),
    logLoss:!row||row.log_loss == null ? null : Number(row.log_loss),
    matchedCohortN:row?Number(row.matched_cohort_n):0,
    actualTiming:{
      meanSecondsBeforeExpiry:!row||row.mean_seconds_before_expiry == null ? null : Number(row.mean_seconds_before_expiry),
      minSecondsBeforeExpiry:!row||row.min_seconds_before_expiry == null ? null : Number(row.min_seconds_before_expiry),
      maxSecondsBeforeExpiry:!row||row.max_seconds_before_expiry == null ? null : Number(row.max_seconds_before_expiry),
    },
    researchOnly:true as const,
  };});
}

export async function getResearchLifecycleDiagnostics(
  db:LifecycleDb,interval:ResearchInterval,roundId:string|null=null,
) {
  const result=await db.query(`SELECT code,round_id,reason,count(*) AS count
    FROM waterx_research_capture_events
    WHERE interval_minutes=$1 AND ($2::text IS NULL OR round_id=$2)
      AND stage IN ('NO_VALID_CHOICE','CHECKPOINT_REJECTED','HORIZON_SNAPSHOT_MISSED',
        'OPTIONAL_ENRICHMENT','LIFECYCLE_DIAGNOSTIC')
    GROUP BY code,round_id,reason ORDER BY max(recorded_at) DESC LIMIT 200`,
  [interval,roundId]);
  return result.rows.map(row=>({
    code:String(row.code),roundId:row.round_id==null?null:String(row.round_id),
    reason:String(row.reason),count:Number(row.count),
  }));
}
