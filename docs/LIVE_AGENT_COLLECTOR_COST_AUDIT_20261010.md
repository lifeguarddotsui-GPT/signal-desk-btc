# Live Agent + Collector Independence + Cost Audit — October 10, 2026

**Basis:** Exact source-only deployed export (Oct 8 build, synchronized Oct 9), Oct 10 user screenshots, Oct 9 read-only 24-hour production gate cohort. This report does **not** claim October 10 production environment secrets/billing or signer access were inspected. **No deployment, financial transaction, admin credential handling, database migration, or history alteration.**

## 1. Explicit mainnet trading blockers

| Rank | Source / API | Grounded result | Required secure validation |
| --- | --- | --- | --- |
| P0 | `server/agent/routes.ts` `/api/agent/capabilities` | Hardcoded `mainnetEnabled:false`, `globalExecutionDisabled:true`, `betaAuthorization:false`, `arming:false`, `execution:false`, `executableQuote:null`, `delegatedOrderAvailable:false`. | Explicit owner-approved signed mainnet pilot/release policy. Do not flip booleans alone. |
| P0 | `/api/agent/delegate`, `/api/agent/owner-transaction`, `/api/agent/control` | Delegate returns 409; AUTHORIZE is explicitly refused; production ARM refuses anything except PAUSE/STOP_GOAL. | Isolate restricted signer outside website, fund delegate gas in controlled manner, simulate and independently verify exact on-chain PLACE_ORDER-only permission and negative withdrawal/management proofs. |
| P0 | `server/agent/worker.ts` | Worker requires `NODE_ENV=development`; only produces `WOULD_HOLD`; **no sign or submit**. | Signed owner session permit, one-wallet locked reservation, checked SDK intent+fresh fee-inclusive quote, simulation, secure signer invocation, client-safe UNKNOWN/fill/settlement reconciliation, recovery and kill switch. |
| P0 | `server/agent/live-readiness.ts`, `infrastructure/agent-signer/control-plane.ts` | `released:false`, signer/admin separation unverified. Credential check reports *presence* only, not authority proofs. | Independent managed signer, credential isolation, revocation and negative checks. **Do not move signer secret into web app, GitHub or browser.** |
| P1 | `/api/economics`, `server/agent/order-adapter.ts` | Public economics endpoint returns 503; no executable fee-inclusive full-size order quote, partial fill and order semantics proved. SDK transaction builder alone does not constitute an executable fill. | Observe official selected market ID/side, full-size quote, minimum shares, price cap/expiry, fees, sim result, order tx digest, fills, refunds, settlement. |
| P1 | Onboarding | Slush ownership and WaterX account selection can be demonstrated; available balance screenshot ≠ proof of trade-ready WaterX USD collateral, gas or current credits. | Read `/api/agent/account-balance` as authenticated owner and on-chain account state; no credentials posted. Verify minimum order size and actual stake. |

**Important:** The displayed conservative policy includes **5% of $5 = $0.25** if 'available balance' and percentage allocation refer to the same $5. This may be below the market's minimum executable order/fees even after live execution is safely built. Never silently round upward to $5. The displayed daily loss stop ($4) is separate from executable collateral/turnover caps.

## 2. Browser-dependent collection mechanism

- `server/index.ts`: production web service starts `startPriceCapture`, `startWaterxCapture`, `startTwoStageSupport`, plus research scheduling **inside web process**, after DB initialization, unless `WATERX_EXTERNAL_COLLECTOR=true`. Replit Autoscale may put this process to sleep. An open browser can wake it; the timers cannot capture historical prospective decisions while sleeping.
- `server/routes.ts`: `GET /api/waterx/live` calls `getLiveWaterx`; `server/waterx/service.ts` can refresh stale data with bounded `pollWaterx`. Browser traffic can therefore help restart/reawaken the web worker; it is **not** reliable capture authority.
- `GET /api/waterx/collector-state` is passive and says `stateScope:'process-memory'`, `continuityAcrossRestarts:false`. It is not durable uptime proof.
- Last 24h audited gate cohort (Oct 9): of 54 5m and 35 15m `DATA_FAILURE` decisions, **all 89 had MISSED_GATE** evidence; 440/486 and 970/1015 gate results were MISSED_GATE. Stale-data waits overlap only 4 and 3 failure rounds. This is strong operational capture/timing evidence, not proof of a specific Replit billing or sleep counter.
- A separate leased worker exists in `server/waterx/worker.ts` and `scripts/vm-production-supervisor.mjs`, but its continuous production deployment has not been established. Turning on `WATERX_EXTERNAL_COLLECTOR` without starting a verified independent collector would stop website collection entirely.
- `edge/worker.ts` and `edge/wrangler.toml`: separate Cloudflare Durable Object/D1 source-only prototype: 5-second alarm, 5m each alarm, 15m alternate alarms, 1-minute Cron wake, **26-hour automatic trial stop**. D1 is **not** automatically the authoritative Replit PostgreSQL prediction/settlement database. Do not conflate edge snapshots with immutable predictions.
- Last-known deployed source also contains overlapping canonical, early, timed, Event, Two-Stage, optional observation and chart queues. Optimizing individual reads without verifying durable capture can worsen data loss.

## 3. Lowest-cost *reliable* architecture (proposed)

