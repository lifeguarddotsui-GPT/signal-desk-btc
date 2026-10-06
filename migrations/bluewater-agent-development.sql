BEGIN;
CREATE TABLE IF NOT EXISTS bluewater_agents (
  owner text PRIMARY KEY, status text NOT NULL DEFAULT 'PAUSED' CHECK(status IN ('PAUSED','SHADOW','LOSS_STOP','TARGET_REACHED')),
  policy_version bigint NOT NULL DEFAULT 1, policy jsonb NOT NULL,
  account_id text, delegate_address text, delegate_expires_at_ms bigint,
  paper jsonb, revision bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS bluewater_agent_policies (
  owner text NOT NULL REFERENCES bluewater_agents(owner), version bigint NOT NULL,
  policy jsonb NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner,version)
);
CREATE TABLE IF NOT EXISTS bluewater_agent_ledger (
  id bigserial PRIMARY KEY, owner text NOT NULL REFERENCES bluewater_agents(owner),
  event text NOT NULL, policy_version bigint NOT NULL, round_key text,
  details jsonb NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS bluewater_agent_ledger_owner ON bluewater_agent_ledger(owner,id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS bluewater_agent_round_once ON bluewater_agent_ledger(owner,round_key)
  WHERE event='EXECUTION_CANDIDATE';
CREATE TABLE IF NOT EXISTS bluewater_agent_sessions (
  token_hash text PRIMARY KEY, owner text NOT NULL REFERENCES bluewater_agents(owner),
  expires_at timestamptz NOT NULL,
  network text NOT NULL DEFAULT 'testnet' CHECK (network IN ('testnet','mainnet'))
);
CREATE TABLE IF NOT EXISTS bluewater_agent_execution_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton IS TRUE), disabled boolean NOT NULL DEFAULT true
);
INSERT INTO bluewater_agent_execution_control(singleton,disabled) VALUES(true,true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS bluewater_agent_control_audit (
  id bigserial PRIMARY KEY, disabled boolean NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION bluewater_agent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Agent policy and audit evidence are append-only'; END $$;
DROP TRIGGER IF EXISTS immutable_agent_policy ON bluewater_agent_policies;
CREATE TRIGGER immutable_agent_policy BEFORE UPDATE OR DELETE ON bluewater_agent_policies FOR EACH ROW EXECUTE FUNCTION bluewater_agent_immutable();
DROP TRIGGER IF EXISTS immutable_agent_ledger ON bluewater_agent_ledger;
CREATE TRIGGER immutable_agent_ledger BEFORE UPDATE OR DELETE ON bluewater_agent_ledger FOR EACH ROW EXECUTE FUNCTION bluewater_agent_immutable();
DROP TRIGGER IF EXISTS immutable_agent_control ON bluewater_agent_control_audit;
CREATE TRIGGER immutable_agent_control BEFORE UPDATE OR DELETE ON bluewater_agent_control_audit FOR EACH ROW EXECUTE FUNCTION bluewater_agent_immutable();
COMMIT;