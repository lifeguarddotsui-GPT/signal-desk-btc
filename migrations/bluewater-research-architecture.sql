-- Additive, explicitly reviewed DEVELOPMENT migration. No existing guard is replaced.
CREATE TABLE IF NOT EXISTS waterx_research_artifacts (
  artifact_id TEXT PRIMARY KEY CHECK (artifact_id ~ '^[a-f0-9]{64}$'),
  interval_minutes SMALLINT NOT NULL CHECK (interval_minutes IN (5,15)),
  model_family TEXT NOT NULL CHECK (model_family IN ('platt_waterx','rich_logistic','rich_logistic_no_market')),
  model_version TEXT NOT NULL,
  artifact_digest TEXT NOT NULL CHECK (artifact_digest=artifact_id),
  feature_schema_version TEXT NOT NULL,
  dataset_fingerprint TEXT NOT NULL CHECK (dataset_fingerprint ~ '^[a-f0-9]{64}$'),
  fitted_at_ms BIGINT NOT NULL,
  evidence_through_ms BIGINT NOT NULL CHECK (evidence_through_ms<=fitted_at_ms),
  artifact JSONB NOT NULL,
  canonical_payload TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(interval_minutes,artifact_id),
  CHECK (canonical_payload::jsonb=artifact),
  CHECK (encode(sha256(convert_to(canonical_payload,'UTF8')),'hex')=artifact_digest),
  CHECK ((artifact->'protocol'->>'eligible')::boolean IS TRUE),
  CHECK ((artifact->'protocol'->>'records')::integer>=90),
  CHECK ((artifact->'protocol'->>'training')::integer>=40),
  CHECK ((artifact->'protocol'->>'calibration')::integer>=20),
  CHECK ((artifact->'protocol'->>'test')::integer>=20),
  CHECK ((artifact->'protocol'->>'spanMs')::bigint >=
    CASE WHEN interval_minutes=5 THEN 172800000 ELSE 604800000 END)
);
CREATE INDEX IF NOT EXISTS bluewater_artifacts_family ON waterx_research_artifacts(interval_minutes,model_family,fitted_at_ms DESC);

