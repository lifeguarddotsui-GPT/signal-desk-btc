-- Additive shadow-only data. No legacy records are replaced or reinterpreted.
CREATE TABLE IF NOT EXISTS waterx_two_stage_rounds (
 network text NOT NULL,market_id text NOT NULL,round_id text NOT NULL,interval_minutes integer NOT NULL CHECK(interval_minutes IN(5,15)),
 strategy_version text NOT NULL,start_ms bigint NOT NULL,expiry_ms bigint NOT NULL,discovered_at_ms bigint NOT NULL,
 capture_mode text NOT NULL CHECK(capture_mode IN('PROSPECTIVE','SYNTHETIC')),
 PRIMARY KEY(network,market_id,round_id,interval_minutes,strategy_version),
 CHECK(expiry_ms-start_ms=interval_minutes*60000));
CREATE TABLE IF NOT EXISTS waterx_two_stage_observations (
 network text NOT NULL,market_id text NOT NULL,round_id text NOT NULL,interval_minutes integer NOT NULL,strategy_version text NOT NULL,
 observation_id text NOT NULL,received_at_ms bigint NOT NULL,available_at_ms bigint NOT NULL,input jsonb NOT NULL,
 PRIMARY KEY(network,market_id,round_id,interval_minutes,strategy_version,observation_id),
 FOREIGN KEY(network,market_id,round_id,interval_minutes,strategy_version)
 REFERENCES waterx_two_stage_rounds(network,market_id,round_id,interval_minutes,strategy_version));
CREATE TABLE IF NOT EXISTS waterx_two_stage_locks (
 id uuid PRIMARY KEY,network text NOT NULL,market_id text NOT NULL,round_id text NOT NULL,interval_minutes integer NOT NULL,strategy_version text NOT NULL,
 lock_stage text NOT NULL CHECK(lock_stage IN('EARLY','CONFIRMATION')),decision jsonb NOT NULL,
 UNIQUE(network,market_id,round_id,interval_minutes,strategy_version,lock_stage),
 FOREIGN KEY(network,market_id,round_id,interval_minutes,strategy_version)
 REFERENCES waterx_two_stage_rounds(network,market_id,round_id,interval_minutes,strategy_version),
 CHECK(decision->>'stage'=lock_stage),CHECK(decision->>'roundId'=round_id),
 CHECK(decision->>'marketId'=market_id),CHECK((decision->>'automaticExecutionAllowed')::boolean=false),
 CHECK((decision->>'shadowOnly')::boolean=true));
CREATE TABLE IF NOT EXISTS waterx_two_stage_outbox (
 decision_id uuid PRIMARY KEY REFERENCES waterx_two_stage_locks(id),committed_ack_at_ms bigint,
 event_type text NOT NULL DEFAULT 'SHADOW_STAGE_COMMITTED' CHECK(event_type='SHADOW_STAGE_COMMITTED'));
CREATE TABLE IF NOT EXISTS waterx_two_stage_assessments (
 network text NOT NULL,market_id text NOT NULL,round_id text NOT NULL,interval_minutes integer NOT NULL,strategy_version text NOT NULL,
 stage text NOT NULL CHECK(stage IN('EARLY','CONFIRMATION')),at_ms bigint NOT NULL,reason text NOT NULL,
 data_failure boolean NOT NULL DEFAULT false,
 PRIMARY KEY(network,market_id,round_id,interval_minutes,strategy_version,stage));
CREATE TABLE IF NOT EXISTS waterx_two_stage_training (
 id uuid PRIMARY KEY,interval_minutes integer NOT NULL CHECK(interval_minutes IN(5,15)),
 created_at_ms bigint NOT NULL,dataset_digest text NOT NULL,report jsonb NOT NULL,
 UNIQUE(interval_minutes,dataset_digest));
CREATE OR REPLACE FUNCTION waterx_two_stage_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'two-stage prediction/observation evidence is immutable'; END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='waterx_two_stage_lock_immutable') THEN
 CREATE TRIGGER waterx_two_stage_lock_immutable BEFORE UPDATE OR DELETE ON waterx_two_stage_locks
 FOR EACH ROW EXECUTE FUNCTION waterx_two_stage_immutable(); END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='waterx_two_stage_observation_immutable') THEN
 CREATE TRIGGER waterx_two_stage_observation_immutable BEFORE UPDATE OR DELETE ON waterx_two_stage_observations
 FOR EACH ROW EXECUTE FUNCTION waterx_two_stage_immutable(); END IF;
END $$;
