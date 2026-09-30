# WaterX collection on free infrastructure: prototype, not a cutover

**Status (2026-09-30, 22:03 UTC):** The isolated Cloudflare Free-tier trial is **running**. Both markets returned LIVE WaterX responses from Cloudflare, with odds saved in D1 and no reported provider/database errors in the initial health check. The account still has **zero subscriptions**; no paid plan was activated. The published Replit site, existing collector, and production PostgreSQL database are unchanged. These first observations establish current-market edge access, **not** verified historical settlement, a full-day resource budget, or 24-hour coverage. Oracle has not been provisioned.

## Source boundaries

- WaterX's public `crypto-btc-updown-5m` and `crypto-btc-updown-15m` API responses supply the round UUID and exact start/end, UP/DOWN odds, and separately marked price-to-beat reference. A returned reference is **not confirmed** unless `anchorPriceConfirmed` is true.
- The historical WaterX query uses `epoch=<round closing time>`. Settlement is verified only against the previously recorded UUID **and** closing time, with provider `resolutionStatus`, outcome, settle price, and a confirmed anchor; contradictory or incomplete evidence is withheld, not inferred.
- Coinbase BTC/USD data is a comparison trace only. It cannot establish WaterX odds, the price to beat, or settlement.
- The existing PostgreSQL database has historical records and a protected full archive in the workspace. Neither it nor the published app should be deleted or migrated until source history, off-workspace backups, read compatibility, and restore have been separately verified.

## What was measured locally

On 2026-09-30, direct unauthenticated GETs with `Accept: application/json` from this Replit development environment returned HTTP 200 for both markets. The two current responses were about 17 KB and 13 KB; each classified as a LIVE round with distinct UUID and cadence. Both historical closing-epoch lookups returned distinct prior UUIDs, `resolved` provider status, a provider DOWN outcome, a settle price, and a confirmed anchor. Current anchors were *not* confirmed. This does not test Cloudflare egress IPs or Oracle networking. Parsing and classifying 100 cached copies of each real response in Node measured median CPU ~0.25 ms (5m) and ~0.07 ms (15m), with 5m p95 ~4.3 ms; it excludes actual D1 writes, Worker initialization, and runtime differences. A **synthetic** one-day SQLite load using the prototype schema (5,760 samples, 384 rounds, 384 settlement rows and 384 coverage rows) occupied 1,241,088 bytes; this is a storage-model estimate, not measured D1 growth or a 24-hour live collection.

## Free-tier feasibility and resource budget

The candidate uses one SQLite-backed Durable Object with a five-second recurring alarm, a one-minute Worker cron bootstrap/watchdog, and a D1 database for compact, source-stamped observations. An alarm polls the five-minute market each time and the 15-minute market every other time. Persist the latest observation in the Durable Object, round-first observations and periodic snapshots in D1, and provider settlement evidence separately. Advance the alarm even when one provider or D1 operation fails. Keep an explicit count of missing/late observations and never fill a gap with a synthetic value.

## Remote trial and how to inspect it

