-- Development schema source of truth. Replit Publish reviews/applies its
-- development-to-production schema diff; do not run this at server startup.
ALTER TABLE btc_predict_rounds
  ADD COLUMN IF NOT EXISTS settlement_verified_at timestamptz;
CREATE TABLE IF NOT EXISTS btc_predict_predictions (
  id text PRIMARY KEY,
  round_id text NOT NULL REFERENCES btc_predict_rounds(id),
  snapshot_id text NOT NULL UNIQUE REFERENCES btc_predict_snapshots(id),
  observed_at timestamptz NOT NULL,
  remaining_seconds numeric NOT NULL,
  indicative_up numeric,
  forecast_up numeric,
  model_version text NOT NULL,
  action text NOT NULL DEFAULT 'HOLD',
  reason text NOT NULL,
  feature_sources jsonb NOT NULL,
  primary_window boolean NOT NULL DEFAULT false,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CHECK (forecast_up IS NULL OR forecast_up BETWEEN 0 AND 1),
  CHECK (indicative_up IS NULL OR indicative_up BETWEEN 0 AND 1),
  CHECK (action IN ('UP', 'DOWN', 'HOLD'))
);
CREATE INDEX IF NOT EXISTS btc_predict_predictions_round_idx
  ON btc_predict_predictions(round_id, observed_at);
CREATE INDEX IF NOT EXISTS btc_predict_snapshots_observed_idx
  ON btc_predict_snapshots(observed_at);
CREATE TABLE IF NOT EXISTS btc_predict_scores (
  prediction_id text PRIMARY KEY REFERENCES btc_predict_predictions(id),
  round_id text NOT NULL REFERENCES btc_predict_rounds(id),
  scored_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL CHECK (outcome IN ('UP', 'DOWN')),
  kind text NOT NULL,
  brier numeric NOT NULL,
  log_loss numeric NOT NULL
);
CREATE TABLE IF NOT EXISTS btc_predict_worker_state (
  name text PRIMARY KEY,
  last_tick_at timestamptz,
  last_market_at timestamptz,
  last_settlement_at timestamptz,
  last_evaluation_at timestamptz,
  last_training_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  provider_failures integer NOT NULL DEFAULT 0,
  last_round_id text
);
CREATE TABLE IF NOT EXISTS btc_predict_provider_errors (
  id bigserial PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  message text NOT NULL
);
CREATE TABLE IF NOT EXISTS btc_predict_models (
  version text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('SHADOW', 'CHAMPION')),
  trained_through timestamptz NOT NULL,
  calibrated_at timestamptz NOT NULL,
  metrics jsonb NOT NULL,
  parameters jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);