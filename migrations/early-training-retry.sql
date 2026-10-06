-- Preserve failed attempts; explicit retry creates a new audit row.
BEGIN;
ALTER TABLE waterx_early_training_jobs ADD COLUMN attempt integer NOT NULL DEFAULT 1 CHECK(attempt>0);
DO $$ DECLARE constraint_name text; BEGIN
 SELECT c.conname INTO STRICT constraint_name FROM pg_constraint c
 WHERE c.conrelid='waterx_early_training_jobs'::regclass AND c.contype='u'
 AND (SELECT array_agg(a.attname::text ORDER BY k.ordinality)
   FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ordinality)
   JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum)
   =ARRAY['day','interval_minutes','strategy_version'];
 EXECUTE format('ALTER TABLE waterx_early_training_jobs DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE waterx_early_training_jobs ADD CONSTRAINT waterx_early_training_attempt_unique
 UNIQUE(day,interval_minutes,strategy_version,attempt);
COMMIT;
