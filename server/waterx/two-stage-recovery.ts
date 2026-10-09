import type { LockDb } from "./lock-store";
import { TWO_STAGE_STRATEGY,PREVIOUS_TWO_STAGE_STRATEGY } from "../../shared/two-stage";
import { TIMED_STRATEGY } from "../../shared/timed-decision";
/** Recover discovery only when durable accepted input supplies the market ID.
 * Historical observations stay in their original strategy; no decisions copied. */
export async function recoverMissingStageRounds(db: LockDb, nowMs = Date.now()) {
  const result = await db.query(`INSERT INTO waterx_two_stage_rounds
    (network,market_id,round_id,interval_minutes,strategy_version,start_ms,expiry_ms,
     discovered_at_ms,capture_mode,capture_build_id)
    SELECT t.network,o.market_id,t.round_id,t.interval_minutes,$1,t.start_ms,t.expiry_ms,
      t.discovered_at_ms,'PROSPECTIVE','RECOVERED_DISCOVERY_NOT_A_LOCK'
    FROM waterx_timed_rounds t
    JOIN LATERAL(SELECT input#>>'{features,marketId}' AS market_id
      FROM waterx_timed_observations o WHERE o.network=t.network AND o.strategy_version=t.strategy_version
        AND o.interval_minutes=t.interval_minutes AND o.round_id=t.round_id
        AND o.received_at_ms>=t.start_ms AND o.received_at_ms<t.expiry_ms
        AND o.input#>>'{features,synthetic}' IS DISTINCT FROM 'true'
        AND coalesce(o.input#>>'{features,marketId}','')<>''
      ORDER BY received_at_ms LIMIT 1) o ON true
    WHERE t.network='sui:mainnet' AND t.strategy_version=$2 AND t.expiry_ms<=$3
      AND t.expiry_ms>coalesce((SELECT min(discovered_at_ms) FROM waterx_two_stage_rounds
        WHERE strategy_version=$1 AND capture_mode='PROSPECTIVE'),$3)
      AND NOT EXISTS(SELECT 1 FROM waterx_two_stage_rounds r WHERE r.network=t.network
        AND r.strategy_version=$1 AND r.interval_minutes=t.interval_minutes AND r.round_id=t.round_id)
    ORDER BY t.expiry_ms LIMIT 10 ON CONFLICT DO NOTHING RETURNING round_id`,
    [TWO_STAGE_STRATEGY,TIMED_STRATEGY,nowMs]);
  return result.rows.length;
}
/** Recovery records the absence of durable evidence, not an invented historical
 * evaluation, prediction, lock, or explanation of an unobserved failure. */
export async function recoverMissingStageAssessments(db: LockDb, nowMs = Date.now()) {
  const result = await db.query(`INSERT INTO waterx_two_stage_assessments
    (network,market_id,round_id,interval_minutes,strategy_version,stage,at_ms,reason,data_failure)
    SELECT r.network,r.market_id,r.round_id,r.interval_minutes,r.strategy_version,s.stage,$1,
      'MISSING_DURABLE_ASSESSMENT_AFTER_RECOVERY',true
    FROM waterx_two_stage_rounds r CROSS JOIN (VALUES ('EARLY'),('CONFIRMATION')) s(stage)
    WHERE r.network='sui:mainnet' AND r.strategy_version=$2 AND r.capture_mode='PROSPECTIVE'
      AND r.expiry_ms<=$1 AND NOT EXISTS(
        SELECT 1 FROM waterx_two_stage_assessments a WHERE a.network=r.network AND a.market_id=r.market_id
          AND a.round_id=r.round_id AND a.interval_minutes=r.interval_minutes
          AND a.strategy_version=r.strategy_version AND a.stage=s.stage)
      AND NOT EXISTS(SELECT 1 FROM waterx_two_stage_locks l JOIN waterx_two_stage_outbox o ON o.decision_id=l.id
        WHERE l.network=r.network AND l.market_id=r.market_id AND l.round_id=r.round_id
          AND l.interval_minutes=r.interval_minutes AND l.strategy_version=r.strategy_version AND l.lock_stage=s.stage)
    ORDER BY r.expiry_ms LIMIT 10
    ON CONFLICT(network,market_id,round_id,interval_minutes,strategy_version,stage) DO NOTHING
    RETURNING round_id,stage`, [nowMs, TWO_STAGE_STRATEGY]);
  return result.rows.length;
}

/** Add only settlement queue metadata from actually discovered shadow rounds.
 * No historical probability, anchor, observation timestamp or prediction is
 * invented. The official historical endpoint must still establish settlement. */
export async function recoverStageSettlementQueue(db: LockDb, nowMs = Date.now()) {
  const result = await db.query(`INSERT INTO waterx_learning_rounds
    (interval_minutes,round_id,start_ms,expiry_ms,anchor_price,anchor_confirmed,
     probability_up,observed_at,source_proof,label_status)
    SELECT r.interval_minutes,r.round_id,r.start_ms,r.expiry_ms,NULL,false,NULL,
      to_timestamp($1::double precision/1000),
      jsonb_build_object('kind','SETTLEMENT_QUEUE_METADATA_RECOVERY','prediction',NULL,
        'discoveredAtMs',r.discovered_at_ms,'recoveredAtMs',$1,'marketId',r.market_id,
        'source','durably discovered WaterX shadow round; no historical odds or anchor inferred'),'unresolved'
    FROM waterx_two_stage_rounds r
    WHERE r.network='sui:mainnet' AND r.capture_mode='PROSPECTIVE'
      AND r.strategy_version=ANY($2::text[]) AND r.expiry_ms<=$1
      AND NOT EXISTS(SELECT 1 FROM waterx_learning_rounds l
        WHERE l.interval_minutes=r.interval_minutes AND l.round_id=r.round_id)
    ORDER BY r.expiry_ms LIMIT 10
    ON CONFLICT(interval_minutes,round_id) DO NOTHING RETURNING round_id`,[nowMs,[TWO_STAGE_STRATEGY,PREVIOUS_TWO_STAGE_STRATEGY]]);
  return result.rows.length;
}

/** Existing immutable primary predictions also require queue metadata. This
 * recovers identity only; it never copies them into Early or Confirmation. */
export async function recoverSavedPredictionSettlementQueue(db:LockDb,nowMs=Date.now()){
  const result=await db.query(`INSERT INTO waterx_learning_rounds
    (interval_minutes,round_id,start_ms,expiry_ms,anchor_price,anchor_confirmed,
     probability_up,observed_at,source_proof,label_status)
    SELECT c.interval_minutes,c.round_id,c.start_ms,c.expiry_ms,NULL,false,NULL,
      to_timestamp($1::double precision/1000),
      jsonb_build_object('kind','SAVED_PRIMARY_SETTLEMENT_QUEUE_METADATA_RECOVERY',
        'recoveredAtMs',$1,'prediction',NULL),'unresolved'
    FROM waterx_research_choices c WHERE c.state='FROZEN' AND c.expiry_ms<=$1
      AND c.expiry_ms-c.start_ms=c.interval_minutes*60000
      AND NOT EXISTS(SELECT 1 FROM waterx_learning_rounds l
        WHERE l.interval_minutes=c.interval_minutes AND l.round_id=c.round_id)
    ORDER BY c.expiry_ms LIMIT 10 ON CONFLICT DO NOTHING RETURNING round_id`,[nowMs]);
  return result.rows.length;
}
