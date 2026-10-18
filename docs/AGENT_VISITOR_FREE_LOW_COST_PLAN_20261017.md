# Blue Water Agents — free-first, visitor-independent mainnet path
Updated 2026-10-17. **Design and dry-run work only. No signer deployment, order submission, wallet funding, schema migration, or production publication authorized by this document.**

## Confirmed baseline / why the user's funded wallet cannot trade

Owner: `0xf9c496…94f45ba` (exact public address is in `docs/WALLET_RECOVERY_TRADE_READINESS_RELEASE.md`).
The October 16 read-only Sui audit verified owner-linked WaterX account `0x57ee9069…c86761f` with 5,000,000 atomic USD = $5 credited. **This is not a current balance snapshot**; refresh before attempting owner-signed test.

Hardcoded production agent abilities: `/api/agent/capabilities` reports no mainnet; `/api/agent/control` rejects LIVE; `/api/agent/delegate` rejects signer creation; `/api/agent/owner-transaction AUTHORIZE` rejects mainnet restricted delegate; existing `shadowWorkerTick` cannot submit. Separately, `bluewater_agent_execution_control.disabled` is default true and owner API can only disable it. Current table state constraints do not include LIVE. These are deliberate safety gates, **not a wallet linking bug**.

Default policy: $5 fixed order and $5 per round, $2 reserve, $5 max unresolved, $10 daily turnover, zero session SUI gas budget. Under the idealized scenario of exactly $5 credit, no positions/no other turnover and no pending reservations, existing `sizePosition` reduces a hypothetical stake to **$3**, not $5; actual gas/fees/position state are still unknown. `previewPilotBudget` in this branch is a **read-only preflight**; never treat it as order eligibility or proof of current account balance. No owner wallet or private key needs to be imported into a service.

## What already works without visitors

- Existing `edge/worker.ts` uses a Cloudflare **one-minute Cron watchdog** to bootstrap a SQLite Durable Object. Its alarm polls WaterX independently of Replit at `POLL_MS=5000`, 5m every tick and 15m every other tick, and stores bounded snapshots in D1. It is a **26-hour trial**; `TRIAL_WINDOW_MS` and auto-stop prevent assuming this is an operational continuous collector.
- `edge/execution-feasibility.ts` has already demonstrated **31 minutes of browser-independent** scheduled 30-second gate evaluation, test-key encryption/recovery, SDK compatibility and synthetic durable reservations, with *no* funded tx. See `docs/cloudflare-execution-feasibility-pass.md`.
- This branch adds receipt-only `UNKNOWN->ACCEPTED` mainnet finality checking and strict kill-switch guards, but it is not wired to a running runtime.

### Measured free-tier budget, not a guarantee

The October 5 bounded feasibility probe measured roughly 373 alarm polls / 746 source reads in 31m, median 3ms DO CPU, and partial telemetry that projected **about 6,146 GB-s/day** and **46,266 DO SQL writes/day** at that workload. Cloudflare Free allowance at the time: 13,000 GB-s/day, 100,000 DO SQL rows written/day, 100,000 DO requests/day. These projections exclude added signing, settlement, history and other project usage. One five-second alarm stream implies `86400/5=17280` alarm invocations/day, and one Cron/minute means 1440 Cron triggers/day. The current dual-interval collector makes 17,280 5m plus 8,640 15m requests/day at that cadence (before retries). Measure aggregate Free usage and upstream provider limits before enabling any perpetual loop.

The probe logged a late gate of 2,133ms against 2,000ms grace. **Alarm invocation is at least once, not deterministic**. Persist scheduled timestamp, actual firing, provider receipt time and hard deadline; skip/trust-no-signal when late or stale, not catch-up trade. Do not lower polling under the present `maxAgeMs=10000/maxGapMs=12000` policy without proving unchanged qualifying/latency coverage. Any adaptive schedule must have reproducible offline equivalence tests and real Cloudflare benchmark gates.

## Proposed smallest cost footprint

1. **Leave the Replit UI visitor-only.** It becomes a read-only client for Cloudflare's durable records; it does not own the canonical unattended decision clock or custody. No browser-based timer may be required for an executable decision.
2. **One shared DO for public market collection + one canonical gate engine**, not a separate process for every 5m and 15m round. Persist provider timestamp/source, exact provider market ID, observed odds, official reference confirmations, 30s gate result, and policy version. Issue immutable event IDs. One-minute Cron is only a watchdog if alarms disappear, not the precision trade scheduler.
3. **Operational state in DO SQLite**, limited D1 snapshots/history. Do not wake Replit PostgreSQL on every market tick, lock, quote, or order. Replit/PG receives **occasional archival batches**, at most daily until costs are verified. This requires explicit data migration/reconciliation; never remove historical DB or backups just to reduce cost.
4. **Separate isolated signer authority**: owner-controlled Cloudflare account/security principal and durable wallet serialization + signer state. Public website MUST NOT possess Cloudflare deployment/manage-secrets credentials or access a deploy-authorized connector. Old credentials currently present in Replit shared/dev/prod according to the prior October audit, and still need owner removal/provider revocation/fresh verification. No funded signing from current shared control plane.
5. **Few task events**: the signer wakes only when a legitimately qualified signed decision, owner session, current market and executable quote exist. It checks policy/permission/balance/gas fresh, reserves collateral, simulates and submits only one owner-authorized order. No continuously polling signer and no repeated wallet connect.
6. **Recovery worker** handles uncertain digest, partial fills, position expiration and settlement even when session is PAUSED, but cannot release UNKNOWN on timeouts and cannot issue new trades if cost quota/source health fails. A single log/event receipt per meaningful state, not per display frame.
7. **Research outside critical path**: aggregate 5m and 15m evidence daily without waking PostgreSQL constantly. Track actual fills, costs, WaterX verified Chainlink TWAP60 outcomes and prediction-vs-execution latency. A one-off experimental pilot need not assert a demonstrated edge; any recurring profitable-autonomy claim requires forward evidence.

## Fastest safe first-order path

- Confirm current WaterX USD balance + any active positions and **independently** verify owner account and available delegate gas. Reset no counters without evidence.
- Build and simulate **owner-signed single order** with Slush at a small capped amount (for example $1–$2, if current fee-inclusive official order quote and selection mapping actually support it). This uses the already connected wallet and does **not require autonomous signer availability**. Signing and submission are owner-only after inspecting a verified exact-market transaction. The current API does not support this yet; must implement and test the owner-order endpoint separately, and it must stay disabled until approved.
- Reconcile actual digest, order ID, filled quantity, fees, outcome, and settlement. No claims based on a confirmed tx alone.
- Only then owner-authorize **PLACE_ORDER-only** delegate permission; independently test negatives for withdrawals/management, permit nonce replay and revoked/expired authorization. Pilot exactly one autonomous signed order, review full account recovery and stop behavior.
- Following 1-order success, test 24–72h continuous **shadow** decisions and free quota, then a bounded owner-approved 1h session with conservatively limited capital and gas. Do not turn on compounding or multi-wallet autonomy by default.

## Action required outside GitHub

An authorized Cloudflare operator must separate web deployment credentials from signer administration and demonstrate independent runtime/recovery; GitHub code cannot do this. Owner must individually approve Slush transactions and session permissions. Never paste a seed, private key, signing permit, deployment API token or environment secret into chat, issue comments, CI or Replit shell output.

Before merging, rebase against the final production Live Desk SHA and compare evolving 5m/15m decision engine fields. CI+one-off feasibility do not alone prove the first live execution. Retain backed-up data and a published kill switch.