CREATE TABLE IF NOT EXISTS waterx_research_feature_snapshots (
  feature_snapshot_digest TEXT PRIMARY KEY CHECK (feature_snapshot_digest ~ '^[a-f0-9]{64}$'),
  interval_minutes SMALLINT NOT NULL CHECK (interval_minutes IN (5,15)),
  round_id TEXT NOT NULL, start_ms BIGINT NOT NULL, expiry_ms BIGINT NOT NULL,
  decision_at_ms BIGINT NOT NULL CHECK (decision_at_ms>=start_ms AND decision_at_ms<expiry_ms),
  feature_schema_version TEXT NOT NULL,
  feature_snapshot JSONB NOT NULL, canonical_payload TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(interval_minutes,round_id,start_ms,expiry_ms)
    REFERENCES waterx_research_round_policy(interval_minutes,round_id,start_ms,expiry_ms),
  CHECK (canonical_payload::jsonb=feature_snapshot),
  CHECK (encode(sha256(convert_to(canonical_payload,'UTF8')),'hex')=feature_snapshot_digest)
);
CREATE TABLE IF NOT EXISTS waterx_research_experiments (
  experiment_id TEXT PRIMARY KEY, interval_minutes SMALLINT NOT NULL CHECK(interval_minutes IN(5,15)),
  kind TEXT NOT NULL CHECK(kind IN('TRAIN_CHALLENGER','ABLATION','COMPARE','HORIZON_ANALYSIS','ERROR_ANALYSIS')),
  request JSONB NOT NULL, dataset_fingerprint TEXT NOT NULL CHECK(dataset_fingerprint ~ '^[a-f0-9]{64}$'),
  parameters JSONB NOT NULL, artifact_ids JSONB NOT NULL, result JSONB NOT NULL,
  status TEXT NOT NULL CHECK(status IN('INSUFFICIENT','EVALUATED','COMPLETED','FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
-- Idempotent upgrade of this new table's status allowlist; no legacy guard changes.
ALTER TABLE waterx_research_experiments DROP CONSTRAINT IF EXISTS waterx_research_experiments_status_check;
ALTER TABLE waterx_research_experiments ADD CONSTRAINT waterx_research_experiments_status_check
  CHECK(status IN('INSUFFICIENT','EVALUATED','COMPLETED','FAILED'));
CREATE TABLE IF NOT EXISTS waterx_research_agent_reports (
  interval_minutes SMALLINT NOT NULL CHECK(interval_minutes IN(5,15)), scheduled_day DATE NOT NULL,
  report JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(interval_minutes,scheduled_day)
);
CREATE TABLE IF NOT EXISTS waterx_research_champion_events (
  id BIGSERIAL PRIMARY KEY, interval_minutes SMALLINT NOT NULL CHECK(interval_minutes IN(5,15)),
  artifact_id TEXT NOT NULL, event_type TEXT NOT NULL CHECK(event_type IN('ACTIVATE','WITHDRAW')),
  approval_source TEXT NOT NULL CHECK(approval_source='development-owner-cli'),
  approval_reason TEXT NOT NULL CHECK(length(approval_reason)>=10),
  promotion_report JSONB NOT NULL, effective_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(interval_minutes,artifact_id) REFERENCES waterx_research_artifacts(interval_minutes,artifact_id)
);
CREATE TABLE IF NOT EXISTS waterx_research_model_forecasts (
  interval_minutes SMALLINT NOT NULL CHECK(interval_minutes IN(5,15)),
  round_id TEXT NOT NULL, start_ms BIGINT NOT NULL, expiry_ms BIGINT NOT NULL,
  lock_seconds SMALLINT NOT NULL CHECK(lock_seconds>0), decision_at_ms BIGINT NOT NULL,
  model_artifact_id TEXT NOT NULL, model_family TEXT NOT NULL, model_version TEXT NOT NULL,
  artifact_digest TEXT NOT NULL, feature_schema_version TEXT NOT NULL,
  feature_snapshot_digest TEXT NOT NULL,
  raw_probability_up DOUBLE PRECISION NOT NULL CHECK(raw_probability_up BETWEEN 0 AND 1),
  calibrated_probability_up DOUBLE PRECISION CHECK(calibrated_probability_up BETWEEN 0 AND 1),
  displayed_probability_up DOUBLE PRECISION NOT NULL CHECK(displayed_probability_up BETWEEN 0 AND 1),
  chosen_side TEXT NOT NULL CHECK(chosen_side IN('UP','DOWN')),
  forecast_status TEXT NOT NULL CHECK(forecast_status IN('SHADOW','CHAMPION')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(interval_minutes,round_id,model_artifact_id,lock_seconds),
  FOREIGN KEY(interval_minutes,round_id,start_ms,expiry_ms)
    REFERENCES waterx_research_round_policy(interval_minutes,round_id,start_ms,expiry_ms),
  FOREIGN KEY(interval_minutes,model_artifact_id) REFERENCES waterx_research_artifacts(interval_minutes,artifact_id),
  FOREIGN KEY(feature_snapshot_digest) REFERENCES waterx_research_feature_snapshots(feature_snapshot_digest),
  CHECK(expiry_ms-start_ms=interval_minutes*60000),
  CHECK(decision_at_ms>=start_ms AND decision_at_ms<expiry_ms),
  CHECK(displayed_probability_up=coalesce(calibrated_probability_up,raw_probability_up)),
  CHECK(chosen_side=CASE WHEN displayed_probability_up>=0.5 THEN 'UP' ELSE 'DOWN' END)
);
CREATE INDEX IF NOT EXISTS bluewater_forecast_time ON waterx_research_model_forecasts(interval_minutes,decision_at_ms DESC);
CREATE TABLE IF NOT EXISTS waterx_research_model_results (
  id BIGSERIAL PRIMARY KEY, interval_minutes SMALLINT NOT NULL, round_id TEXT NOT NULL,
  model_artifact_id TEXT NOT NULL, lock_seconds SMALLINT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN('SCORED','WITHDRAWN')),
  outcome TEXT NOT NULL CHECK(outcome IN('UP','DOWN')), correct BOOLEAN NOT NULL,
  brier DOUBLE PRECISION NOT NULL, log_loss DOUBLE PRECISION NOT NULL,
  label_available_at TIMESTAMPTZ NOT NULL, settlement_evidence JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(interval_minutes,round_id,model_artifact_id,lock_seconds)
    REFERENCES waterx_research_model_forecasts(interval_minutes,round_id,model_artifact_id,lock_seconds),
  UNIQUE(interval_minutes,round_id,model_artifact_id,lock_seconds,event_type,label_available_at)
);

CREATE OR REPLACE FUNCTION bluewater_evidence_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Bluewater evidence is append-only'; END; $$;
CREATE OR REPLACE FUNCTION bluewater_artifact_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  IF NEW.fitted_at_ms>extract(epoch FROM clock_timestamp())*1000
    OR (NEW.artifact->>'intervalMinutes')::integer IS DISTINCT FROM NEW.interval_minutes
    OR NEW.artifact->>'family' IS DISTINCT FROM NEW.model_family
    OR NEW.artifact->>'version' IS DISTINCT FROM NEW.model_version
    OR NEW.artifact->>'featureSchema' IS DISTINCT FROM NEW.feature_schema_version
    OR (NEW.artifact->>'fittedAtMs')::bigint IS DISTINCT FROM NEW.fitted_at_ms
    OR (NEW.artifact->>'evidenceThroughMs')::bigint IS DISTINCT FROM NEW.evidence_through_ms
    OR NEW.artifact->>'datasetFingerprint' IS DISTINCT FROM NEW.dataset_fingerprint
    OR NEW.artifact->>'formatVersion' IS DISTINCT FROM 'bluewater-numeric-v1'
    OR jsonb_typeof(NEW.artifact->'featureNames') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.artifact->'featureNames') NOT BETWEEN 1 AND 31
    OR NEW.artifact->'protocol'->>'records' IS NULL
    OR NEW.artifact->'protocol'->>'training' IS NULL
    OR NEW.artifact->'protocol'->>'calibration' IS NULL
    OR NEW.artifact->'protocol'->>'test' IS NULL
    OR NEW.artifact->'protocol'->>'spanMs' IS NULL THEN
    RAISE EXCEPTION 'Artifact metadata or evidence eligibility invalid';
  END IF;
  n:=jsonb_array_length(NEW.artifact->'featureNames');
  IF NEW.feature_schema_version<>'bluewater-point-in-time-v1'
    OR (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(NEW.artifact->'featureNames'))<>n
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.artifact->'featureNames') f(v) WHERE v NOT IN(
      'time_remaining_seconds','waterx_probability_up','waterx_probability_down','probability_change_5s','probability_change_15s',
      'probability_change_30s','probability_velocity','probability_acceleration','recent_side_changes','btc_price','btc_return_1s',
      'btc_return_5s','btc_return_15s','btc_return_30s','btc_return_60s','volatility_15s','volatility_30s','volatility_60s',
      'reference_distance_bps','normalized_distance','tick_density','comparison_latency_ms','observation_age_ms','source_freshness',
      'marketProbabilityUp','referenceDistanceBps','timeRemainingFraction','return1m','return3m','realizedVolatilityBps','sourceAgeMs'))
    OR (NEW.model_family='platt_waterx' AND NEW.artifact->'featureNames'<>'["waterx_probability_up"]'::jsonb)
    OR (NEW.model_family='rich_logistic_no_market' AND EXISTS(
      SELECT 1 FROM jsonb_array_elements_text(NEW.artifact->'featureNames') f(v)
      WHERE v='marketProbabilityUp' OR v LIKE 'waterx_%' OR v LIKE 'probability_%' OR v='recent_side_changes')) THEN
    RAISE EXCEPTION 'Artifact feature contract invalid';
  END IF;
  IF NEW.artifact->'calibration'<>'null'::jsonb AND (jsonb_typeof(NEW.artifact->'calibration') IS DISTINCT FROM 'object'
    OR jsonb_typeof(NEW.artifact->'calibration'->'slope') IS DISTINCT FROM 'number'
    OR jsonb_typeof(NEW.artifact->'calibration'->'intercept') IS DISTINCT FROM 'number'
    OR abs((NEW.artifact->'calibration'->>'slope')::numeric)>1000
    OR abs((NEW.artifact->'calibration'->>'intercept')::numeric)>1000) THEN
    RAISE EXCEPTION 'Artifact calibration malformed';
  END IF;
  IF NEW.model_family<>'platt_waterx' THEN
    IF jsonb_typeof(NEW.artifact->'parameters'->'means') IS DISTINCT FROM 'array'
      OR jsonb_typeof(NEW.artifact->'parameters'->'scales') IS DISTINCT FROM 'array'
      OR jsonb_typeof(NEW.artifact->'parameters'->'coefficients') IS DISTINCT FROM 'array'
      OR jsonb_typeof(NEW.artifact->'parameters'->'intercept') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Artifact numerical parameters malformed'; END IF;
    IF jsonb_array_length(NEW.artifact->'parameters'->'means')<>n
      OR jsonb_array_length(NEW.artifact->'parameters'->'scales')<>n
      OR jsonb_array_length(NEW.artifact->'parameters'->'coefficients')<>n
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.artifact->'parameters'->'means') v WHERE jsonb_typeof(v)<>'number')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.artifact->'parameters'->'scales') v WHERE jsonb_typeof(v)<>'number' OR v::text::numeric<=0.000000000001)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.artifact->'parameters'->'coefficients') v WHERE jsonb_typeof(v)<>'number' OR abs(v::text::numeric)>1000) THEN
      RAISE EXCEPTION 'Artifact numerical parameter dimensions/ranges invalid'; END IF;
  END IF; RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION bluewater_feature_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE p JSONB; r JSONB; latest JSONB; v JSONB;
