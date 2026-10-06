-- Explicit DEVELOPMENT-only additive migration. No original lifecycle/policy is changed.
BEGIN;
CREATE TABLE IF NOT EXISTS bluewater_lock_policies (
  interval_minutes SMALLINT NOT NULL CHECK(interval_minutes IN(5,15)),
  round_id TEXT NOT NULL,start_ms BIGINT NOT NULL,expiry_ms BIGINT NOT NULL,
  policy JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(interval_minutes,round_id),
  UNIQUE(interval_minutes,round_id,start_ms,expiry_ms),
  CHECK(expiry_ms-start_ms=interval_minutes*60000),
  CHECK(policy->>'version' IS NOT NULL),
  CHECK((policy->>'intervalMinutes')::integer=interval_minutes),
  CHECK((policy->>'fallbackSeconds')::integer=CASE WHEN interval_minutes=5 THEN 60 ELSE 180 END),
  CHECK(policy->'windows'=CASE WHEN interval_minutes=5 THEN '[120,90,60]'::jsonb ELSE '[360,300,240,180]'::jsonb END)
);
CREATE TABLE IF NOT EXISTS bluewater_lock_observations (
  interval_minutes SMALLINT NOT NULL,round_id TEXT NOT NULL,start_ms BIGINT NOT NULL,expiry_ms BIGINT NOT NULL,
  observed_at_ms BIGINT NOT NULL,received_at_ms BIGINT NOT NULL,provider_source_at_ms BIGINT,
  probability_up DOUBLE PRECISION NOT NULL CHECK(probability_up BETWEEN 0 AND 1),
  probability_down DOUBLE PRECISION NOT NULL CHECK(probability_down BETWEEN 0 AND 1),
  source_healthy BOOLEAN NOT NULL,readiness JSONB NOT NULL,
  PRIMARY KEY(interval_minutes,round_id,observed_at_ms),
  FOREIGN KEY(interval_minutes,round_id,start_ms,expiry_ms)
    REFERENCES bluewater_lock_policies(interval_minutes,round_id,start_ms,expiry_ms),
  CHECK(observed_at_ms>=start_ms AND observed_at_ms<expiry_ms AND received_at_ms<=observed_at_ms),
  CHECK(provider_source_at_ms IS NULL OR provider_source_at_ms<=received_at_ms),
  CHECK(abs(probability_up+probability_down-1)<0.000001)
);
CREATE TABLE IF NOT EXISTS bluewater_lock_candidates (
  interval_minutes SMALLINT NOT NULL,round_id TEXT NOT NULL,start_ms BIGINT NOT NULL,expiry_ms BIGINT NOT NULL,
  checkpoint_seconds SMALLINT NOT NULL,decision_at_ms BIGINT NOT NULL,observed_at_ms BIGINT NOT NULL,
  probability_up DOUBLE PRECISION NOT NULL CHECK(probability_up BETWEEN 0 AND 1),
  side TEXT NOT NULL CHECK(side IN('UP','DOWN')),policy_version TEXT NOT NULL,
  readiness JSONB NOT NULL,status TEXT NOT NULL DEFAULT 'SHADOW' CHECK(status='SHADOW'),
  PRIMARY KEY(interval_minutes,round_id,checkpoint_seconds),
  FOREIGN KEY(interval_minutes,round_id,start_ms,expiry_ms)
    REFERENCES bluewater_lock_policies(interval_minutes,round_id,start_ms,expiry_ms),
  FOREIGN KEY(interval_minutes,round_id,observed_at_ms)
    REFERENCES bluewater_lock_observations(interval_minutes,round_id,observed_at_ms),
  CHECK(side=CASE WHEN probability_up>=0.5 THEN 'UP' ELSE 'DOWN' END),
  CHECK(readiness->>'state'='READY')
);
CREATE TABLE IF NOT EXISTS bluewater_lock_latency (
  id BIGSERIAL PRIMARY KEY,interval_minutes SMALLINT NOT NULL,round_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN('OBSERVATION','EARLY_CANDIDATE','CANONICAL_LOCK')),
  timing JSONB NOT NULL,recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(interval_minutes,round_id) REFERENCES bluewater_lock_policies(interval_minutes,round_id)
);
CREATE TABLE IF NOT EXISTS bluewater_lock_results (
  id BIGSERIAL PRIMARY KEY,interval_minutes SMALLINT NOT NULL,round_id TEXT NOT NULL,
  checkpoint_seconds SMALLINT NOT NULL,event_type TEXT NOT NULL CHECK(event_type IN('SCORED','WITHDRAWN')),
  outcome TEXT NOT NULL CHECK(outcome IN('UP','DOWN')),label_available_at TIMESTAMPTZ NOT NULL,
  brier DOUBLE PRECISION NOT NULL CHECK(brier BETWEEN 0 AND 1),
  log_loss DOUBLE PRECISION NOT NULL CHECK(log_loss>=0),correct BOOLEAN NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(interval_minutes,round_id,checkpoint_seconds)
    REFERENCES bluewater_lock_candidates(interval_minutes,round_id,checkpoint_seconds),
  UNIQUE(interval_minutes,round_id,checkpoint_seconds,event_type,label_available_at)
);
CREATE TABLE IF NOT EXISTS bluewater_lock_diagnostics (
  interval_minutes SMALLINT NOT NULL,round_id TEXT NOT NULL,lock_seconds SMALLINT NOT NULL,
  code TEXT NOT NULL,reason TEXT NOT NULL,at_ms BIGINT NOT NULL,details JSONB NOT NULL,
  PRIMARY KEY(interval_minutes,round_id,lock_seconds),
  FOREIGN KEY(interval_minutes,round_id) REFERENCES bluewater_lock_policies(interval_minutes,round_id)
);
CREATE OR REPLACE FUNCTION bluewater_lock_prospective_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE p JSONB; o RECORD; now_ms NUMERIC; strength_required DOUBLE PRECISION;
  persistence_required DOUBLE PRECISION; progress DOUBLE PRECISION;
  same_side_ms BIGINT; n INTEGER; observed_range DOUBLE PRECISION; reversal_n INTEGER;
