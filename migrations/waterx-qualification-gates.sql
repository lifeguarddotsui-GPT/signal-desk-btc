-- Additive policy rollout. Never alter old immutable decisions; production backup gate applies.
BEGIN;
ALTER TABLE waterx_timed_observations ADD COLUMN accepted_at_ms bigint NOT NULL
 -- Decimal division preserves floor-to-milliseconds without an internal cast
 -- that publish-time default introspection can truncate.
 DEFAULT floor(extract(epoch FROM clock_timestamp())/0.001)::bigint;
DO $$ DECLARE n text; BEGIN
 SELECT conname INTO STRICT n FROM pg_constraint
 WHERE conrelid='waterx_timed_decisions'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%status%';
 EXECUTE format('ALTER TABLE waterx_timed_decisions DROP CONSTRAINT %I',n);
END $$;
ALTER TABLE waterx_timed_decisions ADD CONSTRAINT timed_decision_status_versions
 CHECK(status IN('LOCKED','NO_VALID_INPUT','MISSED_DEADLINE','ABSTAINED_NO_QUALIFIED_SIGNAL','DATA_FAILURE'));
CREATE TABLE waterx_gate_journals(
 network text NOT NULL CHECK(network='sui:mainnet'),strategy_version text NOT NULL,
 interval_minutes smallint NOT NULL CHECK(interval_minutes IN(5,15)),round_id text NOT NULL,
 gate_index integer NOT NULL CHECK(gate_index>0),scheduled_at_ms bigint NOT NULL,
 evaluated_at_ms bigint NOT NULL,evidence_cutoff_ms bigint NOT NULL,
 result text NOT NULL CHECK(result IN('QUALIFIED','WAIT_WEAK_EVIDENCE','WAIT_UNSTABLE','WAIT_FRESH_DATA',
   'INVALID_ROUND','MISSED_GATE','EXECUTION_WINDOW_CLOSED')),
 decision_id uuid REFERENCES waterx_timed_decisions(id),journal jsonb NOT NULL,
 PRIMARY KEY(network,strategy_version,interval_minutes,round_id,gate_index),
 FOREIGN KEY(network,strategy_version,interval_minutes,round_id)
 REFERENCES waterx_timed_rounds(network,strategy_version,interval_minutes,round_id),
 CHECK(evidence_cutoff_ms=scheduled_at_ms),CHECK(evaluated_at_ms>=scheduled_at_ms)
);
CREATE TRIGGER waterx_gate_journal_immutable BEFORE UPDATE OR DELETE ON waterx_gate_journals
 FOR EACH ROW EXECUTE FUNCTION waterx_timed_decision_immutable();
CREATE INDEX waterx_gate_recent ON waterx_gate_journals(strategy_version,interval_minutes,scheduled_at_ms DESC);
COMMIT;
