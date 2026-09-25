# Signal Desk — BTC one-minute research

An independent, read-only dashboard for studying the BTC one-minute market on DeepBook Predict. **It does not choose a profitable trade for you.** It does not connect a wallet, sign or place transactions, read private positions, or submit hedges. The user decides and acts elsewhere.

This rebuild replaced the previous Blue Water/SUI Pump application source. Its recoverable Git tag is `pre-deepbook-rebuild-2026-09-25` (created before source replacement). Legacy database tables, migration history, deployment settings, secrets, and historical report data were not deleted or migrated. Old dependencies and obsolete application source were removed. This project uses Node 22 because the official Predict SDK requires it.

## Run

Provide `DATABASE_URL` using the workspace's secret manager, with access to the existing PostgreSQL database. `PORT` is optional (default 5000); `NODE_ENV` is set by the npm scripts. No wallet secret or DeepBook API key is required. The previous project's `.env.example` is preserved for historical reference; its old credential names are not used by this app.

```sh
npm ci
npm run dev
npm run check
npm test
npm run build
npm run start
npm run backfill
```

`npm run backfill` checks up to four **previously observed, expired market IDs** per invocation. It is idempotent, resumable, and rate-limited by a two-minute retry interval. It does **not** invent or discover earlier market IDs. The server runs read-only discovery and settlement reconciliation every six seconds **while the process is awake**. State is persisted in PostgreSQL, so known unresolved rounds are retried after restart. The worker heartbeat and failures are visible at `/api/health`; stale heartbeat is a failure, not proof of continuous collection. The current autoscale deployment may sleep without traffic; uninterrupted capture requires an independently scheduled or always-on worker, which is **not yet configured**. Browser refresh settings do not affect server capture.

## Source map and exact interpretation

| Field | Source | Interpretation |
| --- | --- | --- |
| Market ID, expiry, pause, reference | Official `@mysten/deepbook-v3` `read.markets()` over Sui mainnet gRPC | Observed on-chain active-market data. Some listed markets can be expired or unsettled; a reference can be null. |
| "1-minute" identification | Adjacent market expiries exactly 60 seconds apart in the same SDK response | **Inferred cadence, not an explicit field in the SDK**. A single market is not labeled 1m. Start shown as `expiry − 60 seconds` is an inferred nominal window, not a verified on-chain start. Ambiguous or missing candidates result in HOLD. |
| UP/DOWN indicative probability | Official SDK `read.price({underlying:'BTC', expiryMs, strike:'reference'})` | Theoretical on-chain board probability, **not an executable quote, calibrated estimate, BTC oracle spot, or guarantee**. |
| Settlement for a *known* market ID | Official generated `expiryMarketMoveCalls.settlementPrice`, read-only Sui gRPC simulation | Settlement price in USD. A strictly higher price is UP, strictly lower is DOWN. Equality and void rules have not been independently established: equality stays UNKNOWN; unsettled/failed reads remain unresolved. |
| BTC comparison tick | Coinbase Exchange public `BTC-USD/ticker` | Independent comparison feed and chart only; **not** DeepBook's settlement oracle. Tick is rejected when older than 20 seconds. |

Source precedence: market identity/reference and settlement come from on-chain official reads only. Coinbase never overrides contract data. Missing or disputed fields remain null/unknown. Time is stored as UTC ISO timestamps or epoch milliseconds, without rounding source expiry. `read.price` is labeled "indicative" throughout, never "executable." Incoming fields are checked for plausibility; SDK/network errors make live status stale or unavailable.

References: [DeepBook Predict SDK markets](https://docs.sui.io/onchain-finance/deepbook/deepbook-predict-sdk/markets), [Sui gRPC](https://docs.sui.io/concepts/data-access/rpc-overview), [Coinbase Exchange API](https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproductticker).

## History audit and data health

**Historical coverage is incomplete by design, not a zero-gap claim.** The official active-market SDK does not enumerate every past one-minute round, and there is no documented anonymous historical executable quote archive used here. Public chain settlement may be recoverable for *known* IDs, but that does not identify all prior rounds or reconstruct their old quote states. At rebuild time, no independently validated historical complete series was available. The app begins **prospective** capture once started; it never seeds example rounds into production or fills historical gaps with guessed odds. Earliest and latest verified observations, observed count, settled count, and indicative snapshot count are reported live in History/Data Health. Expected full-history round count and pre-capture coverage percentage are **unknown**, not 100%. Any interval with no polling due to outage remains a gap; duplicate IDs are deduplicated by on-chain object ID, and database snapshots are append-only.

The normalized round is keyed by on-chain market object ID. Immutable raw JSON snapshots have deterministic 15-second deduplication keys; they preserve the observed market list, selected round, source and timestamp. A later settlement updates normalized state, never rewrites a raw observation. Reference is set from the first non-null on-chain observation. CSV/JSON exports paginate the complete observed archive; "indicative samples" are *not* historical executable quotes. The new prospective predictions table records one immutable HOLD/no-model record for each new snapshot captured before expiry; one baseline snapshot in the **45–30 seconds remaining** window is selected per settled round for idempotent scoring. Historical raw snapshots are retained for retrospective baseline/model research, but no historical forecast is backdated.

## Model, payout, and risk limitations

The Live screen defaults to a chart-first Simple view; Research shows the individual evidence checks. The chart uses timestamp-spaced Coinbase comparison snapshots, leaves breaks for observed sampling gaps, and shades above/below the current on-chain reference **only as comparison context**. The labeled evidence-quality score is a deterministic tally of an active round/reference (25), fresh indicative board (25), fresh comparison tick (10), three recent uninterrupted comparison samples (15), and an independently validated promoted model (25). It is an **input-availability score, not model confidence, a win probability, or proof of signal accuracy**. An indicative board tilt is shown separately from the HOLD recommendation and never used as a trade instruction. No calibrated predictive confidence score is available yet.

The Model page separates **prospectively scored** rounds from retrospectively available historical snapshots. Retrospective tests use fixed pre-expiry observations, chronological train/calibration/test partitions, and Brier/log-loss scores for 50/50 and on-chain indicative baselines. A regularized logistic challenger with held-out calibration remains shadow-only and needs multi-day independent data. Even a completed training job does not qualify a live calibrated forecast or confidence rating. There is no promoted champion, verified executable quote, payout/fee schedule, net-return evaluation, or supported hedge. The server HOLD gate requires all of those missing inputs before a directional suggestion. Coinbase comparison data is never substituted for the settlement oracle. Neither a probability of an event nor a good backtest proves profitability.

## Verification and deployment

The pre-upgrade source is tagged `pre-btc-learning-upgrade-2026-09-25`. A read-only export of the production round and immutable observation tables is at `backups/pre-upgrade-production/` (709 rounds and 2,800 snapshots at the recorded cutoff); files are intentionally Git-ignored, so retain a copy outside the workspace for disaster recovery. The development schema additions are described in `migrations/btc-learning.sql`. The published site currently serves an earlier Signal Desk build with prospective baseline records; the chart-first Simple view, evidence-quality context, and updated learning page in this workspace have **not** been published. Replit Publish reviews development-to-production schema differences. **Never choose “overwrite data” during Publish.** Tests, owner review, a deliberate always-on collection plan, and an audit of at least three new production rounds with actual pre-settlement forecasts remain release requirements.