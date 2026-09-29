# BluewaterAI — WaterX BTC round research

An advisory-only, read-only interface for WaterX BTC **5-minute and 15-minute** up/down rounds. It always reports **HOLD**: it does not generate an order, connect a wallet, sign or submit a transaction, or verify a fill. WaterX odds are provider-reported market values, not BluewaterAI forecasts or verified executable prices.

## Run locally

Use Node.js 22. Configure `DATABASE_URL` privately for PostgreSQL if you want to persist prospective observations; `PORT` is optional (default 5000). Never commit secrets or populated environment files.

```sh
npm ci
npm run dev
npm run check
npm test
npm run build
npm run start
```

The app has separate interval selectors and learning records for 5m and 15m. Its read-only endpoints are `/api/waterx/live?interval=5`, `/api/waterx/history?interval=5`, `/api/waterx/model?interval=5`, and `/api/waterx/chart?interval=5`; use `interval=15` for the distinct 15-minute market. Only `interval=5` or `interval=15` is accepted. A live round links to its WaterX page at `https://waterx.app/en/predict/market/crypto/crypto-btc-updown-{5m-or-15m}/{round-start-epoch-seconds}`. These public endpoints and pages are controlled by WaterX and may change.

## Sources and interpretation

- **Round, price-to-beat, and odds:** the app reads WaterX's unofficial public API at [`api.waterx.app/predict/markets/crypto`](https://api.waterx.app/predict/markets/crypto). The displayed price-to-beat is WaterX `round.anchorPrice`; the provider may mark `anchorPriceConfirmed` false. In that case it remains explicitly unconfirmed. A value from Coinbase is never substituted.
- **WaterX odds/probabilities:** the public API's UP/DOWN odds and probability fields are observations of the market, not forecasts, proof of available inventory, executable quotes, or verified fills. The displayed **$5 indicative gross return** is arithmetic based on the reported odds, before unknown fees and gas; it is not buyable or guaranteed, and does not establish net payout or profit.
- **Settlement description:** WaterX describes resolution using the Chainlink BTC/USD TWAP relative to the round's beginning reference: TWAP **greater than or equal to** the anchor is Up; below is Down. The app can check that WaterX reports a resolved result, a confirmed matching anchor, a settle price, and a consistent outcome. It does **not** independently query Chainlink or independently verify the TWAP, the provider's source data, contract semantics, or settlement.
- **Coinbase:** a separate BTC-USD comparison chart/feed only. It is not the WaterX price-to-beat and is never settlement evidence.
- **Action:** HOLD, with no order construction, order placement, wallet action, or hedge.

The WaterX HTTP/API contract is unofficial and subject to change. Errors, stale observations, missing fields, and unconfirmed anchors are surfaced as unavailable/unknown rather than repaired with guessed data. A provider response or displayed market probability is not evidence of tradeability.

## Prospective learning and data limitations

The 5m and 15m evidence streams are separate. The WaterX learning table uses `(interval_minutes, round_id)` as its key, freezes the first usable pre-expiry market probability, and accepts a scored label only when the provider reports a resolved round with a confirmed matching anchor, settle price, a consistent reported outcome (TWAP >= anchor means Up), and settlement time strictly after expiry. This is an application-side consistency policy, not independent Chainlink verification. Incomplete or inconsistent settlement evidence is retained as withheld/unresolved rather than promoted to a label.

Learning is **prospective only**: the app does not backdate forecasts or fill pre-capture periods. Observed rows do not prove complete round coverage. Collector outages, rate limits, missing provider rounds, and periods while the process is asleep are unknown gaps; no completeness percentage or complete historical archive is claimed. The collector runs only while the server is awake. Previously observed unresolved rounds can be retried from the database after restart, but an idle autoscale deployment can still sleep and miss entire rounds.

The learning summary evaluates the frozen WaterX market-probability baseline independently per interval using a chronological 70/30 split with an embargo. Its readiness thresholds (300 eligible rounds and at least 50% observed cadence coverage; 48 hours for 5m or 7 days for 15m; bounded gaps and minimum split sizes) determine whether a descriptive evaluation can be shown. They do not promote a model. No model is promoted, no calibrated forecast is offered, and both intervals remain advisory HOLD-only learning exercises.

## Legacy archive

Historical source, endpoints, migrations, reports, and database records from the previous provider remain in the workspace for audit and preservation. They are an archive, not the current WaterX 5m/15m interface or its source of prices, odds, settlement evidence, or economics. This change does not delete, migrate, or rewrite that material.

For the file-by-file source map, limitations, and safe public-export instructions, see [PUBLIC_AUDIT.md](PUBLIC_AUDIT.md).