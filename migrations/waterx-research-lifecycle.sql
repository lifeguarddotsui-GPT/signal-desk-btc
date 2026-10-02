-- Additive development migration; never apply at startup or publish from the app.
CREATE TABLE IF NOT EXISTS waterx_research_round_policy (
  interval_minutes SMALLINT NOT NULL CHECK (interval_minutes IN (5,15)),
  round_id TEXT NOT NULL CHECK (length(round_id)>0),
  start_ms BIGINT NOT NULL,
  expiry_ms BIGINT NOT NULL,
  primary_lock_seconds SMALLINT NOT NULL CHECK (primary_lock_seconds > 0),
  horizon_seconds JSONB NOT NULL CHECK (jsonb_typeof(horizon_seconds)='array'),
  horizon_capture_grace_ms SMALLINT NOT NULL CHECK (horizon_capture_grace_ms BETWEEN 1000 AND 10000),
  policy_version TEXT NOT NULL,
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (interval_minutes,round_id),
  UNIQUE (interval_minutes,round_id,start_ms,expiry_ms),
  CHECK (expiry_ms-start_ms=interval_minutes*60000),
  CHECK (primary_lock_seconds < interval_minutes*60)
);

-- Events are append-only. RESULT_WITHDRAWN documents later label disputes
-- without rewriting either the original final choice or the first result.
CREATE TABLE IF NOT EXISTS waterx_research_lifecycle_events (
  id BIGSERIAL PRIMARY KEY,
  interval_minutes SMALLINT NOT NULL CHECK (interval_minutes IN (5,15)),
  round_id TEXT NOT NULL,
  start_ms BIGINT NOT NULL,
  expiry_ms BIGINT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN
    ('WATCHING','LEANING','FINAL_CHOICE','RESULT','NO_VALID_DATA','RESULT_WITHDRAWN')),
  side TEXT CHECK (side IN ('UP','DOWN')),
  result TEXT CHECK (result IN ('CORRECT','INCORRECT')),
  outcome TEXT CHECK (outcome IN ('UP','DOWN')),
  actual_at_ms BIGINT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (interval_minutes,round_id,event_type,actual_at_ms),
  CHECK (expiry_ms-start_ms=interval_minutes*60000),
  CHECK ((event_type IN ('LEANING','FINAL_CHOICE','RESULT','RESULT_WITHDRAWN') AND side IS NOT NULL)
      OR (event_type IN ('WATCHING','NO_VALID_DATA') AND side IS NULL)),
  CHECK ((event_type='RESULT' AND result IS NOT NULL AND outcome IS NOT NULL)
      OR (event_type<>'RESULT' AND result IS NULL)),
  FOREIGN KEY (interval_minutes,round_id,start_ms,expiry_ms)
    REFERENCES waterx_research_round_policy(interval_minutes,round_id,start_ms,expiry_ms)
);
CREATE INDEX IF NOT EXISTS waterx_research_lifecycle_round_time
  ON waterx_research_lifecycle_events(interval_minutes,round_id,actual_at_ms);

-- Exactly one first-observed snapshot per exact round and requested horizon.
-- Actual timing is retained; this table is exploratory and never replaces the
-- canonical waterx_research_choices row.
CREATE TABLE IF NOT EXISTS waterx_research_horizon_snapshots (
  interval_minutes SMALLINT NOT NULL CHECK (interval_minutes IN (5,15)),
  round_id TEXT NOT NULL,
  start_ms BIGINT NOT NULL,
  expiry_ms BIGINT NOT NULL,
  lock_seconds SMALLINT NOT NULL CHECK (lock_seconds > 0),
  is_primary BOOLEAN NOT NULL,
  actual_at_ms BIGINT NOT NULL,
  odds_observed_at_ms BIGINT,
  eligible BOOLEAN NOT NULL,
  probability_up NUMERIC CHECK (probability_up BETWEEN 0 AND 1),
  probability_down NUMERIC CHECK (probability_down BETWEEN 0 AND 1),
  side TEXT CHECK (side IN ('UP','DOWN')),
  source TEXT NOT NULL,
  shadow_candidate JSONB,
  valid BOOLEAN NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (interval_minutes,round_id,lock_seconds),
  CHECK (expiry_ms-start_ms=interval_minutes*60000),
  CHECK ((valid AND probability_up IS NOT NULL AND probability_down IS NOT NULL AND side IS NOT NULL
      AND abs(probability_up+probability_down-1)<0.000001)
    OR (NOT valid AND side IS NULL)),
  FOREIGN KEY (interval_minutes,round_id,start_ms,expiry_ms)
    REFERENCES waterx_research_round_policy(interval_minutes,round_id,start_ms,expiry_ms)
);
CREATE INDEX IF NOT EXISTS waterx_research_horizon_evaluation
  ON waterx_research_horizon_snapshots(interval_minutes,lock_seconds,actual_at_ms);

