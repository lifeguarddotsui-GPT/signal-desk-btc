CREATE TABLE IF NOT EXISTS "accumulation_wallet_auth_challenges" (
  "nonce_hash" text PRIMARY KEY NOT NULL,
  "session_hash" text NOT NULL,
  "wallet_address" text NOT NULL,
  "message" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "consumed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "accumulation_wallet_auth_challenges_session_idx"
  ON "accumulation_wallet_auth_challenges" ("session_hash");
CREATE INDEX IF NOT EXISTS "accumulation_wallet_auth_challenges_expiry_idx"
  ON "accumulation_wallet_auth_challenges" ("expires_at");