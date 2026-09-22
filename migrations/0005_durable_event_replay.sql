ALTER TABLE "accumulation_collector_checkpoints"
  ADD COLUMN IF NOT EXISTS "replay_from_checkpoint" text,
  ADD COLUMN IF NOT EXISTS "last_complete_checkpoint" text,
  ADD COLUMN IF NOT EXISTS "replay_status" text DEFAULT 'UNPROVEN' NOT NULL,
  ADD COLUMN IF NOT EXISTS "gap_count" integer DEFAULT 0 NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "accumulation_market_events_digest_sequence_uq"
  ON "accumulation_market_events" ("tx_digest", "event_id")
  WHERE "tx_digest" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "accumulation_market_events_checkpoint_idx"
  ON "accumulation_market_events" ("checkpoint");

DROP INDEX IF EXISTS "accumulation_observations_identity_uq";
CREATE INDEX IF NOT EXISTS "accumulation_observations_asset_checkpoint_idx"
  ON "accumulation_market_observations" ("asset_id", "checkpoint", "provider");