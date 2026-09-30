# BluewaterAI — WaterX BTC round research

This is an independent, advisory-only research dashboard for WaterX BTC 5-minute and 15-minute markets. The former DeepBook BTC one-minute research paths are legacy, not the current WaterX product. Read `README.md` and `docs/waterx-production-rollout-gate-2026-09-30.md` before making data or release claims. No wallet connection, signing, execution, simulated trades represented as real, or promises of success. Manual user action is outside the application.

- Stack: Node 22, Express, React/Vite, TypeScript, existing PostgreSQL database with WaterX research tables and preserved legacy `btc_predict_*` tables.
- WaterX supplies market identity, beginning reference and public probabilities/indicative prices. Coinbase BTC/USD is **only a comparison feed**, never the Chainlink settlement oracle. Null or unconfirmed references, disputed settlements, missing execution quotes/fees, and stale market state cannot produce an economic-edge or qualified-model claim.
- WaterX 5m and 15m rounds are distinct cohorts. Historical coverage begins with prospective capture; do not fabricate missing rounds, prices or performance. Candidate models remain unpromoted until genuine forward evidence supports them.
- Do not publish schema or collector-topology changes until a current complete production backup is restored in isolation and reviewed, and do not enable additional recurring hosting without explicit cost approval.
- Prior application source is recoverable from tag `pre-deepbook-rebuild-2026-09-25`; existing legacy database tables, migration files, secrets, deployment configuration, and reports have deliberately been preserved.
- Commands: `npm run dev`, `npm run check`, `npm test`, `npm run build`, `npm run backfill`.