- Worker: `waterx-edge-prototype`; endpoint: `https://waterx-edge-prototype.waterx-source-4678f8b0.workers.dev`.
- D1 binding: the separate `waterx-edge-prototype` database recorded in `edge/wrangler.toml`. Its schema was read back from the remote API: all six tables and five explicit indexes exist. No production data was imported.
- First deployment: 2026-09-30 21:58:50 UTC; coverage fixes uploaded at 22:01:59 UTC. Cron bootstrapped the trial at **22:02:44.752 UTC**. The first LIVE reads and D1 persistence for both markets were confirmed at 22:02:47 UTC. Review the full-day window after **2026-10-01 22:02:45 UTC**; automatic stop is **2026-10-02 00:02:44.752 UTC**. Collection starts at bootstrap, not upload. Cron changes can take [up to 15 minutes to propagate](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
- The prototype **stops provider polling automatically 26 hours after bootstrap**, without deleting its records or allowing cron to restart it. `/health`, `/latest`, and `/coverage` expose the actual start, cutoff, and trial status. After stop, coverage freezes the final 24-hour window at the cutoff, including excessive gaps in a terminal partial round. The minute cron remains configured until explicitly disabled; it can still consume Free-tier requests after polling stops.
- The direct API deployment helper avoids the blocked Wrangler dependency installation. It checks that account subscriptions are empty before provisioning/updating, refuses to reuse an existing same-name database on initial deployment, and never calls a subscription/billing mutation. API `usage_model: standard` is **not** a paid-plan declaration; subscription inspection is a separate check.
- Worker invocation logs are enabled at full sampling. No Logpush, paid logging, external PostgreSQL connection, or production app adapter is configured.
- New-hostname TLS initially failed, then became available without an account or paid-plan change. `/health`, `/latest`, and `/coverage` returned HTTP 200 at 22:03 UTC. A private API read independently confirmed **two prospective first-round records, six 30-second snapshots, and two coverage rows**. Both reference prices remain explicitly **unconfirmed**; no historical settlement evidence exists yet.
- Early Worker telemetry initially contained two successful sampled invocations, at **1.140 ms** and **0.707 ms** CPU respectively; the 22:06 UTC query reports eight successful Worker requests, no Worker invocation errors, CPU P50 **0.707 ms** and P99 **1.140 ms**. These are not full alarm-handler CPU measurements or a full-day budget. DO invocation/periodic/storage telemetry and D1 storage analytics are still empty/lagged, not zero.
- At 22:06 UTC, the first 5m historical read was persisted with a confirmed anchor but **WITHHELD** settlement: WaterX had not explicitly returned resolved status/outcome/timestamp. This establishes successful 5m historical edge access, not a verified settlement label. Historical 15m access and verified labels remain pending.
- Remote query metadata reports a size of **90,112 bytes**, while the database-list `file_size` still reports 8,192 bytes; treat that list value as lagged, not the current data size. Initial health, status, and analytics evidence are retained under `.local/edge-trial/`; nothing contains authentication headers or credentials.

Run these from this workspace; credentials are read silently from Secrets and are not printed:

```sh
node scripts/cloudflare-waterx-trial.mjs --status
node scripts/cloudflare-waterx-metrics.mjs
```

The first command reads public endpoint health and private D1 counts/latest samples even if HTTPS is unavailable. The second queries actual Cloudflare GraphQL metrics: Worker CPU quantiles (microseconds), requests/statuses, DO invocations/periodic CPU/storage where exposed, D1 rows read/written/query counts, and storage sizes. It uses exact resource filters and coarse time grouping to avoid cutting a full day's per-second records off at the result limit; any limit reached is explicitly marked possibly truncated. Missing, restricted, empty, or lagged data is explicit—never a zero measurement. Cloudflare's current DO subrequest dataset does not expose HTTP status/hostname, so Worker subrequest telemetry cannot by itself certify DO-origin 403/429 counts. The full 24-hour trial and actual runtime resource budget remain unproved.

When the trial has elapsed, preserve its evidence and disable the prototype's cron through the Cloudflare API/dashboard. Do not delete its D1/DO records or retire the production collector based on upload success, short-lived samples, or incomplete analytics.

| Resource | Candidate arithmetic, *not measured Cloudflare usage* | Official Free limit |
|---|---:|---:|
| Alarm invocations | 86,400/5 = 17,280/day | Durable Object 100,000 requests/day; Worker 100,000 requests/day, each account-shared |
| Cron wake-ups | 1,440/day; up to 1,440 additional DO requests | Same account-shared request limits |
| WaterX outbound reads | 17,280 5m + 8,640 15m = 25,920/day, plus bounded historical settlement reads | Check provider rate limits and Cloudflare subrequest allowance |
| D1 30-second samples | Up to 5,760 observations/day, plus up to 384 new rounds/day and settlement evidence | 100,000 rows written/day **including index writes**; 5 million rows read/day |
| DO SQLite state and alarms | One aggregate state write and one alarm write per tick: nominal 34,560/day; up to 37,440/day if all 1,440 minute cron checks need to restore missing alarms, excluding retries/redeliveries | 100,000 rows written/day and 5 million rows read/day; `setAlarm()` is one row written |
| D1 size | Must be measured from actual SQLite file growth and retention policy | 500 MB **per Free database**, 5 GB total |
| Worker CPU | Real-response parsing alone is below 10 ms in this Node test; full per-invocation CPU **unverified** | 10 ms per Free invocation |
| DO duration | Must be measured; do not hold open sockets or perpetual timers | 13,000 GB-s/day included |

The 24-hour denominator is **288 five-minute rounds and 96 fifteen-minute rounds**. The prototype exposes `/coverage` to distinguish accounted rounds from gap-free rounds; its bounded catch-up inserts missing expected intervals but no fabricated provider observations. A real deployed trial must report, independently per interval and per field: distinct round UUID/boundary coverage, time since latest valid quote, odds completeness, confirmed reference completeness, historical settlement identity/label completeness, delayed alarms, retry/429/403 counts, actual CPU, D1 rows and size, and any gaps through restarts. Close all browsers during the trial. A short local test is not a substitute.

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [alarms and retry behavior](https://developers.cloudflare.com/durable-objects/api/alarms/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Oracle fallback

Oracle's Always Free compute in the account's **home region** currently documents two E2.1.Micro VMs (1 GB RAM, fractional CPU), or a monthly Ampere A1 pool of 1,500 OCPU-hours and 9,000 GB-hours (equivalent to 2 OCPUs/12 GB for a full month), with 200 GB combined block/boot-volume storage. A production-style Replit web+collector stack sampled ~248 MiB RSS and ~2% of a CPU core over 45 low-traffic seconds, but this is **not** an Oracle ARM/E2 peak-load test. Images, boot volume sizes, region, IP/egress, and usage must all remain Always Free-eligible to avoid charges. Free-region capacity can be unavailable, and Oracle may reclaim an instance it deems idle over seven days (low CPU and network, plus low memory for A1). The current low-load collector appears exposed to that policy; do not manufacture load to evade it. The owner would maintain OS patches, process supervision, HTTPS, logs, network rules, monitoring, disk backups, and recovery. No OCI account, instance, or provider egress has been tested here.

Source: [Oracle Always Free resources, limits, capacity, and idle reclamation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

## Cutover gates and remaining Replit costs

1. Keep production unchanged. First test *actual* Cloudflare-origin WaterX current and historical reads, Free-tier limits, D1/DO persistence after restart, and 24 hours of browser-closed coverage. Only consider Oracle if Cloudflare fails a concrete gate.
2. Preserve the existing PostgreSQL database and full archive. Restore a **current** full export into an isolated PostgreSQL instance, verify history and row counts, and retain an encrypted copy outside this workspace. A workspace or `/tmp` copy alone is not off-workspace retention.
3. Stage a read-only adapter for the existing site to consume source-stamped edge data, compare it against the legacy API, and verify settlement and historical completeness. **Then** disable the Replit polling process and its frequent PostgreSQL lease queries/writes; removing lease checks first would leave duplicate/unsupervised collectors.
4. Do not retire the Replit site or database merely because the edge collector works. The site's other BTC data, UI, stored history, and any account-specific functions need a separate inventory and migration. Until retired, the existing Autoscale base/requests/compute, production PostgreSQL compute/storage, and transfer may still be billed. Neither Cloudflare Free nor Oracle Always Free guarantees $0 for the *whole product* or promises uninterrupted service.
5. Before any paid tier, connector, or cross-provider storage is enabled, show its published price, measured quota usage, and explicit approval. The free platform can stop operations rather than charge when limits are hit.