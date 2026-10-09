-- Development migration only. Publish handles production schema after backup review.
ALTER TABLE waterx_two_stage_rounds ADD COLUMN IF NOT EXISTS capture_build_id text NOT NULL DEFAULT 'LEGACY_UNKNOWN';
CREATE TABLE IF NOT EXISTS waterx_two_stage_prices(
 network text NOT NULL,market_id text NOT NULL,round_id text NOT NULL,interval_minutes integer NOT NULL,
 strategy_version text NOT NULL,point_id text NOT NULL,source_at_ms bigint NOT NULL,
 available_at_ms bigint NOT NULL,point jsonb NOT NULL,
 PRIMARY KEY(network,market_id,round_id,interval_minutes,strategy_version,point_id),
 FOREIGN KEY(network,market_id,round_id,interval_minutes,strategy_version)
 REFERENCES waterx_two_stage_rounds(network,market_id,round_id,interval_minutes,strategy_version));
CREATE INDEX IF NOT EXISTS waterx_two_stage_prices_round_time ON waterx_two_stage_prices
 (strategy_version,interval_minutes,round_id,source_at_ms);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='waterx_two_stage_prices_immutable') THEN
 CREATE TRIGGER waterx_two_stage_prices_immutable BEFORE UPDATE OR DELETE ON waterx_two_stage_prices
 FOR EACH ROW EXECUTE FUNCTION waterx_two_stage_immutable(); END IF;
END $$;
