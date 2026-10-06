-- Additive development schema; production application is owned by Publish.
CREATE TABLE bluewater_execution_sessions (
 id uuid PRIMARY KEY,
 owner text NOT NULL REFERENCES bluewater_agents(owner),
 account_id text NOT NULL,
 policy_version bigint NOT NULL,
 policy jsonb NOT NULL,
 signer_permit_ref text NOT NULL,
 status text NOT NULL CHECK(status IN ('ARMED','PAUSED','STOPPED')),
 expires_at_ms bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX agent_one_armed_session ON bluewater_execution_sessions(owner) WHERE status='ARMED';
CREATE TABLE bluewater_execution_intents (
 id uuid PRIMARY KEY,
 session_id uuid NOT NULL REFERENCES bluewater_execution_sessions(id),
 owner text NOT NULL REFERENCES bluewater_agents(owner),
 decision_id uuid NOT NULL REFERENCES waterx_timed_decisions(id),
 round_id text NOT NULL,
 interval_minutes smallint NOT NULL CHECK(interval_minutes IN (5,15)),
 start_ms bigint NOT NULL,
 expiry_ms bigint NOT NULL,
 account_id text NOT NULL,
 policy_version bigint NOT NULL,
 reserved_cents bigint NOT NULL CHECK(reserved_cents>0),
 reserved_gas_mist bigint NOT NULL CHECK(reserved_gas_mist>0),
 status text NOT NULL CHECK(status IN ('RESERVED','PREPARED','UNKNOWN','ACCEPTED','FILLED','SETTLED','CLAIMED','REJECTED','UNFILLED')),
 transaction_bytes text,
 transaction_digest text,
 signer_execution_ref text,
 order_id text,
 position_id text,
 proof jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner,decision_id),
 CHECK(expiry_ms-start_ms=interval_minutes*60000),
 CHECK(status NOT IN ('UNKNOWN','ACCEPTED','FILLED','SETTLED','CLAIMED') OR transaction_digest IS NOT NULL)
);
CREATE INDEX agent_intent_reconciliation ON bluewater_execution_intents(status,updated_at);
CREATE INDEX agent_wallet_round_exposure ON bluewater_execution_intents(owner,interval_minutes,round_id,start_ms,expiry_ms);
