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
- On September 30 at 13:14 UTC, a full custom-format export was made through
  the production Database Settings connection string, after the destination's
  table count and database size matched independent read-only production
  results (76 public tables, approximately 1.14 billion bytes). The
  172,443,571-byte archive is at
  `backups/production-20260930T131424Z/production.dump` (mode 0600, parent
  mode 0700, Git-ignored). Its SHA-256 is
  `f01437962a50fafc391b50eaa6ce5b4ae54b906d317346937fe19b0d13c325b3`.
  Keep it private and out of public source and Git history.
- The archive restored successfully with `pg_restore --no-owner --no-acl
  --exit-on-error` into a disposable PostgreSQL 16 cluster reachable only by
  a private Unix socket, without overwriting production or development. The
  restored database has all 76 public tables, 5,476 BTC rounds, 21,603 BTC
  predictions, 24,613 BTC snapshots, 77 WaterX learning rounds, and 155,599
  WaterX comparison ticks. Full-row hashes of the first ten records by ID
  match read-only production for BTC rounds, BTC predictions, and WaterX
  comparison ticks. Production kept collecting after the dump (a later read
  showed 78 learning rounds and 156,203 ticks); these later counts are not
  evidence of omitted backup rows. The local restore server was stopped.
- The owner placed the masked production connection string from Production
  Database → Settings in the temporary `PRODUCTION_BACKUP_DATABASE_URL`
  secret without exposing it in chat. Remove this powerful secret when no
  further export is needed. The shell's ordinary `DATABASE_URL` is development.
- Replit's documented production point-in-time restore switches the
  production database to the selected historical state. It is **not** an
  isolated restore rehearsal. The Database tool's record export is not a
  consistent full-database dump. The isolated export/restore rehearsal above
  is now complete. Retain a private copy outside this workspace before
  relying on the archive for disaster recovery; the workspace copy alone
  is not independent storage. Other rollout gates remain open.

## Backup gate before production changes

1. **Export and isolated restore rehearsed September 30.** Retain an
   independent, securely stored copy of the verified archive before rollout;
   never add it to the source repository or public export. Refresh the export
   and restore test if production changes materially before publishing.
2. The isolated restore is a rehearsal, not a production restore or proof
   that future backups will remain available.
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

**Gate status:** full-backup export and isolated restore verified September 30;
still blocked on independent private backup retention, an approved always-on
hosting quote, publish schema-diff review, and complete 5m/15m settlement
verification. No production change has been made.