BEGIN
  IF NEW.decision_at_ms>extract(epoch FROM clock_timestamp())*1000
    OR extract(epoch FROM clock_timestamp())*1000>=NEW.expiry_ms
    OR NEW.feature_snapshot->>'schema' IS DISTINCT FROM NEW.feature_schema_version
    OR (NEW.feature_snapshot->>'decisionAtMs')::bigint IS DISTINCT FROM NEW.decision_at_ms
    OR NEW.feature_snapshot->>'roundId' IS DISTINCT FROM NEW.round_id
    OR (NEW.feature_snapshot->>'intervalMinutes')::integer IS DISTINCT FROM NEW.interval_minutes
    OR (NEW.feature_snapshot->>'startMs')::bigint IS DISTINCT FROM NEW.start_ms
    OR (NEW.feature_snapshot->>'expiryMs')::bigint IS DISTINCT FROM NEW.expiry_ms
    OR jsonb_typeof(NEW.feature_snapshot->'provenance'->'market') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.feature_snapshot->'provenance'->'market') NOT BETWEEN 1 AND 240
    OR jsonb_typeof(NEW.feature_snapshot->'provenance'->'ticks') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.feature_snapshot->'provenance'->'ticks')>4096 THEN
    RAISE EXCEPTION 'Feature snapshot must be exact-round and captured before expiry';
  END IF;
  FOR p IN SELECT value FROM jsonb_array_elements(NEW.feature_snapshot->'provenance'->'market')
    UNION ALL SELECT value FROM jsonb_array_elements(NEW.feature_snapshot->'provenance'->'ticks')
  LOOP
    IF p->>'sourceAtMs' IS NULL OR p->>'receivedAtMs' IS NULL
      OR (p->>'sourceAtMs')::numeric>NEW.decision_at_ms
      OR (p->>'receivedAtMs')::numeric>NEW.decision_at_ms
      OR (p->>'receivedAtMs')::numeric<(p->>'sourceAtMs')::numeric THEN
      RAISE EXCEPTION 'Feature source or receipt timestamp violates anti-lookahead';
    END IF;
  END LOOP;
  SELECT value INTO latest FROM jsonb_array_elements(NEW.feature_snapshot->'provenance'->'market')
    WITH ORDINALITY e(value,ord) ORDER BY (value->>'sourceAtMs')::numeric DESC,ord DESC LIMIT 1;
  v:=NEW.feature_snapshot->'values';
  IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NEW.feature_schema_version<>'bluewater-point-in-time-v1'
    OR (v->>'waterx_probability_up')::numeric IS DISTINCT FROM (latest->>'probabilityUp')::numeric
    OR (v->>'marketProbabilityUp')::numeric IS DISTINCT FROM (latest->>'probabilityUp')::numeric
    OR (v->>'waterx_probability_down')::numeric IS DISTINCT FROM (latest->>'probabilityDown')::numeric
    OR abs((latest->>'probabilityUp')::numeric+(latest->>'probabilityDown')::numeric-1)>0.000001
    OR (latest->>'probabilityUp')::numeric NOT BETWEEN 0 AND 1 OR (latest->>'probabilityDown')::numeric NOT BETWEEN 0 AND 1
    OR NEW.decision_at_ms-(latest->>'sourceAtMs')::numeric>10000
    OR NEW.decision_at_ms-(latest->>'receivedAtMs')::numeric>10000
    OR abs((v->>'time_remaining_seconds')::numeric-(NEW.expiry_ms-NEW.decision_at_ms)/1000.0)>0.00000001
    OR abs((v->>'timeRemainingFraction')::numeric-(NEW.expiry_ms-NEW.decision_at_ms)::numeric/(NEW.expiry_ms-NEW.start_ms))>0.00000001
    OR (v->>'observation_age_ms')::numeric IS DISTINCT FROM NEW.decision_at_ms-(latest->>'sourceAtMs')::numeric THEN
    RAISE EXCEPTION 'Feature market values/timing do not reproduce their provenance';
  END IF;
  r:=NEW.feature_snapshot->'provenance'->'reference';
  IF r IS NOT NULL AND r<>'null'::jsonb AND (r->>'sourceAtMs' IS NULL OR r->>'receivedAtMs' IS NULL
    OR (r->>'sourceAtMs')::numeric>NEW.decision_at_ms OR (r->>'receivedAtMs')::numeric>NEW.decision_at_ms) THEN
    RAISE EXCEPTION 'Reference timestamp violates anti-lookahead';
  END IF; RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION bluewater_forecast_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE a RECORD; f RECORD; p RECORD; champion TEXT; market_at NUMERIC; v NUMERIC; raw NUMERIC; cal NUMERIC; idx INTEGER; n TEXT;
