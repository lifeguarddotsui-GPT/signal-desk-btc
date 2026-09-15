# Blue Water Agents SUI accumulation architecture

**Current scope:** private, single-owner Observe/Paper MVP. This document
records the intended boundaries from the supplied brief; it does not claim
that the application source already implements every component.

## Safety boundary

The chain is pinned to **Sui mainnet** for any eventual live operation, while
paper data must use a separate namespace that cannot reach a signer. The
repository manifest sets `live_signing: false`. There is no approved package,
object, event, or live execution path in the current evidence register.

The browser never receives a private key. A dedicated agent wallet is distinct
from the owner's primary wallet. A small prototype signer would still be
**server-controlled custody**, not noncustodial custody. Meaningful capital
requires a separately secured signer/KMS whose Sui compatibility is actually
tested. Native Suipump sessions are optional only after their authorization
bounds, expiry, revocation, beneficiary, withdrawal, and route behavior are
proved.

## Components and responsibilities

1. **Web app:** authenticated owner controls and read-only status. Primary
   actions are Deposit SUI, Pause, and Withdraw All. It displays Observe,
   Paper, Live, Paused, or Withdrawing explicitly and never exposes secrets.
2. **Collector:** Sui gRPC/checkpoint ingestion plus a separately verified
   Suipump enrichment adapter. It maintains a durable cursor, ordered replay,
   deduplication, freshness checks, and coverage status. A missing provider or
   checkpoint gap is visible, not silently safe.
3. **Feature engine:** 15-second, 60-second, 5-minute, and 15-minute windows
   over actual SUI flows, holder concentration, wallet-cluster evidence, depth,
   and curve state.
4. **Deterministic strategy engine:** versioned candidate selection and exits
   using checkpoint-stamped features and full-size executable quotes.
   Confirmed early momentum is the primary paper candidate; holding SUI is
   always valid.
5. **Risk engine:** mandatory package allowlists, freshness checks, total-cost
   estimates, exposure reservations, loss limits, withdrawal priority, and the
   policy in `config/risk-policy.json`.
6. **Executor/signer boundary:** one fenced queue per wallet initially.
   Structured intents are independently checked for network, package/module/
   function, coin type, curve/pool, spend cap, gas, minimum received amount,
   destination, and every programmable-transaction command. A model cannot
   submit bytes or sign.
7. **Treasury:** confirms deposits from transaction effects, journals realized
   SUI, and returns funds only to the nonce-proven registered owner address.
   Unknown-source transfers are quarantined, never automatically refunded.
8. **Research worker:** scheduled, bounded structured-output calls over compact
   evidence packets. It can recommend HOLD, WATCH, or an approved strategy
   inside an owner-approved envelope; it cannot raise limits, reset drawdown,
   change a destination, transfer funds, install code, or approve packages.
9. **Persistence:** the intended source of truth is Postgres for events,
   checkpoints, policies, intents, attempts, fills, positions, ledger entries,
   withdrawals, sweeps, research, leases, alerts, and operating costs. A
   Postgres job queue/outbox is preferred to adding Redis prematurely.

## Lifecycle and invariants

An order follows `PROPOSED → VALIDATED → RESERVED → SIGNED → SUBMITTED →
CONFIRMED`, with explicit `REJECTED`, `FAILED`, and `UNKNOWN`. A timeout is not
failure. For `UNKNOWN`, reconcile the known digest and object state; do not
blindly rebuild a buy. Reservations release only when the outcome is known.
Signed bytes and digests belong in restricted storage; key material never goes
to logs.

Every observation stores chain checkpoint/time, local receipt time, provider,
and coverage. Every decision stores policy version, feature snapshot, quote,
cost model, rejection reasons, and eventual outcome. `UNKNOWN` concentration
or authority data must not become zero or safe. Correlated creator/funding
clusters share caps.

Use integer MIST/token base units and decimal strings at API boundaries.
Coin type, package lineage, and curve/pool ID identify an asset; a ticker or
name does not.

## SUI accounting

Show four distinct quantities:

- liquid SUI, with gas reserve separately visible;
- estimated net liquidation value of positions after fees, impact, and gas;
- cumulative confirmed SUI returned to the owner;
- net performance = liquid SUI + conservative liquidation value + campaign
  withdrawals − campaign deposits.

Hosting, RPC, and AI costs are separate attributable lines converted to SUI at
a recorded rate. Deposits, hypothetical market-cap gains, unreceived rewards,
and unsellable balances are not accumulated SUI. A stale or missing quote is
uncertain, excluded from payout eligibility, and stressed at zero for exposure.

The 10→100 display has estimated campaign value and confirmed SUI recovered.
Success means 100 SUI actually returned after on-chain costs with no extra
deposits. A new deposit rebases the campaign; it cannot masquerade as return.
Ten SUI to 100 SUI is a 900% net gain goal, not a forecast or promise.

## Withdrawal and priority

Withdraw All disables new entries, cancels unsubmitted buys, reconciles
in-flight work, liquidates sellable positions within bounded limits, and
transfers available SUI to the registered address. Unsellable residual tokens
are reported and recoverable through an authenticated residual-token flow; the
system must not widen slippage without a bound. Shared executor priority is:
owner withdrawal, emergency/risk exits, ordinary exits, profit sweeps, new
entries.

The evaluation sweep policy is 25% of newly realized campaign profit above its
prior high-water mark, after prior losses and costs, retaining 75% for
compounding. Batch only after at least 0.25 SUI and transfer gas is at most 1%
of the sweep, subject to owner threshold and exit reserves. Persist earmarked,
submitted, and confirmed states idempotently.

## Deployment and known blocker

Trading monitoring must run in an always-on worker independent of dashboard
visitors. Replit Autoscale may scale to zero, so it is not an acceptable
assumption for a trading worker. A Reserved VM/always-on deployment is the
documented pattern, but this artifact set does not prove that a worker is
deployed, supervised, backed up, or healthy. That is a **BLOCKED** go-live
condition. Graceful shutdown, durable jobs, bounded retry/backoff, health
checks, distinct development/production secrets, and recovery of ledger state
must be demonstrated before live mode.

## AI failure behavior

The application remains deterministic when research calls time out or budgets
are exhausted. Expired research means no new AI-dependent entries; healthy
deterministic exits and withdrawals continue. If chain data also fails, halt
entries and use only bounded verified fallback exits, showing inability rather
than pretending safety. No research output is a probability unless calibrated
on held-out trades with a defined horizon, sample size, and uncertainty.
