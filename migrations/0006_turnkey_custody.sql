ALTER TABLE "accumulation_agent_wallets"
  ADD COLUMN IF NOT EXISTS "signer_provider" text,
  ADD COLUMN IF NOT EXISTS "signer_wallet_id" text,
  ADD COLUMN IF NOT EXISTS "signer_public_key" text;

CREATE UNIQUE INDEX IF NOT EXISTS "accumulation_agent_wallets_address_uq"
  ON "accumulation_agent_wallets" ("agent_address")
  WHERE "agent_address" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "accumulation_agent_wallets_signer_wallet_uq"
  ON "accumulation_agent_wallets" ("signer_wallet_id")
  WHERE "signer_wallet_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "accumulation_custody_audit_events" (
  "id" text PRIMARY KEY NOT NULL,
  "agent_id" text NOT NULL REFERENCES "accumulation_agent_wallets"("id"),
  "owner_address" text NOT NULL,
  "event_type" text NOT NULL,
  "policy_version" text NOT NULL,
  "request_hash" text,
  "outcome" text NOT NULL,
  "evidence" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "accumulation_custody_audit_agent_idx"
  ON "accumulation_custody_audit_events" ("agent_id", "created_at");