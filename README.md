# BluewaterAI

Read-only BTC one-minute research console. The current BTC UI does not connect a trading wallet, sign, or submit orders. HOLD is a safety decision, not a price prediction.

## Run locally

Node.js 22 is required. Run `npm ci`, then `npm run dev`; run `npm run check`, `npm test`, and `npm run build` before changes. Configure local environment variables privately using the names in `.env.example`; never commit real values. A compatible PostgreSQL database and supported market-data sources are required for live collection.

See [PUBLIC_AUDIT.md](PUBLIC_AUDIT.md) for the precise decision rule, evidence limitations, file map, and test commands. This repository contains all current application source, tests, and migration definitions, including historical custody/auth schemas. It intentionally excludes deployment configuration, production data, backup files, images, internal release notes, workspace metadata, and the original private Git history.

Availability checks and indicative market odds are not a calibrated predictive confidence score. Neither a backtest nor an observed probability establishes a profitable executable trade.