BEGIN
  SELECT * INTO a FROM waterx_research_artifacts WHERE artifact_id=NEW.model_artifact_id;
  SELECT * INTO f FROM waterx_research_feature_snapshots WHERE feature_snapshot_digest=NEW.feature_snapshot_digest;
  SELECT * INTO p FROM waterx_research_round_policy WHERE interval_minutes=NEW.interval_minutes AND round_id=NEW.round_id;
  IF a.artifact_id IS NULL OR f.feature_snapshot_digest IS NULL OR p.round_id IS NULL
    OR NEW.decision_at_ms>extract(epoch FROM clock_timestamp())*1000
    OR extract(epoch FROM clock_timestamp())*1000>=NEW.expiry_ms
    OR a.fitted_at_ms>NEW.decision_at_ms OR a.evidence_through_ms>NEW.decision_at_ms
    OR a.created_at>to_timestamp(NEW.decision_at_ms::double precision/1000)
    OR a.interval_minutes<>NEW.interval_minutes OR f.interval_minutes<>NEW.interval_minutes
    OR f.round_id<>NEW.round_id OR f.start_ms<>NEW.start_ms OR f.expiry_ms<>NEW.expiry_ms
    OR f.decision_at_ms<>NEW.decision_at_ms OR a.model_family<>NEW.model_family
    OR a.model_version<>NEW.model_version OR a.artifact_digest<>NEW.artifact_digest
    OR a.feature_schema_version<>NEW.feature_schema_version OR f.feature_schema_version<>NEW.feature_schema_version
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p.horizon_seconds) h(v) WHERE h.v=NEW.lock_seconds::text)
    OR NEW.decision_at_ms<NEW.expiry_ms-NEW.lock_seconds*1000
    OR NEW.decision_at_ms>NEW.expiry_ms-NEW.lock_seconds*1000+p.horizon_capture_grace_ms THEN
    RAISE EXCEPTION 'Forecast must be prospective, exact-identity and inside its pinned horizon';
  END IF;
  market_at:=(SELECT max((value->>'sourceAtMs')::numeric) FROM jsonb_array_elements(f.feature_snapshot->'provenance'->'market'));
  IF market_at<NEW.start_ms OR NEW.decision_at_ms-market_at>10000 THEN RAISE EXCEPTION 'Forecast market input stale'; END IF;
  IF a.model_family='platt_waterx' THEN
    raw:=(f.feature_snapshot->'values'->>'waterx_probability_up')::numeric;
  ELSE
    v:=(a.artifact->'parameters'->>'intercept')::numeric; idx:=0;
    FOR n IN SELECT value FROM jsonb_array_elements_text(a.artifact->'featureNames') LOOP
      IF f.feature_snapshot->'values'->>n IS NULL THEN RAISE EXCEPTION 'Required feature unavailable'; END IF;
      v:=v+((f.feature_snapshot->'values'->>n)::numeric-(a.artifact->'parameters'->'means'->>idx)::numeric)
        /(a.artifact->'parameters'->'scales'->>idx)::numeric*(a.artifact->'parameters'->'coefficients'->>idx)::numeric;
      idx:=idx+1;
    END LOOP;
    raw:=1/(1+exp(-greatest(-25,least(25,v))));
  END IF;
  IF a.artifact->'calibration' IS NOT NULL AND a.artifact->'calibration'<>'null'::jsonb THEN
    v:=(a.artifact->'calibration'->>'intercept')::numeric+(a.artifact->'calibration'->>'slope')::numeric*
      ln(greatest(0.0000000001,least(0.9999999999,raw))/(1-greatest(0.0000000001,least(0.9999999999,raw))));
    cal:=1/(1+exp(-greatest(-25,least(25,v))));
  END IF;
  IF raw IS NULL OR abs(raw-NEW.raw_probability_up)>0.00000001
    OR (cal IS NULL)<>(NEW.calibrated_probability_up IS NULL)
    OR (cal IS NOT NULL AND abs(cal-NEW.calibrated_probability_up)>0.00000001) THEN
    RAISE EXCEPTION 'Forecast is not reproducible from its artifact and feature snapshot';
  END IF;
  SELECT CASE WHEN event_type='ACTIVATE' THEN artifact_id END INTO champion
    FROM waterx_research_champion_events WHERE interval_minutes=NEW.interval_minutes
      AND effective_at<=to_timestamp(NEW.decision_at_ms::double precision/1000) ORDER BY effective_at DESC,id DESC LIMIT 1;
  IF NEW.forecast_status='CHAMPION' AND champion IS DISTINCT FROM NEW.model_artifact_id THEN
    RAISE EXCEPTION 'Challenger cannot become champion without manual approval';
  END IF; RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION bluewater_result_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE f RECORD; l RECORD; y INTEGER; loss DOUBLE PRECISION;
