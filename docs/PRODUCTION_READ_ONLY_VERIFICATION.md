# Blue Water production pre-release verification — read-only, October 16, 2026

This document is for the owner's **authenticated Replit production database console**. The GitHub connector can modify code, but does not provide access to production PostgreSQL queries, production backups or Replit's itemized billing. Neither the six passing CI jobs nor the public app's published status proves those live conditions.

**Never paste passwords, production DATABASE_URL, wallet signing secrets, API tokens, or private row contents in chat.** Do not use development database as a substitute. Don't click Restore/Regenerate/Remove database.

## Safe database schema check (read-only)

In Replit's production database query console, run **one** query at a time. This first query reports just names of the required tables; it does not copy row contents:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = current_schema()
AND table_name IN (
  'waterx_timed_rounds','waterx_timed_decisions','waterx_timed_outbox',
  'waterx_two_stage_rounds','waterx_two_stage_locks',
  'waterx_two_stage_outbox','waterx_two_stage_assessments',
  'waterx_research_choices','waterx_learning_rounds'
)
ORDER BY table_name;
```

Expected **nine table names**. If one is missing, stop; do NOT run a migration without the full backup/restore and approval gates. The new API assumes them all.

Second, report approximate per-table storage without doing expensive `count(*)` table scans:

```sql
SELECT s.relname AS table_name,
       s.n_live_tup AS estimated_rows,
       pg_size_pretty(pg_total_relation_size(s.relid)) AS total_with_indexes
FROM pg_stat_user_tables s
WHERE s.relname IN (
  'waterx_timed_rounds','waterx_timed_decisions','waterx_timed_outbox',
  'waterx_two_stage_rounds','waterx_two_stage_locks',
  'waterx_two_stage_outbox','waterx_two_stage_assessments',
  'waterx_research_choices','waterx_learning_rounds'
)
ORDER BY s.relname;
```

Estimated counts are approximate and not sufficient for computing accuracy.

Third, verify only the columns used by the history projection (metadata, not private content):

```sql
SELECT table_name,column_name,data_type
FROM information_schema.columns
WHERE table_schema=current_schema() AND (
  (table_name='waterx_learning_rounds' AND column_name IN
    ('first_verified_at','settlement_quarantine','settlement_disputed',
     'settled_at','settle_price','settlement_anchor_price','label_status'))
  OR (table_name='waterx_two_stage_rounds' AND column_name IN
    ('market_id','start_ms','expiry_ms','capture_mode','strategy_version'))
  OR (table_name='waterx_timed_outbox' AND column_name IN ('committed_ack_at_ms'))
  OR (table_name='waterx_two_stage_outbox' AND column_name IN ('committed_ack_at_ms'))
)
ORDER BY table_name,column_name;
```

Do not run `EXPLAIN ANALYZE` on a large production table just to confirm readiness. GitHub CI runs the actual query and `EXPLAIN (ANALYZE, BUFFERS)` in a disposable postgres:16 instance using the repository's migration files. The exact **production data and indexes** still need independent assessment; an owner-administered `EXPLAIN` without `ANALYZE` is safe to plan later if required.

## Verify visitor-only idle compute / billing

1. Close every tab displaying `bluewaterai.app`. Wait 2 minutes; the software's 45s visitor lease and 5s sweep should expire (unless another browser has an active page).
2. Open **only** https://bluewaterai.app/api/visitor/status to view the passive endpoint. Expected `activeVisitors:0`, `collecting:false`, `ready:false`. Do not open the main dashboard while testing idle.
3. In Replit **Usage → Per project → Blue Water Agents → Storage**, look at the **full** resource label and dollars for production database compute on idle days. Compare the increase in billed active hours between equivalent periods with and without web visits; usage reporting can lag.
4. Check whether other Replit deployments or cron/external collectors share this database. Passive `visitor/status` cannot detect other independent processes.
5. Verify a recoverable production database backup **and a tested restore**, without sharing credentials or destructive restores into production. Source Git branches alone are not backups of DB rows.
6. If the idle status is correct but compute still accrues, postpone this release and identify all database clients before altering scaling or collector ownership.

## Release plan

- The active website remains on the visitor-only branch; the proposed next source is `feat/confirmation-lineage-20261016` in draft PR #12, stacked on PR #11. No uncontrolled `main` merge.
- Require the six CI checks (PostgreSQL integration plus four regression shards and typecheck/build) all green **on the final revision**, matching the exact GitHub SHA that is checked out in Replit.
- Verify schema and storage checks above and test the new read-only query on a **restored** database before proceeding.
- Keep `WATERX_VISITOR_ONLY_MODE=true`. Keep `WATERX_RULE_CONFIRMATION_ENABLED=false` until a separate approved live shadow-only pilot. Treat any new rule confirmation as uncalibrated research evidence, not a trained model or execution authorization.
- Owner approval required **after** these checks to publish; immediately verify browser-closed idle state, 5m/15m source/data freshness, exact-round scores, absence of unexpected writes and per-project database-compute hours. Rollback to previously published revision if compromised.

**No production SQL, migration, payment, secret or publication action is performed by this document.**
