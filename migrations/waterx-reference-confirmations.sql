-- Development-only. Additive WaterX reference provenance; never run from the
-- collector or app startup. Backfill only original observed values, never labels.
ALTER TABLE waterx_learning_rounds
  ADD COLUMN IF NOT EXISTS initial_anchor_price numeric,
  ADD COLUMN IF NOT EXISTS initial_anchor_confirmed boolean,
  ADD COLUMN IF NOT EXISTS confirmed_anchor_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS first_verified_at timestamptz;

-- Existing values are the only auditable first-observed source evidence.
UPDATE waterx_learning_rounds
   SET initial_anchor_price = anchor_price,
       initial_anchor_confirmed = anchor_confirmed
 WHERE initial_anchor_confirmed IS NULL;

CREATE TABLE IF NOT EXISTS waterx_research_reference_confirmations (
  interval_minutes smallint NOT NULL CHECK (interval_minutes IN (5, 15)),
  round_id text NOT NULL CHECK (length(btrim(round_id)) > 0),
  anchor_price numeric NOT NULL CHECK (anchor_price > 0),
  observed_at timestamptz NOT NULL,
  source_evidence jsonb NOT NULL,
  PRIMARY KEY (interval_minutes, round_id, anchor_price)
);

CREATE INDEX IF NOT EXISTS waterx_research_reference_confirmations_chronology_idx
  ON waterx_research_reference_confirmations(interval_minutes, observed_at, round_id);

-- This separate evidence ledger is append-only; corrections require a new
-- differently keyed price/evidence record, not rewriting original evidence.
CREATE OR REPLACE FUNCTION waterx_research_references_are_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'WaterX reference confirmation evidence is append-only';
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgrelid = 'waterx_research_reference_confirmations'::regclass
       AND tgname = 'waterx_research_reference_confirmations_immutable'
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER waterx_research_reference_confirmations_immutable
      BEFORE UPDATE OR DELETE ON waterx_research_reference_confirmations
      FOR EACH ROW EXECUTE FUNCTION waterx_research_references_are_append_only();
  END IF;
END
$$;