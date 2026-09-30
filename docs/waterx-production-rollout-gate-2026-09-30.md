# WaterX production rollout gate — 2026-09-30

## Current state

- `bluewaterai.app` is serving the older autoscale build, source commit
  `d56a8aa4766ec78c3eafea7a07190d507e6bf246` (checked via
  `/api/waterx/version`). The tested development build has **not** been
  published. Do not describe it as deployed.
- Production read-only inspection on September 30 counted 76 public tables and a database
  size of approximately 1,082 MB. Existing BTC prediction rounds, snapshots,
  and WaterX observations must be retained. No production DDL, data overwrite,
  or restore has been performed.
- The workspace's `backups/pre-upgrade-production` export has a
  2026-09-25 cutoff and contains only two older prediction tables. It is
  **not** a recoverable backup of current production.
- PostgreSQL restore tools are available locally, so a user-provided current
  full-format production export can be restored into a temporary, isolated
  local PostgreSQL cluster without adding a hosted database or overwriting
  the development database. This test still requires the current export;
  local tool availability alone is not restore verification.
- Replit's read-only production query access confirms a Replit-managed PostgreSQL
  production database exists, but does not provide a streaming `pg_dump`
  connection to the development shell. `PRODUCTION_BACKUP_DATABASE_URL` was a
  **new secret proposed for this backup procedure**, not an existing Replit
  setting; it has not been configured. Do not reopen a secret-entry form while
  the owner cannot find production connection details in their UI. Request a
  screenshot of the Database/Production settings pane with any credentials
  hidden, then guide the owner from the controls actually visible. Replit
  documents connection details under the production database Settings tab;
  whether this workspace exposes them remains unverified. If an approved
  export path becomes available, verify its production identity before any
  dump; the shell's ordinary `DATABASE_URL` points to development.
- Replit's documented production point-in-time restore switches the
  production database to the selected historical state. It is **not** an
  isolated restore rehearsal. The Database tool's record export is not a
  consistent full-database dump. No current full production backup has been
  restored into an isolated database. **This blocks publishing any schema
  change or changing the collector deployment.**

## Backup gate before production changes

1. Obtain a **current, complete** production database export through an
   approved secure path, including schema, table data, and existing
   observations and prediction history. Store it privately; never add it
   to the source repository or public export.
2. Restore that export into an isolated PostgreSQL target without touching
   production or the existing development tables. Check schema, row counts,
   checksums or representative data hashes, and read access to prediction
   and WaterX history. Record export/restore time, source and result.
3. Review Replit Publish's development-to-production schema diff, including
   the outcome-check replacement. Reject any data overwrite, unintended
   drop, rename, or incompatible migration. Do not run production DDL from
   startup/build scripts or by direct SQL.

## Hosting and runtime gate

- The existing deployment is autoscale; it can sleep when idle. A separate
  worker is not running in production. A continuously running VM is additional
  recurring compute. Replit's published 1-vCPU/4-GiB dedicated price is
  $0.0486/hour (about $35.00 per 30-day month before other charges); the
  published $0.0104/hour smaller configuration is marked legacy and its
  availability here is unverified. Inspect the actual Publishing quote and
  obtain explicit price approval **before** switching targets.
- The build now prepares a bundled collector and a `npm run start:vm` supervisor
  that waits for its database lease before starting the web server. Both
  processes stop together on failure; the VM platform must restart the full
  supervisor on nonzero exit. This is code preparation, not activation. The
  existing autoscale run command has not changed.
- After the backup and pricing gates pass, publish the tested application
  through the supported Publish flow. Start the independent worker only
  against the intended persistent production database; verify it owns the
  database lease, its process restarts, and a second contender cannot collect.
  Set `WATERX_EXTERNAL_COLLECTOR=true` on web processes only after that
  worker is independently observed. Do not disable web fallback prematurely.
- Verify `/api/waterx/version` on `bluewaterai.app` matches the published
  source, then inspect 5m and 15m round identity, WaterX odds, reference
  confirmation, Coinbase-only chart and data gaps, and settlement backlog.
  Record full-round denominators, collection/settlement latency percentiles,
  provider errors and clock boundaries across **at least two complete
  15-minute rounds through settlement**. This observation has not occurred.
  Disputed labels remain withheld; candidates remain offline and unpromoted.

## Failure response

If the worker fails, restore web-process collection by removing the external
collector flag, stop the worker, and return to the last approved app build.
Keep the append-only observations, prediction history, and disputed
settlement evidence. If schema compatibility is uncertain, stop the rollout
instead of deleting rows or performing an unreviewed down-migration. A code
rollback is not a database restore. A production database restore requires
separate review of the exact recovery point and its impact on newer rows.

**Gate status:** blocked on an isolated full-backup restore and an approved
always-on hosting quote. No production change has been made.