-- Preserve old-policy schedules; admit only 30s gates strictly before v3 expiry.
BEGIN;
DO $$ DECLARE n text; BEGIN
 SELECT conname INTO STRICT n FROM pg_constraint
 WHERE conrelid='waterx_early_horizons'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%horizon_seconds%'
 AND pg_get_constraintdef(oid) LIKE '%ANY%';
 EXECUTE format('ALTER TABLE waterx_early_horizons DROP CONSTRAINT %I',n);
END $$;
ALTER TABLE waterx_early_horizons ADD CONSTRAINT horizon_policy_schedule
 CHECK((strategy_version='waterx-qualification-gates-v3' AND horizon_seconds>=30
   AND horizon_seconds%30=0 AND horizon_seconds<interval_minutes*60)
 OR(strategy_version<>'waterx-qualification-gates-v3' AND
   ((interval_minutes=5 AND horizon_seconds IN(30,45,60,75,90))
     OR(interval_minutes=15 AND horizon_seconds IN(60,120,180,240,300)))));
COMMIT;
