# Signal Desk public audit guide

Signal Desk is a read-only BTC one-minute research console. It has no trading wallet or order submission. Source visibility does not establish forecast accuracy, trade profitability, or uninterrupted collection.

## Reproduce

1. Install Node 22 and run `npm ci`, `npm run check`, `npm test`, and `npm run build`.
2. Copy `.env.example` to a local environment configuration and supply values **privately**. Never commit a populated `.env`, key, token, production export, or uploaded user image.
3. Inspect `server/btc/engine.ts` for the exact decision gate and `server/btc/service.ts` for the inputs used by `/api/live`. `scripts/btc.test.ts` exercises fail-closed and audit cases.
4. Inspect `server/btc/evidence.ts` for input checks and board tilt. `scripts/evidence.test.ts` exercises missing and stale inputs.
5. Inspect `server/btc/model.ts`, `server/btc/store.ts`, and `scripts/model.test.ts` for prospective versus retrospective evaluation and the multi-day shadow-model gate.

## What HOLD means

`/api/live` returns `recommendation` and `decisionAudit` from the **same evaluation**. The audit has a snapshot time, source and observation for each check, a required condition, and a status (`PASS`, `BLOCKED`, or `NOT_EVALUATED`). The policy requires an eligible round with more than 8 seconds remaining, a positive on-chain round reference, a promoted calibrated forecast with at least 200 qualifying samples, verified executable UP/DOWN prices and net payout after fees, and a calculated net edge greater than 5%. If any prerequisite is missing, net edge is **not calculated**. HOLD is a safety decision, not a prediction that the market will stay flat. The interface can display a prior API snapshot briefly while a new request is in flight; check the snapshot time and the round countdown.

The separate input checklist uses policy-assigned weights of 25/25/10/15/25 for round/reference, indicative board, comparison tick, uninterrupted recent comparison samples, and promoted forecast. These weights are **not learned from outcomes** and must not be interpreted as win probability or statistical confidence. The checklist also reports the unweighted count passing. Predictive confidence is unavailable without an independently qualified model. A board probability is an indicative on-chain observation, not the app's prediction or an executable fill. Coinbase is only a comparison feed, never the DeepBook settlement oracle. The app does not infer contract equality/void, actual payout, or profitability from that feed.

## Publish without leaking workspace history

The working Git history tracks more than a thousand user-uploaded images. **Never push or mirror that history to a public repository**, even if files are deleted in a later commit. `node --import tsx scripts/export-public.ts` stages a fresh, allowlisted source tree in a temporary directory; review the output, add a chosen open-source license, initialize a **new** public Git repository there, and publish only that fresh history. It excludes uploads, screenshots, backups, internal release-review notes, generated outputs, local workspace metadata, database data, credentials, and secrets. `.gitignore` protects new files in this workspace but cannot erase files from existing Git history. Security review must precede publication; an allowlist is not a substitute for human review.