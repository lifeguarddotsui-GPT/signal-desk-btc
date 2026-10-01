-- Development-only additive WaterX candidate snapshots and audit artifacts.
-- Apply manually after waterx-learning.sql and waterx-comparison-ticks.sql.
-- This schema is not loaded at startup and does not promote or serve models.
CREATE TABLE IF NOT EXISTS waterx_candidate_feature_snapshots (
  interval_minutes smallint NOT NULL CHECK (interval_minutes IN (5, 15)),
  round_id text NOT NULL CHECK (length(btrim(round_id)) > 0),
  start_ms bigint NOT NULL,
  expiry_ms bigint NOT NULL,
  prediction_at_ms bigint NOT NULL,
  feature_snapshot_at_ms bigint NOT NULL,
  confirmed_anchor_price numeric NOT NULL CHECK (confirmed_anchor_price > 0),
  market_probability_up numeric NOT NULL CHECK (market_probability_up BETWEEN 0 AND 1),
  feature_schema text NOT NULL CHECK (feature_schema = 'waterx-round-snapshot-v1'),
  record_data jsonb NOT NULL,
  source_evidence jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (interval_minutes, round_id),
  CHECK (expiry_ms > start_ms),
  CHECK (expiry_ms - start_ms = interval_minutes * 60000),
  CHECK (prediction_at_ms >= start_ms AND prediction_at_ms < expiry_ms),
  CHECK (feature_snapshot_at_ms <= prediction_at_ms),
  CHECK (record_data->>'source' = 'WaterX'),
  CHECK (record_data->>'roundId' = round_id),
  CHECK ((record_data->>'intervalMinutes')::smallint = interval_minutes),
  CHECK (record_data->>'featureSchema' = feature_schema),
  CHECK (record_data->>'frozen' = 'true')
);

CREATE INDEX IF NOT EXISTS waterx_candidate_snapshots_chronology_idx
  ON waterx_candidate_feature_snapshots(interval_minutes, start_ms, round_id);

CREATE TABLE IF NOT EXISTS waterx_candidate_training_attempts (
  attempt_id bigserial PRIMARY KEY,
  interval_minutes smallint NOT NULL CHECK (interval_minutes IN (5, 15)),
  dataset_hash text NOT NULL CHECK (length(dataset_hash) = 64),
  status text NOT NULL CHECK (status IN ('insufficient', 'candidate-evaluated')),
  rejection_reason text NOT NULL,
  report jsonb NOT NULL,
  artifact jsonb,
  promoted boolean NOT NULL DEFAULT false CHECK (promoted = false),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS waterx_candidate_attempts_history_idx
  ON waterx_candidate_training_attempts(interval_minutes, created_at DESC, attempt_id DESC);

CREATE OR REPLACE FUNCTION waterx_candidate_reject_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'WaterX candidate evidence and audit attempts are immutable';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'waterx_candidate_snapshots_immutable'
      AND tgrelid = 'waterx_candidate_feature_snapshots'::regclass) THEN
    CREATE TRIGGER waterx_candidate_snapshots_immutable
      BEFORE UPDATE OR DELETE ON waterx_candidate_feature_snapshots
      FOR EACH ROW EXECUTE FUNCTION waterx_candidate_reject_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'waterx_candidate_attempts_immutable'
      AND tgrelid = 'waterx_candidate_training_attempts'::regclass) THEN
    CREATE TRIGGER waterx_candidate_attempts_immutable
      BEFORE UPDATE OR DELETE ON waterx_candidate_training_attempts
      FOR EACH ROW EXECUTE FUNCTION waterx_candidate_reject_mutation();
  END IF;
END;
$$;