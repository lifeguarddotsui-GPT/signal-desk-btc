-- Additive development schema. Production requires backup/isolated restore review.
BEGIN;
CREATE TABLE waterx_early_horizons (
 network text NOT NULL CHECK(network='sui:mainnet'),strategy_version text NOT NULL,
 interval_minutes smallint NOT NULL CHECK(interval_minutes IN(5,15)),round_id text NOT NULL,
 start_ms bigint NOT NULL,expiry_ms bigint NOT NULL,horizon_seconds integer NOT NULL,
 scheduled_at_ms bigint NOT NULL,frozen_at_ms bigint NOT NULL,
 status text NOT NULL CHECK(status IN('FROZEN','DATA_FAILURE','MISSED_HORIZON')),
 snapshot jsonb NOT NULL,snapshot_sha256 text NOT NULL CHECK(length(snapshot_sha256)=64),
 PRIMARY KEY(network,strategy_version,interval_minutes,round_id,horizon_seconds),
 FOREIGN KEY(network,strategy_version,interval_minutes,round_id)
   REFERENCES waterx_timed_rounds(network,strategy_version,interval_minutes,round_id),
 CHECK(expiry_ms-start_ms=interval_minutes*60000),
 CHECK(scheduled_at_ms=start_ms+horizon_seconds*1000),
 CHECK(frozen_at_ms>=scheduled_at_ms),
 CHECK(status<>'FROZEN' OR frozen_at_ms<=scheduled_at_ms+2000),
 CHECK((interval_minutes=5 AND horizon_seconds IN(30,45,60,75,90))
   OR(interval_minutes=15 AND horizon_seconds IN(60,120,180,240,300)))
);
CREATE TRIGGER waterx_early_horizon_immutable BEFORE UPDATE OR DELETE ON waterx_early_horizons
 FOR EACH ROW EXECUTE FUNCTION waterx_timed_decision_immutable();
CREATE INDEX waterx_early_horizon_cohort ON waterx_early_horizons(interval_minutes,start_ms,horizon_seconds);
CREATE TABLE waterx_early_training_jobs (
 id uuid PRIMARY KEY,day date NOT NULL,interval_minutes smallint NOT NULL CHECK(interval_minutes IN(5,15)),
 strategy_version text NOT NULL,started_at_ms bigint NOT NULL,finished_at_ms bigint,
 dataset_cutoff_ms bigint NOT NULL,status text NOT NULL CHECK(status IN('RUNNING','INSUFFICIENT','EVALUATED','FAILED')),
 report jsonb,error_class text,
 UNIQUE(day,interval_minutes,strategy_version)
);
COMMIT;
