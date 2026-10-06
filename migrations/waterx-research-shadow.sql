-- Additive development migration. Apply only after the reviewed WaterX research
-- schema; never run this DDL automatically from application or worker startup.
CREATE TABLE IF NOT EXISTS waterx_research_shadow_predictions (
  interval_minutes SMALLINT NOT NULL CHECK (interval_minutes IN (5,15)),
  round_id TEXT NOT NULL CHECK (length(btrim(round_id))>0),
  artifact_version TEXT NOT NULL CHECK (length(btrim(artifact_version))>0),
  probability_up DOUBLE PRECISION NOT NULL CHECK (probability_up BETWEEN 0 AND 1),
  baseline_probability_up DOUBLE PRECISION NOT NULL CHECK (baseline_probability_up BETWEEN 0 AND 1),
  observed_at_ms BIGINT NOT NULL,
  decision_at_ms BIGINT NOT NULL,
  model_version TEXT NOT NULL,
  calibration_version TEXT NOT NULL,
  dataset_fingerprint TEXT NOT NULL CHECK (dataset_fingerprint ~ '^[0-9a-f]{64}$'),
  features JSONB NOT NULL,
  evidence JSONB NOT NULL,
  PRIMARY KEY (interval_minutes,round_id,artifact_version),
  FOREIGN KEY (interval_minutes,round_id)
    REFERENCES waterx_research_choices(interval_minutes,round_id)
);

CREATE INDEX IF NOT EXISTS waterx_research_shadow_predictions_time
  ON waterx_research_shadow_predictions(interval_minutes,observed_at_ms DESC);

CREATE OR REPLACE FUNCTION waterx_research_shadow_predictions_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'WaterX research shadow predictions are immutable; retain corrections separately';
END;
$$;

CREATE OR REPLACE FUNCTION waterx_research_shadow_prediction_is_timely()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  frozen_expiry_ms BIGINT;
  frozen_checkpoint_ms BIGINT;
  frozen_decision_ms BIGINT;
  frozen_baseline NUMERIC;
  choice_is_market_baseline BOOLEAN;
  artifact_finished_at TIMESTAMPTZ;
  artifact_evidence_available_ms BIGINT;
  now_ms BIGINT;
BEGIN
  SELECT expiry_ms,checkpoint_at_ms,decision_at_ms,probability_up,
         state='FROZEN' AND choice_source='market_baseline'
    INTO frozen_expiry_ms,frozen_checkpoint_ms,frozen_decision_ms,
         frozen_baseline,choice_is_market_baseline
    FROM waterx_research_choices
   WHERE interval_minutes=NEW.interval_minutes AND round_id=NEW.round_id;
  IF NOT FOUND OR NOT choice_is_market_baseline OR
     NEW.decision_at_ms<>frozen_decision_ms OR
     NEW.baseline_probability_up<>frozen_baseline OR
     NEW.observed_at_ms<frozen_decision_ms THEN
    RAISE EXCEPTION 'WaterX shadow prediction must match the committed frozen market-baseline choice';
  END IF;

  SELECT finished_at,
         (artifact->>'evidenceAvailableThroughMs')::bigint
    INTO artifact_finished_at,artifact_evidence_available_ms
    FROM waterx_research_daily_runs
   WHERE interval_minutes=NEW.interval_minutes
     AND status='evaluated'
     AND artifact->>'version'=NEW.artifact_version
     AND artifact->>'datasetFingerprint'=NEW.dataset_fingerprint
     AND artifact->>'status'='shadow-only'
     AND artifact->>'promoted'='false'
     AND finished_at<to_timestamp(frozen_decision_ms::double precision / 1000.0)
   ORDER BY finished_at DESC
   LIMIT 1;
  IF NOT FOUND OR artifact_finished_at IS NULL OR
     extract(epoch FROM artifact_finished_at)*1000>=frozen_decision_ms OR
     artifact_evidence_available_ms IS NULL OR
     artifact_evidence_available_ms>extract(epoch FROM artifact_finished_at)*1000 THEN
    RAISE EXCEPTION 'WaterX shadow artifact must be genuine, finished, and based only on already-observed evidence';
  END IF;

  now_ms := floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  IF NEW.observed_at_ms>now_ms OR now_ms>=frozen_expiry_ms OR
     now_ms>frozen_checkpoint_ms+15000 OR NEW.observed_at_ms>=frozen_expiry_ms OR
     NEW.observed_at_ms>frozen_checkpoint_ms+15000 THEN
    RAISE EXCEPTION 'WaterX shadow predictions cannot be backfilled after expiry or checkpoint grace';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid='waterx_research_shadow_predictions'::regclass
       AND tgname='waterx_research_shadow_predictions_immutable'
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER waterx_research_shadow_predictions_immutable
      BEFORE UPDATE OR DELETE ON waterx_research_shadow_predictions
      FOR EACH ROW EXECUTE FUNCTION waterx_research_shadow_predictions_immutable();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid='waterx_research_shadow_predictions'::regclass
       AND tgname='waterx_research_shadow_predictions_timely'
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER waterx_research_shadow_predictions_timely
      BEFORE INSERT ON waterx_research_shadow_predictions
      FOR EACH ROW EXECUTE FUNCTION waterx_research_shadow_prediction_is_timely();
  END IF;
END
$$;