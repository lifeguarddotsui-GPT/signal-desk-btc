-- Development-only additive WaterX chart archive. Apply manually to the
-- development database only. Never alters, backfills, or deletes legacy rows.
CREATE TABLE IF NOT EXISTS waterx_comparison_ticks (
  id bigserial PRIMARY KEY,
  source_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  price numeric NOT NULL CHECK (price > 0),
  source text NOT NULL,
  event_id text,
  source_to_server_latency_ms integer,
  CHECK (source_to_server_latency_ms IS NULL OR source_to_server_latency_ms >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS waterx_comparison_ticks_event_id_uidx
  ON waterx_comparison_ticks(event_id)
  WHERE event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS waterx_comparison_ticks_source_fallback_uidx
  ON waterx_comparison_ticks(source_at, price, source)
  WHERE event_id IS NULL;

CREATE INDEX IF NOT EXISTS waterx_comparison_ticks_source_at_idx
  ON waterx_comparison_ticks(source_at, id);