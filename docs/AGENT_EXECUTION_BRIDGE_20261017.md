# Blue Water Agent — independent execution bridge (October 17, 2026)

**Scope:** agent, wallet authority, worker and trade evidence only. No Live Desk UI changes, Replit Agent, production migration, signer deployment, or real-money orders.

**Base:** `release/waterx-chainlink-source-integrity-20261017`. This is an isolated integration candidate, not the current production revision. Reconcile it against the final Live Desk release before merging.

## Current block-by-block assessment

| Blocker | Evidence in source | Work required before live release |
| --- | --- | --- |
| Mainnet execution disabled | `/api/agent/capabilities` is hardcoded off; `/control LIVE` refused and kill switch can only disable. | Keep disabled until every gate below passes. Two-person review of an exact source SHA and a separately authorized one-order pilot; only then ship an explicit release operation. No secret or environment variable may bypass the gate. |
| Isolated signer not operational | `infrastructure/agent-signer/protection.ts` contains encrypted delegate and transaction checks, but no deployed authenticated signing runtime, durable nonce consumption or operational key recovery. | Deploy separate signer from an owner-approved immutable artifact. Non-exportable wrapping key in its own security principal; durable permit replay prevention, per-wallet serialized one-order authorization, scoped invocation auth, denial of all arbitrary transactions. Remove Cloudflare deployment credentials from web/editor/managed connectors and prove separation/revocation. |
| Real order execution & fill handling absent | SDK order builder + simulation exist. No executable two-side quote adapter, authorized signer submission, on-chain fill reconciliation or settlement accounting connected. | Bind exact WaterX market/round/YES-NO mapping, account credit, settlement asset, fee-aware quote, price cap, min shares, max spend, expiry, gas, simulation and risk checks. Atomic reservation before signing; persist UNKNOWN before submit, one submission identity, never blind-retry. Derive partial/full fills and settlement from independently validated WaterX on-chain evidence, not a successful transaction alone. |
| Browser-independent trading worker absent | `shadowWorkerTick` is development-only and intentionally cannot submit. Live collectors depend on visitor/Autoscale behavior. | Dedicated bounded scheduled worker under separate runtime, with durable event source, idempotent checkpoint, health/lease, exact-round dispatch and reconciliation. No extra paid machine by default; evaluate Cloudflare Free limits and observed latency before choosing hosting. |
| Prediction advantage unvalidated | Research/advisory estimates and indicative public asks are not confirmed executable edge. | Chronological holdout samples, real historical submitted/fill price and fees, verified WaterX Chainlink TWAP60 settlement, calibration and confidence intervals. Monitor adverse selection, fill rate, missed-lock timing and realized net results. Do not promote a model based on a synthetic win-rate or chart color. |

## What this branch adds

- `server/agent/submission-reconciliation.ts`: independently invoke a pinned Sui mainnet RPC for a **persisted** transaction digest and promote only `UNKNOWN -> ACCEPTED` when the *exact digest* has successful finalized transaction effects on the pinned network.
- `scripts/run-agent-submission-reconciliation.ts`: one-pass, browser-free optional runner. This is *not* wired into server startup, requires explicit `BLUEWATER_RECONCILE_MODE=submission-finality-only`, uses an existing database connection and **cannot submit, sign, claim or release funds**.
- Unit regressions cover identity mismatch, stale/incomplete network receipt, failed effects, RPC outage, empty queue, concurrency and duplicate proof. This work does **not** establish filled shares or an edge.

A completed Sui transaction is evidence that the transaction succeeded on chain, not that an order was fully/partially filled. Reservations remain consumed until separately verified zero-collateral-spend/cancel proof. An absence of RPC events is not proof of no fill. `ACCEPTED` is *not* `FILLED`, `SETTLED`, `CLAIMED` or realized profit.

## Required launch order and acceptance tests

1. **Preserve operator safety.** Verify release source SHA, backed-up production DB, approved owner account, security boundaries, Cloudflare/Replit permissions and immutable rollback. Keep kill switch ON throughout tests. Never paste a key/seed/invocation token into chat or GitHub.
2. **Permission proofs.** Owner explicitly signs a time-bound session permit and on-chain delegate authorization with **only WaterX PLACE_ORDER (prediction mask 1)**. Negative-test account-management mask 0: withdrawal, transfer, delegate add/remove, changing account owner, claims and changing limits must all be denied. Check owner revocation and expiry take effect on chain.
3. **Signer pilot runtime.** Provision independent isolated worker / durable storage, authenticated requests, at-rest AES-GCM delegate envelope, nonce uniqueness, key rotation and tested recovery. Separate web deploy rights. Fail closed without a current policy digest, scoped owner signature, verified on-chain delegate and independent wallet lock.
4. **Executable economics adapter.** Read exact current official market/round ID and selection mapping, both executable asks, fee-inclusive spend/payout, slippage/min-shares/gas and max expiry. Run negative cases: wrong round, odds-only quote, stale quote, disputed reference, >$5 all-in, no balance, market paused, 5m/15m rollover.
5. **One-order orchestration.** Atomic per-wallet/per-round reservation, check clock and current owner policy, verify effective delegated permission, successful simulation, exact signed bytes, durable UNKNOWN-before-submit and one idempotency key. Persist resulting digest *before* external submission. No automatic repeat on ambiguous network response; reconcile by digest and order ID instead.
6. **Independent collection.** Deploy a scheduled heartbeat/worker (without browser visit) with budgeted polls and persistent checkpoints; detect missed rounds and stale sources. Avoid simultaneous runners per wallet and uncontrolled cost. Run the receipt-only task with an isolated least-privilege DB user; do not let public web requests schedule it.
7. **Order ledger.** Decode/validate provider on-chain fill events, partial fills, unfilled refund/release, settlement and terminal result. Match account, market, round, side, actual quantity, fees and digest. Record actual spend and profit, including explicit gas separately. Never infer true outcome from Coinbase price or odds/chart fill.
8. **Independent performance validation.** Assess 5m and 15m separately on out-of-sample data using WaterX official Chainlink TWAP60 settlement and **actual achievable entry price/fill**, not estimated odds. Require a credible positive net expectancy across costs and sufficient sample size before autonomous recurring mainnet trading.
9. **Owner-approved pilot.** After all gates verified, manually authorize exactly one capped mainnet order with a fresh owner signature and emergency stop. Audit final order, fills, settlement, pause/revocation, credited balances and resource spend before considering an autonomous session.
10. **Production promotion later.** Merge/rebase agent branch with the final UI release after full tests and source-drift review, acquire exact-SHA approval, deploy through established GitHub→Replit procedure without Replit Agent, and verify successful smoke tests and rollback. No automatic publish from this branch.

### Operating the optional receipt-only task (later, after approved DB setup)

```bash
BLUEWATER_RECONCILE_MODE=submission-finality-only \
DATABASE_URL="<secure least-privilege agent database connection>" \
node --import tsx scripts/run-agent-submission-reconciliation.ts
```

Never run the command against production solely because the branch exists. The worker writes only a narrowly scoped transaction-finality update when previously persisted UNKNOWN has proven success; it does not infer fills, recover collateral, or enable live orders. The runner is **not** a functioning autonomous trading bot by itself.

### Agent code acceptance commands

```bash
npm ci
npm run check
node --import tsx --test scripts/agent-submission-reconciliation.test.ts
npm test
npm run build
```

Any failure, unverified signer/permissions, failed funding or gas proof, missing fill adapter, missing live worker, or insufficient edge means **mainnet trading stays disabled**. Neither passing local tests nor a green GitHub PR alone clears an external operational gate.
