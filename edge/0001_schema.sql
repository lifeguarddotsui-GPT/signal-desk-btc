-- Source-only prototype schema. WaterX records and Coinbase comparison data
-- are deliberately separate. Nothing here writes to the Replit database.

CREATE TABLE IF NOT EXISTS waterx_round_first (
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes IN (5, 15)),
  round_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  round_starts_at_ms INTEGER NOT NULL,
  round_ends_at_ms INTEGER NOT NULL,
  first_observed_at_ms INTEGER NOT NULL,
  up_probability_cents REAL,
  down_probability_cents REAL,
  up_odds_cents REAL,
  down_odds_cents REAL,
  reference_price REAL,
  reference_confirmed INTEGER NOT NULL CHECK (reference_confirmed IN (0, 1)),
  quote_source TEXT NOT NULL CHECK (quote_source = 'WaterX'),
  PRIMARY KEY (interval_minutes, round_id)
);

-- One compact, idempotent sample per interval/round/30-second bucket.
CREATE TABLE IF NOT EXISTS waterx_snapshots (
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes IN (5, 15)),
  round_id TEXT NOT NULL,
  observed_bucket_ms INTEGER NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  scheduled_at_ms INTEGER NOT NULL,
  up_probability_cents REAL,
  down_probability_cents REAL,
  up_odds_cents REAL,
  down_odds_cents REAL,
  reference_price REAL,
  reference_confirmed INTEGER NOT NULL CHECK (reference_confirmed IN (0, 1)),
  round_starts_at_ms INTEGER NOT NULL,
  round_ends_at_ms INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source = 'WaterX'),
  PRIMARY KEY (interval_minutes, round_id, observed_bucket_ms)
);

-- Each probe is immutable provider evidence. Verified requires matching round
-- identity and closing epoch plus provider RESOLVED/outcome/price/anchor.
CREATE TABLE IF NOT EXISTS waterx_settlement_evidence (
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes IN (5, 15)),
  expected_round_id TEXT NOT NULL,
  probe_bucket_ms INTEGER NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  expected_closing_epoch INTEGER NOT NULL,
  provider_round_id TEXT,
  provider_closing_epoch INTEGER,
  provider_status TEXT,
  provider_outcome TEXT,
  provider_settled_at_epoch INTEGER,
  provider_settle_price REAL,
  provider_anchor_price REAL,
  provider_anchor_confirmed INTEGER NOT NULL CHECK (provider_anchor_confirmed IN (0, 1)),
  verdict TEXT NOT NULL CHECK (verdict IN ('VERIFIED', 'WITHHELD', 'IDENTITY_MISMATCH', 'READ_ERROR')),
  reason TEXT,
  source TEXT NOT NULL CHECK (source = 'WaterX'),
  PRIMARY KEY (interval_minutes, expected_round_id, probe_bucket_ms)
);

-- Bounded active worklist avoids rescanning years of immutable first rounds.
CREATE TABLE IF NOT EXISTS waterx_settlement_pending (
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes IN (5, 15)),
  round_id TEXT NOT NULL,
  round_ends_at_ms INTEGER NOT NULL,
  PRIMARY KEY (interval_minutes, round_id)
);
CREATE INDEX IF NOT EXISTS waterx_settlement_pending_end
  ON waterx_settlement_pending(interval_minutes, round_ends_at_ms);
CREATE INDEX IF NOT EXISTS waterx_snapshots_window
  ON waterx_snapshots(observed_at_ms, interval_minutes);
CREATE INDEX IF NOT EXISTS waterx_settlement_window
  ON waterx_settlement_evidence(observed_at_ms, interval_minutes, verdict);

-- Coinbase is comparison evidence only; it cannot supply a WaterX label.
CREATE TABLE IF NOT EXISTS coinbase_comparison (
  source_at_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  btc_usd REAL NOT NULL,
  source TEXT NOT NULL CHECK (source = 'Coinbase'),
  PRIMARY KEY (source_at_ms, received_at_ms)
);

-- One row per expected round, including periods with no successful read.
CREATE TABLE IF NOT EXISTS waterx_edge_coverage (
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes IN (5, 15)),
  expected_round_start_ms INTEGER NOT NULL,
  expected_round_id TEXT,
  first_success_at_ms INTEGER,
  last_success_at_ms INTEGER,
  max_freshness_age_ms INTEGER,
  max_scheduled_delay_ms INTEGER,
  had_gap INTEGER NOT NULL CHECK (had_gap IN (0, 1)),
  PRIMARY KEY (interval_minutes, expected_round_start_ms)
);

CREATE INDEX IF NOT EXISTS waterx_round_first_settlement_end
  ON waterx_round_first(interval_minutes, round_ends_at_ms);
CREATE INDEX IF NOT EXISTS waterx_coverage_window
  ON waterx_edge_coverage(expected_round_start_ms, interval_minutes);