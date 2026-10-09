# Blue Water Agents: low-cost collection rollout

**Status:** proposed source-only changes. **Not approved for main, production, or data deletion.**

## What changes

- `server/waterx/poll-policy.ts`: per-interval WaterX polling is 15s (5m market) and 30s (15m market) outside the decision window. It increases to 3s for 165s/420s before expiration respectively and briefly through rollover. Existing exact lock checkpoint timers still issue their deadline reads independently.
- `server/btc/chart-sampling.ts`: Coinbase prices continue to reach the live chart and in-memory model features at full WebSocket cadence, but accepted records enter the PostgreSQL comparison-tick writer only once per **5 seconds**. The writer retains its queue, retries, event identity and no-fabrication checks. This does **not** alter WaterX settlement or canonical decision evidence.
- `server/waterx/research-maintenance.ts`: background reconciliation and history-scoring scans run once per 60s rather than 15s. Per-round settlement capture is separate; history may therefore refresh up to ~60s later than before. Do not reduce lock checkpoint cadence.
- No retention/deletion statements, migrations, schema changes, autonomous trading, paid services, or hosting changes.

## Checks required before merging

1. GitHub PR CI must pass `npm run check`, `npm test` and `npm run build` using Node 22.
2. Confirm running Replit production uses the intended source: check the deployed version endpoint and build/provenance. **GitHub main is not currently proven identical to production.** Do not merge or deploy on that assumption.
3. Verify database backup and rollback procedure **outside** this branch. Never expose production credentials in chat or CI logs.
4. Establish 24-hour pre-change baseline (both WaterX intervals): provider request count, API errors, read/commit latency p50/p95, stale/hold durations, failed/late checkpoint count, real verified settlement coverage, live chart gap rate, database table-size estimates, and infrastructure spend. Use the application diagnostics already present, avoiding new high-frequency monitoring polls.
5. Confirm no active trading authorization has been enabled as a side effect, and deployment remains read-only until explicitly approved.

## Deploy only after owner approval

- Deploy this exact tested revision through an authenticated, reversible publication workflow. Do **not** publish automatically on PR creation or merge.
- Canary for at least 24h. Abort/revert if 5m/15m lock capture quality, earliest readiness, verified round accuracy, chart freshness or collection reliability worsens. Compare matched rounds, not only headline accuracy.
- Roll back by restoring the previous published revision, or restart the runtime with all three compatibility flags:

```
WATERX_ADAPTIVE_POLLING=false
WATERX_COMPARISON_ARCHIVE_SAMPLING=false
WATERX_RESEARCH_MAINTENANCE_FAST=true
```

These restore the prior provider schedule, per-accepted-tick archive behavior and 15-second research maintenance. Environment variables take effect on **process restart**.

## Production-storage audit: read only

The Replit charges are account-wide until the cost by project/resource is expanded. Storage may be database, object or app storage; do not assume this application's PostgreSQL is responsible based on an account-level invoice.

Sample read-only PostgreSQL space check (run from a trusted authorized SQL console; **do not** paste DB connection strings into chat):

```sql
SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS total,
       n_live_tup AS estimated_live_rows
  FROM pg_stat_user_tables
 WHERE schemaname = 'public'
 ORDER BY pg_total_relation_size(relid) DESC
 LIMIT 25;
```

Before proposing data retention or compaction, establish which tables hold immutable prediction/settlement evidence and which contain replaceable chart samples. Archive/retention rules require a verified backup, owner approval, and an independently reviewed migration. **This PR deletes no historical records.**

## Expected direction, not a billing guarantee

The changes should reduce idle WaterX reads, repeated maintenance queries, and sampled Coinbase tick INSERT attempts. Replit billing will not necessarily drop immediately: storage can be billed on provisioned or high-water usage, and running hosting costs are separate. Measure the project-specific spending and resource usage over the next billing period before claiming savings.