BEGIN
  SELECT * INTO f FROM waterx_research_model_forecasts WHERE interval_minutes=NEW.interval_minutes
    AND round_id=NEW.round_id AND model_artifact_id=NEW.model_artifact_id AND lock_seconds=NEW.lock_seconds;
  SELECT * INTO l FROM waterx_learning_rounds WHERE interval_minutes=f.interval_minutes AND round_id=f.round_id
    AND start_ms=f.start_ms AND expiry_ms=f.expiry_ms;
  IF f.round_id IS NULL OR NEW.label_available_at>clock_timestamp() THEN RAISE EXCEPTION 'Model result has invalid identity or future label'; END IF;
  IF NEW.event_type='SCORED' THEN
    IF l.round_id IS NULL OR l.label_status<>'verified' OR l.settlement_disputed
      OR (l.settlement_quarantine IS NOT NULL AND l.settlement_quarantine<>'[]'::jsonb)
      OR upper(l.outcome)<>NEW.outcome OR l.first_verified_at<>NEW.label_available_at
      OR l.settled_at<=f.expiry_ms OR l.settled_at>extract(epoch FROM clock_timestamp())*1000
      OR NEW.label_available_at<=to_timestamp(f.expiry_ms::double precision/1000)
      OR l.settle_price<=0 OR l.settlement_anchor_price<=0
      OR NOT ((NEW.outcome='UP' AND l.settle_price>=l.settlement_anchor_price)
        OR (NEW.outcome='DOWN' AND l.settle_price<l.settlement_anchor_price)) THEN
      RAISE EXCEPTION 'Model result requires an exact undisputed verified WaterX settlement';
    END IF;
    y:=CASE WHEN NEW.outcome='UP' THEN 1 ELSE 0 END;
    loss:=-ln(greatest(0.0000000001,least(0.9999999999,CASE WHEN y=1 THEN f.displayed_probability_up ELSE 1-f.displayed_probability_up END)));
    IF NEW.correct<>(f.chosen_side=NEW.outcome) OR abs(NEW.brier-power(f.displayed_probability_up-y,2))>0.00000001
      OR abs(NEW.log_loss-loss)>0.00000001 THEN RAISE EXCEPTION 'Model score does not match immutable forecast'; END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM waterx_research_model_results r WHERE r.interval_minutes=NEW.interval_minutes
      AND r.round_id=NEW.round_id AND r.model_artifact_id=NEW.model_artifact_id AND r.lock_seconds=NEW.lock_seconds
      AND r.event_type='SCORED' AND r.label_available_at=NEW.label_available_at)
      OR (l.round_id IS NOT NULL AND l.label_status='verified' AND NOT l.settlement_disputed
        AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb) AND upper(l.outcome)=NEW.outcome) THEN
      RAISE EXCEPTION 'Withdrawal requires an original score and a later invalidated label';
    END IF;
  END IF; RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION bluewater_champion_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE n INTEGER; span NUMERIC; upper95 DOUBLE PRECISION; sparse INTEGER; current_id TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(76348,NEW.interval_minutes::integer);
  IF NEW.effective_at>clock_timestamp() THEN RAISE EXCEPTION 'Future champion activation forbidden'; END IF;
  NEW.effective_at:=clock_timestamp();
  SELECT CASE WHEN event_type='ACTIVATE' THEN artifact_id END INTO current_id FROM waterx_research_champion_events
    WHERE interval_minutes=NEW.interval_minutes ORDER BY effective_at DESC,id DESC LIMIT 1;
  IF NEW.event_type='WITHDRAW' THEN
    IF current_id IS DISTINCT FROM NEW.artifact_id THEN RAISE EXCEPTION 'Withdrawal must name the active champion'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.promotion_report->>'eligible' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Manual approval cannot bypass qualification'; END IF;
  WITH points AS (
    SELECT f.displayed_probability_up AS probability,f.decision_at_ms,
      power(f.displayed_probability_up-CASE WHEN upper(l.outcome)='UP' THEN 1 ELSE 0 END,2)-
      power((s.feature_snapshot->'values'->>'waterx_probability_up')::double precision-
        CASE WHEN upper(l.outcome)='UP' THEN 1 ELSE 0 END,2) AS difference
    FROM waterx_research_model_forecasts f JOIN waterx_research_feature_snapshots s USING(feature_snapshot_digest)
    JOIN waterx_research_round_policy p ON p.interval_minutes=f.interval_minutes AND p.round_id=f.round_id
      AND p.start_ms=f.start_ms AND p.expiry_ms=f.expiry_ms
    JOIN waterx_learning_rounds l ON l.interval_minutes=f.interval_minutes AND l.round_id=f.round_id
      AND l.start_ms=f.start_ms AND l.expiry_ms=f.expiry_ms
    WHERE f.interval_minutes=NEW.interval_minutes AND f.model_artifact_id=NEW.artifact_id
      AND f.lock_seconds=p.primary_lock_seconds AND f.decision_at_ms>=extract(epoch FROM clock_timestamp())*1000-1209600000
      AND l.label_status='verified' AND NOT l.settlement_disputed AND l.settled_at>f.expiry_ms
      AND l.first_verified_at<=clock_timestamp() AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb)
  )
  SELECT count(*),max(decision_at_ms)-min(decision_at_ms),avg(difference)+1.96*stddev_samp(difference)/sqrt(count(*)),
    (SELECT count(*) FROM (SELECT least(9,floor(probability*10)) AS bin FROM points GROUP BY 1 HAVING count(*)<20) b)
    INTO n,span,upper95,sparse FROM points;
  IF n<90 OR span<(CASE WHEN NEW.interval_minutes=5 THEN 172800000 ELSE 604800000 END)
    OR upper95 IS NULL OR upper95>=0 OR sparse>0
    OR NOT EXISTS(SELECT 1 FROM waterx_research_artifacts a WHERE a.artifact_id=NEW.artifact_id
      AND a.artifact->'calibration' IS NOT NULL AND a.artifact->'calibration'<>'null'::jsonb)
    OR EXISTS(SELECT 1 FROM waterx_research_model_forecasts f JOIN waterx_learning_rounds l
      USING(interval_minutes,round_id,start_ms,expiry_ms) WHERE f.model_artifact_id=NEW.artifact_id
      AND (l.settlement_disputed OR l.label_status='withheld')) THEN
    RAISE EXCEPTION 'Prospective matched evidence, calibration or integrity insufficient for champion';
  END IF;
  IF current_id IS NOT NULL THEN
    SELECT count(*),avg(d)+1.96*stddev_samp(d)/sqrt(count(*)) INTO n,upper95 FROM (
      SELECT power(f.displayed_probability_up-CASE WHEN upper(l.outcome)='UP' THEN 1 ELSE 0 END,2)-
        power(c.displayed_probability_up-CASE WHEN upper(l.outcome)='UP' THEN 1 ELSE 0 END,2) AS d
      FROM waterx_research_model_forecasts f JOIN waterx_research_model_forecasts c
        USING(interval_minutes,round_id,lock_seconds,feature_snapshot_digest)
      JOIN waterx_research_round_policy p ON p.interval_minutes=f.interval_minutes AND p.round_id=f.round_id
      JOIN waterx_learning_rounds l ON l.interval_minutes=f.interval_minutes AND l.round_id=f.round_id
        AND l.start_ms=f.start_ms AND l.expiry_ms=f.expiry_ms
      WHERE f.model_artifact_id=NEW.artifact_id AND c.model_artifact_id=current_id AND f.lock_seconds=p.primary_lock_seconds
        AND f.decision_at_ms>=extract(epoch FROM clock_timestamp())*1000-1209600000
        AND l.label_status='verified' AND NOT l.settlement_disputed
        AND l.first_verified_at<=clock_timestamp() AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb)
    ) matched;
    IF n<90 OR upper95 IS NULL OR upper95>=0 THEN RAISE EXCEPTION 'Insufficient matched improvement against active champion'; END IF;
  END IF; RETURN NEW;