BEGIN
  now_ms:=extract(epoch FROM clock_timestamp())*1000;
  IF TG_TABLE_NAME='bluewater_lock_policies' THEN
    IF now_ms>=NEW.expiry_ms OR now_ms<NEW.start_ms THEN RAISE EXCEPTION 'Cannot backfill adaptive policy'; END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='bluewater_lock_observations' THEN
    IF now_ms>=NEW.expiry_ms OR NEW.observed_at_ms>now_ms
      OR (NEW.readiness->>'evaluatedAtMs')::bigint>now_ms THEN
      RAISE EXCEPTION 'Adaptive observation must be prospective'; END IF;
    RETURN NEW;
  END IF;
  SELECT policy INTO p FROM bluewater_lock_policies WHERE interval_minutes=NEW.interval_minutes AND round_id=NEW.round_id;
  SELECT * INTO o FROM bluewater_lock_observations WHERE interval_minutes=NEW.interval_minutes
    AND round_id=NEW.round_id AND observed_at_ms=NEW.observed_at_ms;
  IF p IS NULL OR o.round_id IS NULL OR NEW.policy_version IS DISTINCT FROM p->>'version'
    OR now_ms>=NEW.expiry_ms OR NEW.decision_at_ms>now_ms
    OR NEW.decision_at_ms<NEW.expiry_ms-(p->'windows'->>0)::integer*1000
    OR NEW.decision_at_ms>=NEW.expiry_ms-(p->>'fallbackSeconds')::integer*1000
    OR NEW.decision_at_ms<NEW.observed_at_ms
    OR NEW.decision_at_ms-o.received_at_ms>(p->>'maxAgeMs')::integer
    OR (o.provider_source_at_ms IS NOT NULL AND NEW.decision_at_ms-o.provider_source_at_ms>(p->>'maxAgeMs')::integer)
    OR NEW.probability_up IS DISTINCT FROM o.probability_up OR NOT o.source_healthy
    OR NEW.readiness->>'state' IS DISTINCT FROM 'READY'
    OR (NEW.readiness->>'evaluatedAtMs')::bigint IS DISTINCT FROM NEW.decision_at_ms
    OR NEW.readiness->'components'->>'fresh' IS DISTINCT FROM 'true'
    OR NEW.readiness->'components'->>'stable' IS DISTINCT FROM 'true'
    OR NEW.readiness->'components'->>'withinWindow' IS DISTINCT FROM 'true'
    OR NEW.readiness->'components'->>'strength' IS NULL
    OR NEW.readiness->'components'->>'requiredStrength' IS NULL
    OR NEW.readiness->'components'->>'persistenceMs' IS NULL
    OR NEW.readiness->'components'->>'requiredPersistenceMs' IS NULL
    OR (NEW.readiness->'components'->>'strength')::numeric<(NEW.readiness->'components'->>'requiredStrength')::numeric
    OR (NEW.readiness->'components'->>'persistenceMs')::numeric<(NEW.readiness->'components'->>'requiredPersistenceMs')::numeric THEN
    RAISE EXCEPTION 'Early candidate requires fresh prospective READY evidence under pinned policy'; END IF;
  progress:=(NEW.decision_at_ms-(NEW.expiry_ms-(p->'windows'->>0)::integer*1000))::double precision/
    (((p->'windows'->>0)::integer-(p->>'fallbackSeconds')::integer)*1000);
  strength_required:=(p->>'earlyStrength')::double precision+
    ((p->>'lateStrength')::double precision-(p->>'earlyStrength')::double precision)*progress;
  persistence_required:=(p->>'earlyPersistenceMs')::double precision+
    ((p->>'latePersistenceMs')::double precision-(p->>'earlyPersistenceMs')::double precision)*progress;
  WITH trace AS (
    SELECT observed_at_ms,source_healthy,probability_up,
      lag(observed_at_ms) OVER(ORDER BY observed_at_ms) AS prior_at,
      lag(probability_up>=0.5) OVER(ORDER BY observed_at_ms) AS prior_up,
      lag(source_healthy) OVER(ORDER BY observed_at_ms) AS prior_healthy
    FROM bluewater_lock_observations WHERE interval_minutes=NEW.interval_minutes AND round_id=NEW.round_id
      AND observed_at_ms<=NEW.observed_at_ms
  )
  SELECT NEW.observed_at_ms-coalesce(max(observed_at_ms) FILTER(WHERE prior_at IS NOT NULL AND
      (observed_at_ms-prior_at>(p->>'maxGapMs')::integer OR (probability_up>=0.5)<>prior_up OR NOT prior_healthy)),
      min(observed_at_ms)),
    count(*) FILTER(WHERE observed_at_ms>=NEW.decision_at_ms-(p->>'stabilityWindowMs')::integer),
    max(probability_up) FILTER(WHERE observed_at_ms>=NEW.decision_at_ms-(p->>'stabilityWindowMs')::integer)-
      min(probability_up) FILTER(WHERE observed_at_ms>=NEW.decision_at_ms-(p->>'stabilityWindowMs')::integer),
    count(*) FILTER(WHERE observed_at_ms>=NEW.decision_at_ms-(p->>'reversalWindowMs')::integer
      AND prior_up IS NOT NULL AND (probability_up>=0.5)<>prior_up)
    INTO same_side_ms,n,observed_range,reversal_n FROM trace;
  IF greatest(o.probability_up,o.probability_down)<strength_required OR same_side_ms<persistence_required
    OR n<(p->>'minObservations')::integer OR observed_range>(p->>'maxRange')::double precision
    OR reversal_n>(p->>'maxReversals')::integer
    OR abs((NEW.readiness->'components'->>'requiredStrength')::double precision-strength_required)>0.00000001
    OR abs((NEW.readiness->'components'->>'requiredPersistenceMs')::double precision-persistence_required)>0.00001
    OR (NEW.readiness->'components'->>'persistenceMs')::bigint<>same_side_ms
    OR abs((NEW.readiness->'components'->>'strength')::double precision-greatest(o.probability_up,o.probability_down))>0.00000001 THEN
    RAISE EXCEPTION 'Adaptive candidate does not reproduce persisted persistence, stability and threshold evidence'; END IF;
  IF NEW.checkpoint_seconds<>0 AND (
    NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'windows') h(v) WHERE v=NEW.checkpoint_seconds::text)
    OR NEW.checkpoint_seconds=(p->>'fallbackSeconds')::integer
    OR NEW.decision_at_ms<NEW.expiry_ms-NEW.checkpoint_seconds*1000
    OR NEW.decision_at_ms>NEW.expiry_ms-NEW.checkpoint_seconds*1000+(p->>'captureGraceMs')::integer
    OR now_ms>NEW.expiry_ms-NEW.checkpoint_seconds*1000+(p->>'captureGraceMs')::integer) THEN
    RAISE EXCEPTION 'Early checkpoint missed its unchanged five-second window'; END IF;
  RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION bluewater_lock_result_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE c RECORD; l RECORD; y INTEGER;
