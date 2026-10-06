-- Development correction only. Publish transfers the resulting schema normally.
-- Changes future defaults, not existing acceptance timestamps or stored inputs.
ALTER TABLE waterx_timed_observations ALTER COLUMN accepted_at_ms
 SET DEFAULT floor(extract(epoch FROM clock_timestamp())/0.001)::bigint;
