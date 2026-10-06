-- Additive development migration. Production rollout requires a verified backup/restore.
BEGIN;
CREATE TABLE waterx_timed_rounds (
 network TEXT NOT NULL CHECK(network='sui:mainnet'),
 strategy_version TEXT NOT NULL,
 interval_minutes SMALLINT NOT NULL CHECK(interval_minutes IN (5,15)),
 round_id TEXT NOT NULL,start_ms BIGINT NOT NULL,expiry_ms BIGINT NOT NULL,
 discovered_at_ms BIGINT NOT NULL,
 PRIMARY KEY(network,strategy_version,interval_minutes,round_id),
 CHECK(expiry_ms-start_ms=interval_minutes*60000)
);
CREATE TABLE waterx_timed_decisions (
 id UUID PRIMARY KEY,network TEXT NOT NULL,strategy_version TEXT NOT NULL,
 interval_minutes SMALLINT NOT NULL,round_id TEXT NOT NULL,
 decision_at_ms BIGINT NOT NULL, status TEXT NOT NULL CHECK(status IN ('LOCKED','NO_VALID_INPUT','MISSED_DEADLINE')),
 decision JSONB NOT NULL,
 UNIQUE(network,strategy_version,interval_minutes,round_id),
 FOREIGN KEY(network,strategy_version,interval_minutes,round_id)
 REFERENCES waterx_timed_rounds(network,strategy_version,interval_minutes,round_id)
);
CREATE TABLE waterx_timed_observations (
 network TEXT NOT NULL,strategy_version TEXT NOT NULL,interval_minutes SMALLINT NOT NULL,round_id TEXT NOT NULL,
 received_at_ms BIGINT NOT NULL,input JSONB NOT NULL,
 PRIMARY KEY(network,strategy_version,interval_minutes,round_id,received_at_ms),
 FOREIGN KEY(network,strategy_version,interval_minutes,round_id)
 REFERENCES waterx_timed_rounds(network,strategy_version,interval_minutes,round_id)
);
CREATE TABLE waterx_timed_outbox (
 decision_id UUID PRIMARY KEY REFERENCES waterx_timed_decisions(id),
 committed_ack_at_ms BIGINT,worker_received_at_ms BIGINT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION waterx_timed_decision_immutable() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'Timed research decisions are immutable' USING ERRCODE='23514'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER waterx_timed_decision_immutable BEFORE UPDATE OR DELETE ON waterx_timed_decisions
 FOR EACH ROW EXECUTE FUNCTION waterx_timed_decision_immutable();
CREATE UNIQUE INDEX bluewater_agent_timed_hold_once ON bluewater_agent_ledger(owner,round_key)
 WHERE event='WOULD_HOLD' AND round_key LIKE 'timed:%';
COMMIT;
