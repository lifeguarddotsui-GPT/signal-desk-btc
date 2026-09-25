# Signal Desk — BTC one-minute research

This is an independent read-only research dashboard for DeepBook Predict BTC one-minute markets, not the old Blue Water/SUI Pump trading app. Read `README.md` before making data claims. No wallet connection, signing, execution, simulated trades represented as real, or promises of success. Manual user action is outside the application.

- Stack: Node 22, Express, React/Vite, TypeScript, existing PostgreSQL database with isolated `btc_predict_*` tables.
- Official on-chain SDK data supplies market identity, reference and indicative pricing. Coinbase BTC/USD is **only a comparison feed**, never the contract oracle. Null reference, unknown settlement, missing execution quotes/fees or stale market state must yield HOLD.
- Market cadence is inferred from adjacent 60-second expiries because official `read.markets()` does not return a cadence field; do not silently treat that inference as verified. Historical coverage begins with prospective capture; do not fabricate missing rounds, prices or performance.
- Prior application source is recoverable from tag `pre-deepbook-rebuild-2026-09-25`; existing legacy database tables, migration files, secrets, deployment configuration, and reports have deliberately been preserved.
- Commands: `npm run dev`, `npm run check`, `npm test`, `npm run build`, `npm run backfill`.