-- Latest live odds only; lifecycle transitions themselves remain append-only.
CREATE TABLE IF NOT EXISTS waterx_research_live_observations (
  interval_minutes SMALLINT NOT NULL CHECK (interval_minutes IN (5,15)),
  round_id TEXT NOT NULL,
  start_ms BIGINT NOT NULL,
  expiry_ms BIGINT NOT NULL,
  probability_up NUMERIC NOT NULL CHECK (probability_up BETWEEN 0 AND 1),
  probability_down NUMERIC NOT NULL CHECK (probability_down BETWEEN 0 AND 1),
  side TEXT NOT NULL CHECK (side IN ('UP','DOWN')),
  source TEXT NOT NULL,
  observed_at_ms BIGINT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (interval_minutes,round_id),
  CHECK (expiry_ms-start_ms=interval_minutes*60000),
  CHECK (abs(probability_up+probability_down-1)<0.000001),
  FOREIGN KEY (interval_minutes,round_id,start_ms,expiry_ms)
    REFERENCES waterx_research_round_policy(interval_minutes,round_id,start_ms,expiry_ms)
);

CREATE OR REPLACE FUNCTION waterx_research_lifecycle_immutable() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'WaterX lifecycle evidence is append-only';
END;
$$;
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['waterx_research_round_policy',
    'waterx_research_lifecycle_events','waterx_research_horizon_snapshots']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass
      AND tgname='waterx_research_lifecycle_immutable_guard') THEN
      EXECUTE format('CREATE TRIGGER waterx_research_lifecycle_immutable_guard
        BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION waterx_research_lifecycle_immutable()',t);
    END IF;
  END LOOP;
END;
$$;

-- Grace measures how close a timestamp must be to the checkpoint for strict
-- checkpoint-cohort comparisons. It is not a cutoff for an otherwise fresh
-- canonical choice. The immutable primary row still cannot be inserted at or
-- after expiry.
CREATE OR REPLACE FUNCTION waterx_research_timely_choice() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  pinned_lock INTEGER;
  pinned_version TEXT;
  odds_at NUMERIC;
BEGIN
  IF NEW.state='FROZEN' AND (
    extract(epoch FROM clock_timestamp())*1000>=NEW.expiry_ms
    OR NEW.decision_at_ms>=NEW.expiry_ms
    OR NEW.decision_at_ms>extract(epoch FROM clock_timestamp())*1000
  ) THEN
    RAISE EXCEPTION 'WaterX primary choice must be actual and before expiry';
  END IF;
  IF NEW.state='FROZEN' THEN
    SELECT primary_lock_seconds,policy_version INTO pinned_lock,pinned_version
      FROM waterx_research_round_policy
      WHERE interval_minutes=NEW.interval_minutes AND round_id=NEW.round_id
        AND start_ms=NEW.start_ms AND expiry_ms=NEW.expiry_ms;
    IF NOT FOUND OR NEW.checkpoint_at_ms<>NEW.expiry_ms-pinned_lock*1000
      OR NEW.policy_version<>pinned_version THEN
      RAISE EXCEPTION 'WaterX choice must use the exact round pinned primary policy';
    END IF;
    odds_at:=(NEW.evidence->'market'->>'appObservedAtMs')::numeric;
    IF odds_at<NEW.start_ms OR odds_at>NEW.decision_at_ms
      OR NEW.decision_at_ms-odds_at>10000
      OR NEW.side<>(CASE WHEN NEW.probability_up>=NEW.probability_down THEN 'UP' ELSE 'DOWN' END) THEN
      RAISE EXCEPTION 'WaterX choice must use fresh raw UP/DOWN odds and deterministic UP tie break';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION waterx_research_horizon_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  pinned_lock INTEGER;
  horizons JSONB;
BEGIN
  SELECT primary_lock_seconds,horizon_seconds INTO pinned_lock,horizons
    FROM waterx_research_round_policy
    WHERE interval_minutes=NEW.interval_minutes AND round_id=NEW.round_id
      AND start_ms=NEW.start_ms AND expiry_ms=NEW.expiry_ms;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(horizons) h(v)
      WHERE h.v=NEW.lock_seconds::TEXT)
    OR NEW.is_primary<>(NEW.lock_seconds=pinned_lock)
    OR NEW.actual_at_ms<NEW.expiry_ms-NEW.lock_seconds*1000
    OR NEW.actual_at_ms>=NEW.expiry_ms
    OR NEW.actual_at_ms>extract(epoch FROM clock_timestamp())*1000
    OR extract(epoch FROM clock_timestamp())*1000>=NEW.expiry_ms
    OR NOT NEW.valid
    OR NEW.eligible<>(NEW.actual_at_ms<=NEW.expiry_ms-NEW.lock_seconds*1000+
      (SELECT horizon_capture_grace_ms FROM waterx_research_round_policy
       WHERE interval_minutes=NEW.interval_minutes AND round_id=NEW.round_id))
    OR (NOT NEW.is_primary AND NOT NEW.eligible)
    OR NEW.odds_observed_at_ms IS NULL
    OR NEW.odds_observed_at_ms<NEW.start_ms
    OR NEW.odds_observed_at_ms>NEW.actual_at_ms
    OR NEW.actual_at_ms-NEW.odds_observed_at_ms>10000
    OR NEW.side<>(CASE WHEN NEW.probability_up>=NEW.probability_down THEN 'UP' ELSE 'DOWN' END) THEN
    RAISE EXCEPTION 'WaterX horizon snapshot is outside its pinned cutoff or lacks fresh valid odds';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION waterx_research_lifecycle_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE choice_side TEXT;
