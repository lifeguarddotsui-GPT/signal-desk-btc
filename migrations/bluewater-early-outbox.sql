-- Additive DEVELOPMENT migration. Publish/production requires the backup and schema review gate.
BEGIN;
CREATE TABLE bluewater_early_outbox (
 id BIGSERIAL PRIMARY KEY,
 network TEXT NOT NULL DEFAULT 'sui:mainnet' CHECK(network='sui:mainnet'),
 interval_minutes SMALLINT NOT NULL,
 round_id TEXT NOT NULL,
 checkpoint_seconds SMALLINT NOT NULL DEFAULT 0 CHECK(checkpoint_seconds=0),
 event_type TEXT NOT NULL DEFAULT 'EARLY_RESEARCH_DECISION_SAVED' CHECK(event_type='EARLY_RESEARCH_DECISION_SAVED'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 worker_received_at_ms BIGINT,
 UNIQUE(network,interval_minutes,round_id),
 FOREIGN KEY(interval_minutes,round_id,checkpoint_seconds)
 REFERENCES bluewater_lock_candidates(interval_minutes,round_id,checkpoint_seconds)
);
COMMIT;
