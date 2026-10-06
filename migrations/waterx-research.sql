-- Additive migration. Apply production only after the current full
-- backup/isolated-restore gate and explicit approval. Never run at startup.
CREATE TABLE IF NOT EXISTS waterx_research_choices (
  interval_minutes SMALLINT NOT NULL CHECK (interval_minutes IN (5,15)),
  round_id TEXT NOT NULL CHECK (length(round_id)>0),
  start_ms BIGINT NOT NULL,
  expiry_ms BIGINT NOT NULL,
  checkpoint_at_ms BIGINT NOT NULL,
  decision_at_ms BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('FROZEN','NO_VALID_CHOICE')),
  side TEXT CHECK (side IN ('UP','DOWN')),
  probability_up NUMERIC,
  probability_down NUMERIC,
  choice_source TEXT CHECK (choice_source IN ('market_baseline','bluewaterai_model')),
  model_version TEXT,
  calibration_version TEXT,
  policy_version TEXT NOT NULL,
  no_choice_code TEXT,
  no_choice_reason TEXT,
  evidence JSONB NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (interval_minutes,round_id),
  CHECK (expiry_ms-start_ms=interval_minutes*60000),
  CHECK (start_ms < checkpoint_at_ms AND checkpoint_at_ms < expiry_ms),
  CHECK (
    (state='FROZEN' AND side IS NOT NULL AND choice_source IS NOT NULL
      AND probability_up IS NOT NULL AND probability_down IS NOT NULL
      AND probability_up BETWEEN 0 AND 1 AND probability_down BETWEEN 0 AND 1
      AND abs(probability_up+probability_down-1)<0.000001
      AND decision_at_ms>=checkpoint_at_ms AND decision_at_ms<expiry_ms
      AND no_choice_code IS NULL AND no_choice_reason IS NULL)
    OR (state='NO_VALID_CHOICE' AND side IS NULL AND probability_up IS NULL
      AND probability_down IS NULL AND choice_source IS NULL
      AND no_choice_code IS NOT NULL AND no_choice_reason IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS waterx_research_choices_time
  ON waterx_research_choices(interval_minutes,decision_at_ms DESC);

CREATE TABLE IF NOT EXISTS waterx_research_capture_events (
  id BIGSERIAL PRIMARY KEY,
  interval_minutes SMALLINT NOT NULL CHECK (interval_minutes IN (5,15)),
  round_id TEXT,
  start_ms BIGINT NOT NULL,
  expiry_ms BIGINT NOT NULL,
  stage TEXT NOT NULL,
  code TEXT NOT NULL,
  reason TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (interval_minutes,start_ms,stage,code)
);
CREATE INDEX IF NOT EXISTS waterx_research_capture_events_time
  ON waterx_research_capture_events(interval_minutes,recorded_at DESC);

CREATE TABLE IF NOT EXISTS waterx_research_scores (
  interval_minutes SMALLINT NOT NULL,
  round_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('UP','DOWN')),
  correct BOOLEAN NOT NULL,
  brier DOUBLE PRECISION NOT NULL CHECK (brier BETWEEN 0 AND 1),
  log_loss DOUBLE PRECISION NOT NULL,
  market_baseline_brier DOUBLE PRECISION NOT NULL,
  market_baseline_log_loss DOUBLE PRECISION NOT NULL,
  probability_band SMALLINT NOT NULL CHECK (probability_band BETWEEN 0 AND 9),
  time_remaining_seconds DOUBLE PRECISION NOT NULL,
  reference_quality TEXT NOT NULL,
  reference_discrepancy_usd DOUBLE PRECISION,
  label_available_at TIMESTAMPTZ NOT NULL,
  settlement_evidence JSONB NOT NULL,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (interval_minutes,round_id),
  FOREIGN KEY (interval_minutes,round_id)
    REFERENCES waterx_research_choices(interval_minutes,round_id)
);

CREATE TABLE IF NOT EXISTS waterx_research_daily_runs (
  interval_minutes SMALLINT NOT NULL CHECK (interval_minutes IN (5,15)),
  scheduled_day DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started','trained','calibrated','evaluated','insufficient','failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  finished_at TIMESTAMPTZ,
  dataset_fingerprint TEXT,
  dataset_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  reason TEXT,
  phases JSONB NOT NULL DEFAULT '[]',
  report JSONB NOT NULL DEFAULT '{}',
  artifact JSONB,
  PRIMARY KEY (interval_minutes,scheduled_day)
);

-- Baseline estimates stay in the independently updating market feed. This
-- ledger is only for genuine promoted model estimates, never synthetic output.
CREATE TABLE IF NOT EXISTS waterx_research_model_estimates (
  interval_minutes SMALLINT NOT NULL CHECK (interval_minutes IN (5,15)),
  round_id TEXT NOT NULL,
  observed_at_ms BIGINT NOT NULL,
  probability_up NUMERIC NOT NULL CHECK (probability_up BETWEEN 0 AND 1),
  model_version TEXT NOT NULL,
  calibration_version TEXT NOT NULL,
  evidence JSONB NOT NULL,
  PRIMARY KEY (interval_minutes,round_id,observed_at_ms)
);

CREATE OR REPLACE FUNCTION waterx_research_immutable() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'WaterX research evidence is immutable; retain corrections separately';
END;
$$;
CREATE OR REPLACE FUNCTION waterx_research_timely_choice() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='FROZEN' AND (
    extract(epoch FROM clock_timestamp())*1000>=NEW.expiry_ms
    OR extract(epoch FROM clock_timestamp())*1000>NEW.checkpoint_at_ms+15000
    OR NEW.decision_at_ms>extract(epoch FROM clock_timestamp())*1000
  ) THEN
    RAISE EXCEPTION 'WaterX research predictions cannot be backfilled or inserted after checkpoint cutoff';
  END IF;
  RETURN NEW;
END;
$$;
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['waterx_research_choices','waterx_research_scores',
    'waterx_research_capture_events','waterx_research_model_estimates']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass
      AND tgname='waterx_research_immutable_guard') THEN
      EXECUTE format('CREATE TRIGGER waterx_research_immutable_guard BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION waterx_research_immutable()',t);
    END IF;
  END LOOP;
END;
$$;
DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='waterx_research_choices'::regclass
    AND tgname='waterx_research_timely_choice_guard') THEN
    CREATE TRIGGER waterx_research_timely_choice_guard BEFORE INSERT ON waterx_research_choices
      FOR EACH ROW EXECUTE FUNCTION waterx_research_timely_choice();
  END IF;
END;
$$;