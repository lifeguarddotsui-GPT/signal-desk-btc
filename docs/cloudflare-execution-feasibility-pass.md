# Bounded execution feasibility pass

This is an isolated, unfunded compatibility test, **not** production trading
acceptance and not an authority to move an owner's assets.

## Final result — October 5, 2026, Belize

**Conditional feasibility, not trading acceptance.** No observed Free-tier limit
blocked collection, policy evaluation, SDK registry reads or test-key crypto.
There is no evidence-based reason from this pass alone to activate Paid or move
to a VM. The complete autonomous trading path and its cost remain unverified.

The single measurement window ran 21:33:42–22:04:42 Belize
(03:33:42–04:04:42 UTC on October 6), and the final readback confirmed automatic
stop. No funded transactions, execute calls or paid subscription activation.

| Final evidence | Result |
|---|---|
| Alarm-driven polls / provider reads | 373 / 746; zero recorded collection failures |
| Complete round coverage | Five complete 5-minute rounds and one complete 15-minute round |
| Gates within the measurement window | 116: 65 QUALIFIED, 50 WAIT, one MISSED_GATE |
| Complete-round gates | All 74 scheduled gates journaled; zero missed |
| Late gate | Final partial 15-minute round: 2,133 ms late, exceeding the unchanged 2,000 ms grace |
| Pre-start gates | 14 correctly classified missed; excluded from the trial's 116 gates |
| Durable probe-only decisions | Nine, including one for each of the six complete rounds; not trades or authoritative production decisions |
| Alarm CPU, invocation logs | Median 3 ms; p99 6 ms; maximum 8 ms |
| Alarm wall time, invocation logs | Median 2,786 ms; maximum 4,358 ms; not equivalent to CPU or billed GB-s |
| Worker ingress CPU, analytics | p99 1.568 ms against the published 10 ms Free ingress limit |
| Native DO fetch subchecks | Logged maximum 99 ms CPU; these are not ingress Worker CPU samples |
| Bundle / measured upload startup | About 1.12 MB / 35–45 ms across updates |
| Memory, partial platform metrics | Maximum 15,202,752 bytes, about 14.5 MiB |
| SQLite size, actual runtime | 94,208 bytes, about 92 KiB |
| Instrumented SQL cursor meter | 658 reads / 314 writes, excluding accounting updates and KV/alarm work |
| Platform periodic SQL totals, partial | 791 rows read / 996 rows written |
| Platform periodic DO duration, partial | 132.314 GB-s |
| Encrypted delegate recovery | Passed after readback matched the newly deployed build, proving execution in the updated runtime |
| Synthetic UNKNOWN reservations | Two retained after restart; duplicate suppressed; no resubmission |
| Real order building / owned-account simulation | Not proven; missing synthetic account stopped normal building |
| Alternative explicit-reference encoding | Guard rejected it; guard was not weakened |
| Inert transaction signing / fullnode validation | Signature verified; nonexistent gas object rejected, as intended |

The platform's partial periodic totals project to roughly 6,146 GB-s/day and
46,266 row writes/day at this workload's cadence, versus Free limits of
13,000 GB-s/day and 100,000 writes/day. Alarm cadence alone implies 17,280
DO invocations/day, versus 100,000. These are **illustrative projections from a
short, partial sample**, not verified upper bounds or multi-wallet capacity.
They exclude other account resources and an integrated trading/learning workload.
Storage analytics and per-host RPC subrequest counts remained unavailable.

All 395 returned invocation-log records had platform outcome `ok`; this includes
handled negative SDK checks, so it does **not** mean successful order execution.
The missed gate demonstrates that the current five-second sequential polling
approach does not guarantee the two-second gate grace. It must remain fail-closed.

### Remaining full-path gaps

- Exact live BTC interval/round-to-on-chain market and selection mapping,
  resolved prediction-order signing, fee/gas quotes and owned-account simulation.
- Current on-chain delegate permission checks, session revocation/replay defense,
  real atomic aggregate budget reservations and authenticated wallet isolation.
