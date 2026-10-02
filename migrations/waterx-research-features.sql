-- Additive append-only sidecar for source-stamped comparison features that
-- were already received by the original decision time but persisted after the
-- immutable research choice committed. Never alters choice evidence.
CREATE TABLE IF NOT EXISTS waterx_research_feature_supplements (
  interval_minutes SMALLINT NOT NULL CHECK (interval_minutes IN (5,15)),
  round_id TEXT NOT NULL,
  start_ms BIGINT NOT NULL,
  expiry_ms BIGINT NOT NULL,
  decision_at_ms BIGINT NOT NULL,
  feature_snapshot JSONB NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (interval_minutes,round_id,start_ms,expiry_ms,decision_at_ms),
  FOREIGN KEY (interval_minutes,round_id)
    REFERENCES waterx_research_choices(interval_minutes,round_id),
  CHECK (expiry_ms-start_ms=interval_minutes*60000),
  CHECK (start_ms<=decision_at_ms AND decision_at_ms<expiry_ms),
  CHECK (NOT (feature_snapshot ? 'reference')),
  CHECK (NOT (feature_snapshot ? 'market'))
);

CREATE INDEX IF NOT EXISTS waterx_research_feature_supplements_choice_idx
  ON waterx_research_feature_supplements(interval_minutes,round_id,decision_at_ms);

CREATE OR REPLACE FUNCTION waterx_research_feature_supplement_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  official RECORD;
  comparison JSONB;
  tick JSONB;
BEGIN
  SELECT c.interval_minutes,c.round_id,c.start_ms,c.expiry_ms,c.decision_at_ms,
         c.state,c.evidence->'reference' AS reference,c.evidence->'market' AS market
    INTO official
    FROM waterx_research_choices c
   WHERE c.interval_minutes=NEW.interval_minutes
     AND c.round_id=NEW.round_id
     AND c.start_ms=NEW.start_ms
     AND c.expiry_ms=NEW.expiry_ms
     AND c.decision_at_ms=NEW.decision_at_ms;
  IF NOT FOUND OR official.state<>'FROZEN' THEN
    RAISE EXCEPTION 'Feature supplement requires the exact committed frozen choice';
  END IF;
  IF NEW.feature_snapshot ? 'reference' OR NEW.feature_snapshot ? 'market' THEN
    RAISE EXCEPTION 'Feature supplement cannot replace or restate frozen reference or market evidence';
  END IF;
  comparison := NEW.feature_snapshot->'comparison';
  IF comparison IS NULL OR jsonb_typeof(comparison)<>'object'
     OR comparison->>'source'<>'Coinbase'
     OR comparison->>'coverage'<>'complete'
     OR comparison->>'sourceAtMs' IS NULL
     OR comparison->>'receivedAtMs' IS NULL
     OR comparison->>'price' IS NULL
     OR (comparison->>'sourceAtMs')::numeric>NEW.decision_at_ms
     OR (comparison->>'receivedAtMs')::numeric>NEW.decision_at_ms THEN
    RAISE EXCEPTION 'Supplement comparison fields must be complete and no later than the frozen decision';
  END IF;
  IF jsonb_typeof(NEW.feature_snapshot->'ticks')<>'array'
     OR jsonb_array_length(NEW.feature_snapshot->'ticks')<3 THEN
    RAISE EXCEPTION 'Complete supplement must retain source tick provenance';
  END IF;
  FOR tick IN SELECT value FROM jsonb_array_elements(NEW.feature_snapshot->'ticks')
  LOOP
    IF tick->>'source'<>'Coinbase'
       OR tick->>'sourceAtMs' IS NULL
       OR tick->>'receivedAtMs' IS NULL
       OR tick->>'price' IS NULL
       OR (tick->>'sourceAtMs')::numeric>NEW.decision_at_ms
       OR (tick->>'receivedAtMs')::numeric>NEW.decision_at_ms
       OR (tick->>'price')::numeric<=0 THEN
      RAISE EXCEPTION 'Supplement source ticks must be positive and source/receive-stamped no later than decision';
    END IF;
  END LOOP;
  -- There are intentionally no reference/market columns in this table. The
  -- training join replaces only evidence.comparison on a query-local copy.
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION waterx_research_feature_supplement_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'WaterX feature supplements are append-only; retain corrections separately';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid='waterx_research_feature_supplements'::regclass
      AND tgname='waterx_research_feature_supplement_insert_guard') THEN
    CREATE TRIGGER waterx_research_feature_supplement_insert_guard
      BEFORE INSERT ON waterx_research_feature_supplements
      FOR EACH ROW EXECUTE FUNCTION waterx_research_feature_supplement_guard();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid='waterx_research_feature_supplements'::regclass
      AND tgname='waterx_research_feature_supplement_immutable_guard') THEN
    CREATE TRIGGER waterx_research_feature_supplement_immutable_guard
      BEFORE UPDATE OR DELETE ON waterx_research_feature_supplements
      FOR EACH ROW EXECUTE FUNCTION waterx_research_feature_supplement_immutable();
  END IF;
END;
$$;