END; $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['waterx_research_artifacts','waterx_research_feature_snapshots',
    'waterx_research_experiments','waterx_research_agent_reports','waterx_research_champion_events',
    'waterx_research_model_forecasts','waterx_research_model_results']
  LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname='bluewater_immutable_guard') THEN
      EXECUTE format('CREATE TRIGGER bluewater_immutable_guard BEFORE UPDATE OR DELETE ON %I
        FOR EACH ROW EXECUTE FUNCTION bluewater_evidence_immutable()',t);
    END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='waterx_research_artifacts'::regclass AND tgname='bluewater_artifact_insert') THEN
    CREATE TRIGGER bluewater_artifact_insert BEFORE INSERT ON waterx_research_artifacts FOR EACH ROW EXECUTE FUNCTION bluewater_artifact_guard();
    CREATE TRIGGER bluewater_feature_insert BEFORE INSERT ON waterx_research_feature_snapshots FOR EACH ROW EXECUTE FUNCTION bluewater_feature_guard();
    CREATE TRIGGER bluewater_forecast_insert BEFORE INSERT ON waterx_research_model_forecasts FOR EACH ROW EXECUTE FUNCTION bluewater_forecast_guard();
    CREATE TRIGGER bluewater_result_insert BEFORE INSERT ON waterx_research_model_results FOR EACH ROW EXECUTE FUNCTION bluewater_result_guard();
    CREATE TRIGGER bluewater_champion_insert BEFORE INSERT ON waterx_research_champion_events FOR EACH ROW EXECUTE FUNCTION bluewater_champion_guard();
  END IF;
END; $$;