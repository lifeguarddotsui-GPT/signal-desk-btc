-- DEVELOPMENT ONLY. Legacy sessions remain testnet and cannot authenticate
-- mainnet endpoints. Existing wallet policies/account links are not rewritten.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.bluewater_agent_sessions
  ADD COLUMN IF NOT EXISTS network text NOT NULL DEFAULT 'testnet'
    CHECK (network IN ('testnet','mainnet'));
COMMIT;