BEGIN
  IF NEW.actual_at_ms<NEW.start_ms OR
     NEW.actual_at_ms>extract(epoch FROM clock_timestamp())*1000 THEN
    RAISE EXCEPTION 'WaterX lifecycle time must be real and non-future';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM waterx_research_round_policy p
    WHERE p.interval_minutes=NEW.interval_minutes AND p.round_id=NEW.round_id
      AND p.start_ms=NEW.start_ms AND p.expiry_ms=NEW.expiry_ms) THEN
    RAISE EXCEPTION 'WaterX lifecycle event requires exact pinned round identity';
  END IF;
  IF NEW.event_type IN ('WATCHING','LEANING','FINAL_CHOICE') AND
    (NEW.actual_at_ms>=NEW.expiry_ms OR
     extract(epoch FROM clock_timestamp())*1000>=NEW.expiry_ms) THEN
    RAISE EXCEPTION 'WaterX pre-settlement lifecycle event must be captured before expiry';
  END IF;
  IF NEW.event_type='NO_VALID_DATA' AND NEW.actual_at_ms<NEW.expiry_ms THEN
    RAISE EXCEPTION 'NO_VALID_DATA may only be finalized at or after expiry';
  END IF;
  IF NEW.event_type='FINAL_CHOICE' THEN
    SELECT side INTO choice_side FROM waterx_research_choices c
      WHERE c.interval_minutes=NEW.interval_minutes AND c.round_id=NEW.round_id
        AND c.start_ms=NEW.start_ms AND c.expiry_ms=NEW.expiry_ms
        AND c.state='FROZEN' AND c.side=NEW.side AND c.decision_at_ms=NEW.actual_at_ms;
    IF NOT FOUND THEN RAISE EXCEPTION 'FINAL_CHOICE requires its exact canonical frozen choice row'; END IF;
  END IF;
  IF NEW.event_type='RESULT' AND NOT EXISTS (
    SELECT 1 FROM waterx_research_choices c
    JOIN waterx_research_scores s USING(interval_minutes,round_id)
    JOIN waterx_learning_rounds l USING(interval_minutes,round_id)
    WHERE c.interval_minutes=NEW.interval_minutes AND c.round_id=NEW.round_id
      AND c.start_ms=NEW.start_ms AND c.expiry_ms=NEW.expiry_ms
      AND c.state='FROZEN' AND c.side=NEW.side
      AND s.outcome=NEW.outcome AND s.correct=(c.side=NEW.outcome)
      AND l.start_ms=NEW.start_ms AND l.expiry_ms=NEW.expiry_ms
      AND l.label_status='verified' AND NOT l.settlement_disputed
      AND upper(l.outcome)=NEW.outcome
      AND NEW.actual_at_ms>NEW.expiry_ms
      AND abs(extract(epoch FROM l.first_verified_at)*1000-NEW.actual_at_ms)<1) THEN
    RAISE EXCEPTION 'RESULT requires an exact scored canonical choice and matching undisputed verified label';
  END IF;
  IF NEW.event_type='RESULT_WITHDRAWN' AND NOT EXISTS (
    SELECT 1 FROM waterx_research_lifecycle_events e
    LEFT JOIN waterx_learning_rounds l ON l.interval_minutes=e.interval_minutes
      AND l.round_id=e.round_id AND l.start_ms=e.start_ms AND l.expiry_ms=e.expiry_ms
    WHERE e.interval_minutes=NEW.interval_minutes AND e.round_id=NEW.round_id
      AND e.event_type='RESULT' AND
        (l.round_id IS NULL OR l.label_status<>'verified' OR l.settlement_disputed
          OR upper(l.outcome)<>e.outcome)) THEN
    RAISE EXCEPTION 'RESULT_WITHDRAWN requires a later settlement dispute or label reversal';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION waterx_research_live_observation_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM waterx_research_round_policy p
      WHERE p.interval_minutes=NEW.interval_minutes AND p.round_id=NEW.round_id
        AND p.start_ms=NEW.start_ms AND p.expiry_ms=NEW.expiry_ms)
    OR NEW.observed_at_ms<NEW.start_ms
    OR NEW.observed_at_ms>extract(epoch FROM clock_timestamp())*1000
    OR extract(epoch FROM clock_timestamp())*1000-NEW.observed_at_ms>10000
    OR extract(epoch FROM clock_timestamp())*1000>=NEW.expiry_ms
    OR abs(NEW.probability_up+NEW.probability_down-1)>0.000001
    OR NEW.side<>(CASE WHEN NEW.probability_up>=NEW.probability_down THEN 'UP' ELSE 'DOWN' END) THEN
    RAISE EXCEPTION 'WaterX live odds must be exact-round, fresh, valid and pre-expiry';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS waterx_research_lifecycle_insert_guard ON waterx_research_lifecycle_events;
CREATE TRIGGER waterx_research_lifecycle_insert_guard BEFORE INSERT
  ON waterx_research_lifecycle_events FOR EACH ROW EXECUTE FUNCTION waterx_research_lifecycle_guard();
DROP TRIGGER IF EXISTS waterx_research_horizon_insert_guard ON waterx_research_horizon_snapshots;
CREATE TRIGGER waterx_research_horizon_insert_guard BEFORE INSERT
  ON waterx_research_horizon_snapshots FOR EACH ROW EXECUTE FUNCTION waterx_research_horizon_guard();
DROP TRIGGER IF EXISTS waterx_research_live_observation_guard ON waterx_research_live_observations;
CREATE TRIGGER waterx_research_live_observation_guard BEFORE INSERT OR UPDATE
  ON waterx_research_live_observations FOR EACH ROW EXECUTE FUNCTION waterx_research_live_observation_guard();