- **Public UI:** static assets at Cloudflare free static delivery; serve browser chart/live view from a shared cache. Mobile viewers never create a new market-provider polling loop or DB read each second.
- **Canonical prospective collector:** exactly **one elected** background collector for both BTC durations. Prefer adapting existing Cloudflare Durable Object/Cron to long-term operation on measured free-tier quotas; do not assume trial's 26-hour code or D1 storage is a drop-in production replacement. Alternatively, lease-protected always-on worker (modest predictable monthly spend). No dependence on open browser. Replit autoscale remains only for infrequent owner actions until the API can migrate.
- **Immutable events:** persist provider receipt clock, application availability clock, same-round IDs, source health, lock decision, outbox and settlement independently. No retroactive lock, falsified evidence clock or unverified outcome label. Maintain a documented bridge/reconciler if moving records between D1 and Postgres; do not issue a paid Replit wake-up on each edge alarm.
- **Low write volume:** source receipts in bounded memory; lock/outbox are durable immediately, settlement and real source outages are durable; sample only replaceable chart ticks (target 5s, to be evaluated), batch ordinary historical observations; train/reconcile on bounded low-frequency jobs. Unique constraints, batching and retention for replaceable rows only **after backup and approval**.
- **Trading:** separated Cloudflare encrypted restricted signer, **independent** from web publishing/admin permissions; no persistent signer on client or Replit web process. A secured signer is not equivalent to funded permission; require owner permit, exact market order constraints, fresh full-size executable quote, gas budget, atomic exposure reservation, pilot-only submission and UNKNOWN reconciliation. No live trade should be allowed as an accidental side effect of collector migration.
- **Keep V3 and V4 shadow segregated:** V4 does not fix sleeping hosts; no '24/7' guarantee until a continuously scheduled process has been measured. Preserve complete scored history.

## 4. Cost hotspots and safe optimizations

| Driver | Current source behavior | Proposed optimization | Condition |
| --- | --- | --- | --- |
| Replit Autoscale | Website serves Node API, in-process collectors, market/settlement/learning work | Separate static public delivery and background collector; web scales to zero until owner operations | First demonstrate durable capture without browser |
| WaterX polling | Base 5s per interval and additional deadline/checkpoint reads | Adapt **already-written** `cost/adaptive-collection-2026-10-09` branch only after rebasing onto actual deployed source; 10s/20s idle and faster critical windows are *hypotheses* | Preserve <12s evidence gaps and missed-lock/accuracy baseline on matched rounds |
| BTC chart writes | Many high-cadence Coinbase websocket ticks | Existing branch samples replaceable comparison chart archive at 5s while keeping full in-memory stream | Confirm no loss of prospective lock evidence / backfill accuracy |
| PostgreSQL | Multiple connection pools and history/training reads | Limit/warm critical pool, defer noncritical queries, use indexed exact-round lookup, batch noncritical inserts, read-only history cache | Do **not** discard immutable gate/outcome records |
| Cloudflare prototype | 5s alarms, DO state writes, D1 writes, Cron once/min, 26h stop | Reuse free-tier **if measured** and replace trial stop via separately approved source revision; monitor D1 row quotas, Durable Object runtime and provider rate limits | No silent free-tier limits/exhaustion |
| AI development | Replit Agent usage is separate from deployment/database costs | Continue GitHub PR+CI review, use Replit only for authorized publishing | Do not merge unsynced legacy main |

Cloudflare Free publicly lists 100K Workers/DO requests/day, and D1 Free daily row quotas. The prototype's 5s alarms imply ~17,280 alarms/day, plus ~1,440 one-minute Cron wakeups; the 5m+15m fetch schedule is ~25,920 provider requests/day *before retries*. These are **estimates from configured source**, not measured Cloudflare usage or proof that the provider allows this cadence. Free quotas can still fail under runtime/DB limits or sustained compute.

### Replit billing proof required

Use [Replit Usage](https://replit.com/usage) filtered to the Blue Water project and split **AI Agent**, **Autoscale compute/requests**, **database provisioned/storage/operations**, **outbound data**, **background processes**, **published apps**. Project-level totals are needed before quoting savings. An account-wide credit charge does not prove Blue Water caused it. Capture 7-day baseline and another 7-day window after a separately approved change.

DB size check in an **authorized read-only** production SQL console:
```sql
SELECT relname,pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
       n_live_tup AS estimated_live_rows
FROM pg_stat_user_tables WHERE schemaname='public'
ORDER BY pg_total_relation_size(relid) DESC LIMIT 25;
```
Do not paste connection strings or wallet secrets.

## 5. Safe validation / release ordering

1. Verify running `GET /api/waterx/version` with release SHA, Replit deployment type, **actual** environment-variable *presence only* (`WATERX_EXTERNAL_COLLECTOR`, worker launch, signer URL, admin-role separation). Never share values.
2. Reconcile GitHub's source snapshot and V4 PR against current production. Current V4 targeted CI passes, but **full suite is red** on at least missing fixture `scripts/fixtures/waterx-probability-outage-2026-10-06.json` and lockfile/test issues. Repair without discarding critical tests.
3. Capture 24h browser-closed baseline of collector wake/heartbeat, scheduled vs executed gates, DB acceptance, pending settlement, exact-round history. Use passive read endpoint to avoid the observer altering evidence.
4. Evaluate Cloudflare free-tier migration/bridge in development, reconcile deterministic exact-round output and billable usage. Do not disable Replit collector before another source is verified, and require unique writer lease/authority.
5. Separate owner-reviewed signer permission proof from order quote+fee proof, refund/partial fill, bounded first real-money pilot, and independent kill switch/withdrawal recovery.
6. Backup/restore, deterministic CI, GitHub-to-Replit approved SHA connection, rollback. **No production permission flips, database deletion, forced delegate action, or automatic deployments**.

**Recommendation:** Fix browser-independent collection **before** attempting high-frequency autonomous orders. Agent automation without uninterrupted capture and post-trade settlement is unsafe. Enable tiny pilot orders only once the restricted signer, executable quotes, on-chain permissions, and complete reconciliation all pass independent checks.
