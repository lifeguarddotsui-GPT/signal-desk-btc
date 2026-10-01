BEGIN;

CREATE TABLE IF NOT EXISTS accumulation_campaigns (
  id text PRIMARY KEY,
  name text NOT NULL,
  network text NOT NULL DEFAULT 'mainnet',
  mode text NOT NULL DEFAULT 'OBSERVE',
  status text NOT NULL DEFAULT 'active',
  owner_address text,
  agent_address text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accumulation_bot_policies (
  id text PRIMARY KEY,
  campaign_id text NOT NULL REFERENCES accumulation_campaigns(id),
  version text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  config jsonb NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT accumulation_bot_policies_campaign_version_uq UNIQUE (campaign_id, version)
);

CREATE TABLE IF NOT EXISTS accumulation_assets (
  id text PRIMARY KEY,
  network text NOT NULL DEFAULT 'mainnet',
  coin_type text NOT NULL,
  package_id text NOT NULL DEFAULT '',
  curve_id text NOT NULL DEFAULT '',
  symbol text,
  status text NOT NULL DEFAULT 'observed',
  metadata jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS accumulation_assets_identity_uq
  ON accumulation_assets(network, coin_type, package_id, curve_id);

CREATE TABLE IF NOT EXISTS accumulation_market_observations (
  id text PRIMARY KEY,
  asset_id text NOT NULL REFERENCES accumulation_assets(id),
  checkpoint text NOT NULL,
  observed_at timestamp NOT NULL,
  received_at timestamp NOT NULL DEFAULT now(),
  provider text NOT NULL,
  coverage_status text NOT NULL DEFAULT 'UNKNOWN',
  data jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS accumulation_observations_identity_uq
  ON accumulation_market_observations(asset_id, checkpoint, provider);
CREATE INDEX IF NOT EXISTS accumulation_observations_checkpoint_idx
  ON accumulation_market_observations(checkpoint);

CREATE TABLE IF NOT EXISTS accumulation_market_events (
  id text PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  asset_id text REFERENCES accumulation_assets(id),
  checkpoint text NOT NULL,
  event_type text NOT NULL,
  tx_digest text,
  provider text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamp NOT NULL,
  received_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accumulation_decisions (
  id text PRIMARY KEY,
  campaign_id text NOT NULL REFERENCES accumulation_campaigns(id),
  asset_id text REFERENCES accumulation_assets(id),
  decision_key text NOT NULL UNIQUE,
  policy_version text NOT NULL,
  action text NOT NULL,
  feature_snapshot jsonb NOT NULL,
  quote jsonb,
  cost_model jsonb,
  rejection_reasons jsonb NOT NULL,
  outcome text NOT NULL DEFAULT 'PENDING',
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accumulation_positions (
  id text PRIMARY KEY,
  campaign_id text NOT NULL REFERENCES accumulation_campaigns(id),
  asset_id text NOT NULL REFERENCES accumulation_assets(id),
  units_base text NOT NULL DEFAULT '0',
  cost_mist text NOT NULL DEFAULT '0',
  realized_mist text NOT NULL DEFAULT '0',
  status text NOT NULL DEFAULT 'OPEN',
  opened_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT accumulation_positions_campaign_asset_uq UNIQUE (campaign_id, asset_id)
);

CREATE TABLE IF NOT EXISTS accumulation_ledger_entries (
  id text PRIMARY KEY,
  campaign_id text NOT NULL REFERENCES accumulation_campaigns(id),
  idempotency_key text NOT NULL UNIQUE,
  entry_type text NOT NULL,
  sui_mist text NOT NULL DEFAULT '0',
  token_amount_base text,
  asset_id text REFERENCES accumulation_assets(id),
  reference_type text,
  reference_id text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accumulation_worker_leases (
  id text PRIMARY KEY,
  worker_name text NOT NULL UNIQUE,
  fencing_token text NOT NULL,
  holder text NOT NULL,
  expires_at timestamp NOT NULL,
  renewed_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accumulation_research_snapshots (
  id text PRIMARY KEY,
  snapshot_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'UNAVAILABLE',
  evidence jsonb NOT NULL,
  captured_at timestamp NOT NULL DEFAULT now(),
  expires_at timestamp
);

CREATE TABLE IF NOT EXISTS accumulation_policy_proposals (
  id text PRIMARY KEY,
  campaign_id text REFERENCES accumulation_campaigns(id),
  idempotency_key text NOT NULL UNIQUE,
  proposed_version text NOT NULL,
  proposal jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_REVIEW',
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accumulation_withdrawals (
  id text PRIMARY KEY,
  campaign_id text NOT NULL REFERENCES accumulation_campaigns(id),
  idempotency_key text NOT NULL UNIQUE,
  destination_address text NOT NULL,
  amount_mist text NOT NULL DEFAULT '0',
  status text NOT NULL DEFAULT 'BLOCKED',
  reason text,
  created_at timestamp NOT NULL DEFAULT now()
);

COMMIT;