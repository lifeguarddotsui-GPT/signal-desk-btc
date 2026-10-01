CREATE TABLE IF NOT EXISTS "accumulation_protocol_manifests" (
  "id" text PRIMARY KEY NOT NULL, "network" text NOT NULL, "package_id" text NOT NULL,
  "defining_package_id" text, "version" text NOT NULL, "manifest" jsonb NOT NULL,
  "checksum" text NOT NULL, "status" text DEFAULT 'UNRESOLVED' NOT NULL,
  "valid_from_checkpoint" text, "evidence_digests" jsonb NOT NULL,
  "verified_at" timestamp, "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "accumulation_candidate_rankings" (
  "id" text PRIMARY KEY NOT NULL, "asset_id" text NOT NULL REFERENCES "accumulation_assets"("id"),
  "checkpoint" text NOT NULL, "strategy_version" text NOT NULL, "score" integer NOT NULL,
  "components" jsonb NOT NULL, "hard_vetoes" jsonb NOT NULL, "snapshot" jsonb NOT NULL,
  "ranked_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "accumulation_candidate_rankings_repro_uq"
  ON "accumulation_candidate_rankings" ("asset_id","checkpoint","strategy_version");
CREATE TABLE IF NOT EXISTS "accumulation_agent_wallets" (
  "id" text PRIMARY KEY NOT NULL, "campaign_id" text NOT NULL REFERENCES "accumulation_campaigns"("id"),
  "owner_address" text NOT NULL, "agent_address" text, "signer_key_reference" text,
  "mode" text DEFAULT 'PAPER' NOT NULL, "status" text DEFAULT 'PAPER_ACTIVE' NOT NULL,
  "risk_policy_version" text DEFAULT 'canary-v1' NOT NULL, "withdrawal_address" text NOT NULL,
  "armed_at" timestamp, "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "accumulation_agent_wallets_campaign_uq" ON "accumulation_agent_wallets" ("campaign_id");
CREATE INDEX IF NOT EXISTS "accumulation_agent_wallets_owner_idx" ON "accumulation_agent_wallets" ("owner_address");
CREATE TABLE IF NOT EXISTS "accumulation_execution_records" (
  "id" text PRIMARY KEY NOT NULL, "campaign_id" text NOT NULL REFERENCES "accumulation_campaigns"("id"),
  "decision_id" text REFERENCES "accumulation_decisions"("id"), "asset_id" text REFERENCES "accumulation_assets"("id"),
  "kind" text NOT NULL, "state" text NOT NULL, "idempotency_key" text UNIQUE NOT NULL,
  "transaction_hash" text, "transaction_digest" text, "checkpoint" text,
  "evidence" jsonb NOT NULL, "failure_code" text,
  "created_at" timestamp DEFAULT now() NOT NULL, "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "accumulation_collector_dead_letters" (
  "id" text PRIMARY KEY NOT NULL, "collector_name" text NOT NULL, "checkpoint" text,
  "source_id" text, "error_code" text NOT NULL, "payload" jsonb NOT NULL,
  "attempts" integer DEFAULT 1 NOT NULL, "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);