- A production-connected dispatcher that submits once and reconciles uncertain
  receipts, fills, positions, claims and paused sessions.
- Verified native-USDC credited funding, redemption/withdrawal recovery and
  separately owner-approved bounded mainnet pilot.
- Scheduled learning, production backup/cutover, sustained account-level quota
  evidence and retained public-RPC rate-limit capacity.
- Signer deployment-authority isolation, detailed below.

The existing production collector's database timeouts were observed separately;
this isolated probe neither fixes them nor proves the production database's
invoice will decrease. Production trading remains disabled.

Verification: standalone Worker strict typecheck, project typecheck, CLI syntax
checks, two existing signer-protection tests and actual remote checks passed.
The public development page was checked at 320×720; signed-in wallet UI was not
verified or changed by this pass.

## Scope and controls

- Reuses the existing Cloudflare collector's WaterX parser and the current pure
  30-second qualification policy. The previous trial and its history are unchanged.
- One shared SQLite Durable Object polls both intervals. No polling or gate
  scheduling depends on a browser, the Replit web server, or PostgreSQL.
- The pass runs for 31 minutes with an alarm-owned cutoff and no continuing cron.
  This allows a complete 15-minute round regardless of the start phase.
- Authentication protects every probe route. All signing keys belong to newly
  generated, unfunded test identities. Only encrypted envelopes are persisted.
- The program has **no transaction-submission endpoint or execute RPC call**.
  Neither funded mainnet transactions nor paid subscriptions are authorized.
- Native-USDC/mainnet registry checks reuse the existing protocol identity pins.

The private receipts are in `.local/execution-feasibility/`. The workspace watcher
is best-effort; if it stops, Cloudflare still owns the cutoff and retains evidence.
Resume readback with `node scripts/cloudflare-execution-feasibility.mjs --report`.
Never restart the measurement window merely to improve its results.

## Evidence boundaries

| Check | What it establishes | What it does not establish |
|---|---|---|
| SDK registry reads on Cloudflare | Installed SDK/gRPC/config compatibility | An owner has funded/authorized an account |
| Encrypted delegate recovery and signed test permit | Runtime crypto and envelope compatibility | Signer control-plane isolation or real owner consent |
| Canonical order and withdrawal guards | Intended transaction restrictions on constructed data | Effective on-chain permissions or resolved-byte authorization |
| Normal synthetic account build | Missing-account failure is explicit | Successful funded order building |
| Explicit synthetic reference subcheck | Existing guard rejects the altered representation | A reason to weaken that guard |
| Inert Sui transaction signing/verification | Native serialized signing works remotely | Prediction-order signing acceptance |
| Fullnode rejection of nonexistent gas objects | Mainnet validation was reached without spending | Successful owned-account simulation |
| Synthetic UNKNOWN reservations/restart/dedup | Persistence retains uncertainty and unique intent identity | Actual submit-timeout reconciliation or authenticated two-wallet isolation |
| Probe gate/final rows | Policy and durable-write compatibility | Production authoritative final decisions |
| Alarm observations with no browser driving the probe | Independent scheduling during that interval | Every owner's browser was physically closed |

Submission, receipt/fill tracking, real positions, claims, paused-order
reconciliation, withdrawal recovery, and an owner-approved bounded pilot remain
unproven. Daily learning/calibration is not running in this probe.

## Metering

Cloudflare invocation logs provide CPU/wall milliseconds. The reusable analytics
helper accepts `--execution-probe` and exact `--from`/`--to` timestamps.
Empty, delayed, or missing datasets mean **unmeasured**, never zero.

SQLite cursor counts cover the instrumented SQL but exclude the meter's own
updates, KV operations, and alarm writes. Storage size is read from the actual
SQLite API. Provider-call counts are persisted. RPC subrequest counts and billed
DO duration need platform telemetry; wall-clock samples cannot replace them.
The probe itself makes no PostgreSQL queries. That does not make the existing
production app's database usage zero or fix its observed timeouts.

## Cost comparison — current published rates

