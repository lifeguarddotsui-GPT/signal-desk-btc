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

`npm run backfill` checks up to four **previously observed, expired market IDs** per invocation. It is idempotent, resumable, and rate-limited by a two-minute retry interval. It does **not** invent or discover earlier market IDs. The dev server starts a read-only six-second polling loop after the database is ready. Settings live in the current browser; they do not modify other visitors' settings. The server validates setting values.

## Source map and exact interpretation

| Field | Source | Interpretation |
| --- | --- | --- |
| Market ID, expiry, pause, reference | Official `@mysten/deepbook-v3` `read.markets()` over Sui mainnet gRPC | Observed on-chain active-market data. Some listed markets can be expired or unsettled; a reference can be null. |
| "1-minute" identification | Adjacent market expiries exactly 60 seconds apart in the same SDK response | **Inferred cadence, not an explicit field in the SDK**. A single market is not labeled 1m. Start shown as `expiry − 60 seconds` is an inferred nominal window, not a verified on-chain start. Ambiguous or missing candidates result in HOLD. |
| UP/DOWN indicative probability | Official SDK `read.price({underlying:'BTC', expiryMs, strike:'reference'})` | Theoretical on-chain board probability, **not an executable quote, calibrated estimate, BTC oracle spot, or guarantee**. |
| Settlement for a *known* market ID | Official generated `expiryMarketMoveCalls.settlementPrice`, read-only Sui gRPC simulation | Settlement price in USD. UP requires strictly greater than observed reference; DOWN includes equality. Unsettled/failed reads remain unknown. |
| BTC comparison tick | Coinbase Exchange public `BTC-USD/ticker` | Independent comparison feed and chart only; **not** DeepBook's settlement oracle. Tick is rejected when older than 20 seconds. |

Source precedence: market identity/reference and settlement come from on-chain official reads only. Coinbase never overrides contract data. Missing or disputed fields remain null/unknown. Time is stored as UTC ISO timestamps or epoch milliseconds, without rounding source expiry. `read.price` is labeled "indicative" throughout, never "executable." Incoming fields are checked for plausibility; SDK/network errors make live status stale or unavailable.

References: [DeepBook Predict SDK markets](https://docs.sui.io/onchain-finance/deepbook/deepbook-predict-sdk/markets), [Sui gRPC](https://docs.sui.io/concepts/data-access/rpc-overview), [Coinbase Exchange API](https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproductticker).

## History audit and data health

**Historical coverage is incomplete by design, not a zero-gap claim.** The official active-market SDK does not enumerate every past one-minute round, and there is no documented anonymous historical executable quote archive used here. Public chain settlement may be recoverable for *known* IDs, but that does not identify all prior rounds or reconstruct their old quote states. At rebuild time, no independently validated historical complete series was available. The app begins **prospective** capture once started; it never seeds example rounds into production or fills historical gaps with guessed odds. Earliest and latest verified observations, observed count, settled count, and indicative snapshot count are reported live in History/Data Health. Expected full-history round count and pre-capture coverage percentage are **unknown**, not 100%. Any interval with no polling due to outage remains a gap; duplicate IDs are deduplicated by on-chain object ID, and database snapshots are append-only.

New records use two isolated `btc_predict_*` tables. The normalized row is keyed by on-chain market object ID. Immutable raw JSON snapshots have deterministic 15-second deduplication keys; they preserve observed market list, selected round, data source and ingestion timestamp. A later settlement updates normalized state, never rewrites a raw observation. Reference is set from the first non-null on-chain observation and does not change silently. CSV/JSON export includes only the first 1,000 stored rounds, newest first; there is no claim it is a complete archive. Exported "indicative samples" are *not* historical executable quotes.

## Model, payout, and risk limitations

The engine implements a chronological 100 training / 50 calibration / 50 later test split and evaluates held-out 50/50 and observed **indicative** on-chain probabilities using Brier and log loss only after 200 chronologically distinct, correctly labeled, pre-expiry-observed rounds are available. No trained logistic/volatility benchmark, calibrated production estimate, uncertainty interval, drift monitor, executable payout/fee schedule, or net-return claim is available yet. The Model page explicitly shows insufficient history rather than made-up scores. No historical quotes are inferred from outcomes. The decision gate requires a timely round, verified reference, calibrated probability, documented executable prices and payout/fees, and a configurable net-edge threshold; otherwise it returns **HOLD**. At present those inputs are unavailable, so it always returns HOLD. The threshold setting cannot override missing evidence.

The manual position form is for notes only. Hedge P&L is unavailable without a current, matching, executable opposite quote and verified payout/fee rules; an indicative DOWN probability is not proof that an UP hedge is good. No expected value or break-even is computed from unavailable data. Probabilities of an event and the probability of net profit are different questions. Loss of stake is possible.

## Verification and deployment

`npm run check`, `npm test`, and `npm run build` check the active implementation. Tests cover basic normalization/cadence evidence, chronological split, probability metrics, HOLD gates and hypothetical hedge arithmetic. More robust integration tests, disputed-settlement handling, full historical discovery, and calibration require independently verified data. To publish later, use the existing Replit deployment configuration only after explicitly deciding to publish; this rebuild does not publish or change external services.