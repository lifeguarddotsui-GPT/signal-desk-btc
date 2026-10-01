CREATE TABLE IF NOT EXISTS "accumulation_collector_checkpoints" (
  "collector_name" text PRIMARY KEY NOT NULL,
  "source" text NOT NULL,
  "status" text DEFAULT 'STARTING' NOT NULL,
  "last_checkpoint" text,
  "provider_event_count" text,
  "collected_observation_count" integer DEFAULT 0 NOT NULL,
  "verified_asset_count" integer DEFAULT 0 NOT NULL,
  "started_at" timestamp DEFAULT now() NOT NULL,
  "last_success_at" timestamp,
  "last_error" text,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "accumulation_owner_sessions" (
  "sid" text PRIMARY KEY NOT NULL,
  "sess" json NOT NULL,
  "expire" timestamp NOT NULL
);
CREATE INDEX IF NOT EXISTS "accumulation_owner_sessions_expire_idx"
  ON "accumulation_owner_sessions" ("expire");