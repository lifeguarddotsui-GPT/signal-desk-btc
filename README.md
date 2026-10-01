# BluewaterAI

Advisory-only, read-only research for WaterX BTC 5-minute and 15-minute rounds. The interface describes market lean and data availability, but does not issue a qualified trade action, connect a wallet, sign, submit an order, or verify a fill. WaterX odds are market observations, not forecasts or executable quotes.

## Run locally

Node.js 22 is required. Run `npm ci`, then `npm run dev`; run `npm run check`, `npm test`, and `npm run build` before changes. Configure environment values privately; never commit real values. A compatible PostgreSQL database is needed for persisted learning observations.

See [PUBLIC_AUDIT.md](PUBLIC_AUDIT.md) for source interpretation, limitations, and tests. The WaterX provider API is unofficial and may change. WaterX's reported price-to-beat may be unconfirmed; Coinbase is comparison-only; displayed $5 gross-return arithmetic excludes unknown fees and gas. The product's Chainlink TWAP settlement description is not independently verified by this app.

Learning is prospective, interval-separated, and not model promotion. Data gaps are unknown; an idle autoscale deployment can sleep. Legacy DeepBook BTC material is retained as archive, not the current WaterX interface.

The allowlist intentionally includes legacy server modules required by retained routes/imports as well as WaterX modules, schema, and tests. It excludes deployment configuration, production data, backups, images, internal release notes, local workspace metadata, dated legacy audit reports, and the original private Git history.
