# Blue Water AI · Real WaterX entry-quality release gate · 2026-10-16

## Exact user evidence and non-evidence
WaterX position screenshot: October 16, "Placed at 10:52:26", BTC 5m, NO, stake $5, average purchase 60.7 cents, price to beat $81,318.35, official outcome YES, settlement displayed 10:59:07, reported realized -$5.00. Screenshot lacks unique market UUID, exact round start/end and filled order acknowledgment. **Do not manufacture a Bluewater prediction match merely because a timestamp lines up with a discovered BTC 5m round.** The receipt proves the user's NO selection lost, not that any specific Bluewater lock was earlier or correct/incorrect.

Historical extra user receipts: NO 70.5 cents LOST, YES 67.6 cents LOST; account overall 81 bets, 65.43% win rate and -$11.71 cumulative P&L, so raw win fraction is not profitability.

## Code accuracy and congruence measures
1. Confirmation rule is explicitly UNQUALIFIED and cannot be called trained or calibrated. A new Coinbase price observation without a genuinely changed WaterX provider probability pair does NOT count as confirming WaterX market evidence.
2. Entry timing is an informational scale only and fails closed if the WaterX reference/price-to-beat isn't confirmed, market feed is stale, an exact saved lock is missing, stages disagree, insufficient time remains or quote/payout is unavailable. Coinbase is a comparison source, not WaterX's official Chainlink TWAP60 BTC/USD settlement oracle.
3. Three-way direction summary classifies NONE, SINGLE, AGREE_TWO, AGREE_THREE and CONFLICT. Agreement between market-derived stages is **correlated** and must not be represented as higher independent forecast confidence; when any saved stages disagree, a unified direction is withheld.
4. Only exact, saved and acknowledged round decisions can count in verified model scores. Historical read is requested on-demand, bounded to <=100 rows, with a before-time filter. Stage winner/loser never inferred for idle missing slots or after-entry locks.
5. Two methods to compare REAL user trade evidence on opened History rows:
   - Placement time only: tentative time-window candidate, display original saved stages before placement. Market identity is explicitly UNVERIFIED, never counted as successful attribution.
   - Actual confirmed filled market: WaterX market ID, round ID, interval, start/end and fill time must match; if they do, review frozen model state. Actual P&L is only displayed from explicit user-reported costs/fees and verified WaterX settlement. No trading API calls or storage writes.
6. Quote sensitivity scenario: exact visible ask determines best-case payout at $5. 10¢ extra cost is only a **scenario**, not measured protocol gas/fees. Break-even requires empirically validated independent forecasts at the *actual* effective purchase price; until then the UI displays EDGE UNVERIFIED, not a buy recommendation.

## Before publishing
- Six CI checks green on the **final** SHA, including four test shards, visitor-only cost checks, production build and disposable PostgreSQL integration.
- Verify branch is checked out in Replit; publish button only publishes Replit's **current editor checkout**. Do not run a paid Replit Agent to restate GitHub edits.
- Keep WATERX_VISITOR_ONLY_MODE=true. The evidence-rule Confirmation switch may stay enabled, but cannot be promoted to a calibrated learned model by setting a flag.
- Keep existing DB, visitor-only collection, idle sleep and backups. No migrations, deletes, schema resets, mainnet signing/ordering enablement, or unsolicited increases in polling.
- Postpublish smoke test: 5m/15m fresh source, correct reference confirmation, no independent Coinbase evidence claim, three-stage history, date jump, $5 payout display and placement-only audit. Monitor rollback ability.
- Official WaterX 5m/15m market rules point to Chainlink BTC/USD 60-second TWAP. A different source price (including Coinbase spot) should not be labeled settlement certainty.
- **Neither CI tests nor the owner's three losing trades establishes a profitable strategy or measured win-rate improvement.** Obtain properly matched prospective verified historic records, market purchase terms, fill timestamps and time-split held-out validation before adjusting thresholds/promoting a model. Do not promise progression from $28.29 to $100.

## Current release limits
This PR is **research and honest reliability reporting**, not proof of independent predictive edge. Live or autonomous order authority remains exactly unchanged, and no new collection workers/polling are introduced.
