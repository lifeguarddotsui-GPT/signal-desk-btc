import type { LockDb } from "./lock-store";
import { TWO_STAGE_STRATEGY } from "../../shared/two-stage";
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