Rates checked on October 6, 2026 UTC. These are formulas/scenarios, not an invoice
or a statement that the full architecture meets Free limits.

| Component | Cloudflare Free | Cloudflare Paid | Replit small Reserved VM |
|---|---|---|---|
| Hosting base | $0 within account limits | $5/month minimum | $0.0208/hour, about $15.18 at 730 hours |
| Shared collector/signing compute | Included within Free DO/Worker limits | Included allowances, then request/CPU/DO-duration charges | Included in VM capacity; sizing still needs load evidence |
| Operational SQLite | 5 GB account limit; 100k row writes/day, 5m reads/day | DO: 5 GB-month included, $0.20/GB-month extra; write/read allowances | Local disk needs durable backup and single-host recovery |
| Signing service | Probe-only local crypto, no third-party signing fee | Same; paid plan does not fix administration isolation | Same; separate restricted signer process and operator controls required |
| Public Sui RPC | No fee charged by this probe; no paid RPC provisioned | Same; dedicated RPC pricing/quota is not verified | Same; additional RPC service must be quoted if required |
| Existing Replit app/services | Remain additional usage | Remain additional usage | Remain additional unless deliberately replaced, which is not authorized |
| PostgreSQL | Additional if retained/queried | Additional if retained/queried | Additional if retained/queried; a VM does not remove it |
| Recoverable off-site backups | Not provisioned or verified here; **not priced as zero** | Additional storage/provider as selected | Additional off-site storage/provider as selected |
| Scheduled learning | Not measured | Must fit memory/CPU or use a separately priced batch runtime | Shares VM capacity only if actual training fits |
| Engineering effort | Highest compatibility/edge integration burden | Same integration, fewer quota restrictions | Node/SDK fit is simpler; process supervision, backup and recovery remain |

Cloudflare Free published limits: Worker ingress 100k requests/day and 10 ms CPU
per invocation; DO 100k requests/day and 13,000 GB-s/day; SQL-backed DO 100k writes
and 5m reads/day. The documented DO CPU default is 30 seconds. Do not compare
actor CPU measurements directly with the ingress Worker's 10 ms limit.
All account usage, including other existing Workers, consumes the quotas.

Paid included allowances: Workers 10m requests and 30m CPU-ms/month; DO 1m requests
and 400k GB-s/month. DO excess duration costs $12.50/million GB-s with billable
usage rounded up to a billing unit. For example, a small overage can add $12.50,
not just a few cents. Paid does not mean every total stays at $5.

Replit production PostgreSQL costs $0.16/compute-hour and $0.35/GiB-month. It
suspends after five idle minutes. Frequent sync/health reads can keep it active:

| Short isolated sync scenario, 30 days | Approx. active compute | Compute charge before credits |
|---|---:|---:|
| Continuously queried | 720 hours | $115.20 |
| Every 15 minutes | 240 hours | $38.40 |
| Hourly | 60 hours | $9.60 |
| Daily | 2.5 hours | $0.40 |

These assume a roughly five-minute activation per short batch, no other traffic,
and no overlap. Query duration, UI traffic and other jobs change actual billing.
Operational gates/reservations must not wait for archival sync. Existing data,
history and recoverable backups must be preserved before any production cutover.
Outbound Replit transfer is $0.05/GiB at the checked current rate.

The all-in total is therefore hosting + actual PostgreSQL compute/storage +
remaining app/services + any RPC/signing-provider fees + recoverable backups +
any separate learning runtime. Unquoted services remain unknown, not free.
Dollar-valued development effort is not quoted because no labor rate or measured
implementation estimate has been agreed.

## Security prerequisite

The configured Cloudflare administration credentials are available to the
production web environment. Because that authority can replace the signer Worker,
at-rest encryption alone is **not** isolation from website compromise. Before any
funded signer, move deployment administration outside the public runtime and grant
the website only narrowly scoped invocation authority. No secret scopes were
changed during this pass.

## Sources

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://docs.replit.com/billing/aug-cloud-billing-updates
- https://docs.replit.com/billing/about-usage-based-billing
