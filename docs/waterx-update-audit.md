# WaterX BTC dashboard update — development verification

**Status:** Implemented and tested in the development workspace only. The published site at `https://bluewaterai.app` has **not** been updated by this work. This is not a production acceptance or trading authorization.

## Baseline and source identity

- At audit, the published package reported build `sha256:859a2b704a8944bfceef2dbfe1d65e78772ad91170f431fe83d22cb102635a7c`, source commit `65d9e809bd2a9d8079f201982b368018f1c699f0`, built `2026-09-29T23:35:18.765Z`, schema `schema-sha256:af3836a096d691042d07e1874592fb4238a5750233042777218c6853e845f3fb`. The development checkout was at `67dc884de01a70cee2028e66412009fa7d58bf7b` before these changes. The published commit is an ancestor of that checkout, **not this tested build**. Development reports `dev/unbuilt`, not a packaged identity.
- Only `gitsafe-backup` was configured as a Git remote. A public GitHub destination was not verified; no source was pushed to an invented destination.
- Legacy `/api/health` and `/api/model` are not WaterX measurements. New `/api/waterx/version` and `/api/waterx/health?interval=5|15` expose WaterX-specific status, separate interval diagnostics and settlement queue summaries. No WaterX-trained model has been promoted.

## Changes

- A single-flight, bounded per-interval WaterX refresh serves stale/missing/expired snapshots; independent background collection remains. Interval diagnostics expose last fetch, valid observation, errors and retry. A legacy learning query no longer blocks the 3-second live-price route. An early future-round preview cannot suppress the still-active round.
- Both 5m and 15m show the WaterX-reported beginning reference and market odds. Coinbase is labeled *comparison only*. Stale/unmatched/expired WaterX data cannot carry odds or a reference into the next round. The app remains read-only and cannot place orders.
- Current-round, last-5m and last-15m charts use a new additive Coinbase tick archive across server restarts. Bounded reads preserve endpoints/extrema, expose partial coverage, and show breaks without interpolating gaps. Sparse legacy snapshot prefixes, when used, are labeled. The additive migration was applied **only to the development database**. An unmigrated target still serves sparse legacy history explicitly labeled as partial.
- On mobile the HOLD/WITHHELD summary appears above the comparison chart. SSE reconnection handles server restart cursors, including zero, and reloads the archive. Source, interval and freshness gates are checked before presenting live market data.
- Indicative $5 sizing divides the selected amount by each displayed side price, separately. It is gross arithmetic, **not** an executable quote, net return, or profit. Executable fees, gas, rounding, slippage and payout remain unverified; `/api/economics` fails explicitly.

## Verification and limitations

- TypeScript, production bundle build and 146 automated tests passed in development, including focused source, archive, restart-cursor, round-guard and UI-contract tests. Post-restart HTTP checks returned LIVE for both durations, separate collector diagnostics, stored Coinbase tick coverage and 400 for invalid chart windows. Desktop preview console showed no application errors.
- At a development health check near `2026-09-30T01:39:50Z`, provider-reported settlement-to-app-acceptance latency summaries were 5m: 12 samples, p50 105,174.5ms, p95 5,913,384.45ms, p99 6,060,054.49ms; 15m: 5 samples, p50 110,235ms, p95 4,903,635.2ms, p99 5,856,817.44ms. These are **not** feed-to-user latencies or a service-level guarantee. Samples include delayed recovery and immediate acceptances; clocks may differ.
- The new archive starts when the updated development collector runs. Its first 15m response had about 30 seconds of stored tick coverage and correctly reported **partial**. No complete two-round/30-minute observation or physical-phone latency trace has been completed. The 320×720 capture uses Chromium emulation, not a physical device.
- A published autoscaling process may sleep while idle. On-request refresh cannot reconstruct unobserved rounds. An always-on collector and a separately verified recovery/backup plan are prerequisites before promising complete production history. No production migration or deployment occurred.
- A timestamped WaterX BTC preview price trace, independent Chainlink TWAP window/evidence, executable WaterX quotes/costs, and statistically qualified 5m or 15m WaterX forecasts remain unverified. The chart is **Coinbase comparison, not WaterX's own trace**; no live net edge or predictive improvement is claimed.

## Rollout and rollback

1. Verify a recoverable production database backup, then explicitly approve the additive archive migration and an always-on collection target. Confirm source destination and official WaterX/Chainlink evidence; never substitute Coinbase for settlement.
2. In a controlled publish, observe complete 5m and 15m rounds, both settlement queues, full-window archive coverage, API health and mobile rendering. Compare source/build/schema identity against the published package and capture p50/p95/p99 for *measured* pipeline stages and missed-round counts.
3. Publish only after separate approval. Roll back the application package if it mislabels data or degrades freshness. Leave the additive table and historic records intact; never delete or rewrite earlier observations. Withhold actionable data when dependencies fail.