BEGIN
  SELECT * INTO c FROM bluewater_lock_candidates WHERE interval_minutes=NEW.interval_minutes
    AND round_id=NEW.round_id AND checkpoint_seconds=NEW.checkpoint_seconds;
  SELECT * INTO l FROM waterx_learning_rounds WHERE interval_minutes=c.interval_minutes AND round_id=c.round_id
    AND start_ms=c.start_ms AND expiry_ms=c.expiry_ms;
  IF c.round_id IS NULL OR NEW.label_available_at>clock_timestamp() THEN RAISE EXCEPTION 'Invalid adaptive result identity/label time'; END IF;
  y:=CASE WHEN NEW.outcome='UP' THEN 1 ELSE 0 END;
  IF abs(NEW.brier-power(c.probability_up-y,2))>0.00000001
    OR abs(NEW.log_loss+ln(greatest(0.0000000001,least(0.9999999999,
      CASE WHEN y=1 THEN c.probability_up ELSE 1-c.probability_up END))))>0.00000001
    OR NEW.correct<>(NEW.outcome=c.side) THEN RAISE EXCEPTION 'Adaptive result mathematics invalid'; END IF;
  IF NEW.event_type='SCORED' THEN
    IF l.round_id IS NULL OR l.label_status<>'verified' OR l.settlement_disputed
      OR l.outcome IS NULL OR l.first_verified_at IS NULL OR l.settled_at IS NULL
      OR l.settle_price IS NULL OR l.settlement_anchor_price IS NULL
      OR (l.settlement_quarantine IS NOT NULL AND l.settlement_quarantine<>'[]'::jsonb)
      OR upper(l.outcome)<>NEW.outcome OR l.first_verified_at<>NEW.label_available_at
      OR NEW.label_available_at<=to_timestamp(c.expiry_ms::double precision/1000)
      OR l.settled_at<=c.expiry_ms OR l.settled_at>extract(epoch FROM clock_timestamp())*1000
      OR l.settle_price<=0 OR l.settlement_anchor_price<=0
      OR NOT ((NEW.outcome='UP' AND l.settle_price>=l.settlement_anchor_price)
        OR (NEW.outcome='DOWN' AND l.settle_price<l.settlement_anchor_price)) THEN
      RAISE EXCEPTION 'Adaptive score requires exact verified undisputed settlement'; END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM bluewater_lock_results r WHERE r.interval_minutes=NEW.interval_minutes
      AND r.round_id=NEW.round_id AND r.checkpoint_seconds=NEW.checkpoint_seconds
      AND r.event_type='SCORED' AND r.label_available_at=NEW.label_available_at)
      OR (l.round_id IS NOT NULL AND l.label_status='verified' AND NOT l.settlement_disputed
        AND upper(l.outcome)=NEW.outcome AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb)) THEN
      RAISE EXCEPTION 'Adaptive withdrawal requires invalidation of an original score'; END IF;
  END IF;
  RETURN NEW;
END; $$;
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bluewater_lock_policies','bluewater_lock_observations',
    'bluewater_lock_candidates','bluewater_lock_latency','bluewater_lock_diagnostics','bluewater_lock_results']
  LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname='lock_immutable') THEN
      EXECUTE format('CREATE TRIGGER lock_immutable BEFORE UPDATE OR DELETE ON %I
        FOR EACH ROW EXECUTE FUNCTION bluewater_evidence_immutable()',t);
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['bluewater_lock_policies','bluewater_lock_observations','bluewater_lock_candidates']
  LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname='lock_prospective') THEN
      EXECUTE format('CREATE TRIGGER lock_prospective BEFORE INSERT ON %I
        FOR EACH ROW EXECUTE FUNCTION bluewater_lock_prospective_guard()',t);
    END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='bluewater_lock_results'::regclass AND tgname='lock_result_guard') THEN
    CREATE TRIGGER lock_result_guard BEFORE INSERT ON bluewater_lock_results
      FOR EACH ROW EXECUTE FUNCTION bluewater_lock_result_guard();
  END IF;
END; $$;
COMMIT;