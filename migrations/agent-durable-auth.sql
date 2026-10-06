BEGIN;
CREATE TABLE bluewater_agent_challenges(
 token_hash text PRIMARY KEY CHECK(length(token_hash)=64),
 owner text NOT NULL,origin text NOT NULL,network text NOT NULL CHECK(network='sui:mainnet'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,consumed_at timestamptz,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '3 minutes')
);
CREATE INDEX bluewater_agent_challenge_expiry ON bluewater_agent_challenges(expires_at);
COMMIT;
