-- Development-only additive WaterX learning schema. Do not execute at startup
-- and do not modify, backfill, or reference legacy BTC/1m evidence.
CREATE TABLE IF NOT EXISTS waterx_learning_rounds (
  interval_minutes smallint NOT NULL CHECK (interval_minutes IN (5, 15)),
  round_id text NOT NULL CHECK (length(btrim(round_id)) > 0),
  start_ms bigint NOT NULL,
  expiry_ms bigint NOT NULL,
  anchor_price numeric,
  anchor_confirmed boolean NOT NULL DEFAULT false,
  probability_up numeric,
  observed_at timestamptz NOT NULL,
  source_proof jsonb NOT NULL,
  label_status text NOT NULL DEFAULT 'unresolved'
    CHECK (label_status IN ('unresolved', 'withheld', 'verified')),
  withheld_reason text,
  settlement_anchor_price numeric,
  settle_price numeric,
  outcome text CHECK (outcome IN ('Up', 'Down')),
  settled_at bigint,
  settlement_observed_at timestamptz,
  settlement_evidence jsonb,
  PRIMARY KEY (interval_minutes, round_id),
  CHECK (expiry_ms > start_ms),
  CHECK (anchor_price IS NULL OR anchor_price > 0),
  CHECK (probability_up IS NULL OR probability_up BETWEEN 0 AND 1),
  CHECK (settlement_anchor_price IS NULL OR settlement_anchor_price > 0),
  CHECK (settle_price IS NULL OR settle_price > 0),
  CHECK ((outcome IS NULL) OR
    (label_status = 'verified' AND settled_at IS NOT NULL AND settle_price IS NOT NULL))
);

ALTER TABLE waterx_learning_rounds
  ADD COLUMN IF NOT EXISTS last_settlement_attempt_at timestamptz;

CREATE INDEX IF NOT EXISTS waterx_learning_rounds_chronology_idx
  ON waterx_learning_rounds(interval_minutes, start_ms, round_id);
CREATE INDEX IF NOT EXISTS waterx_learning_rounds_labels_idx
  ON waterx_learning_rounds(interval_minutes, label_status, settled_at);
CREATE INDEX IF NOT EXISTS waterx_learning_rounds_pending_idx
  ON waterx_learning_rounds(interval_minutes, last_settlement_attempt_at, expiry_ms)
  WHERE outcome IS NULL AND label_status IN ('unresolved', 'withheld');