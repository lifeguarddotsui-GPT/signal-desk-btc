# Blue Water · $5 winning-profit timing research

This release adds the always-visible cost-adjusted **+$1 to +$2 on a winning $5 position** preference to the Live Desk, and a sealed chronological analysis of **actual filled positions** against verified WaterX settlement outcome evidence.

## What exists today
- `shared/dollar-entry-target.ts`: full $5 fill math, optional fees, max price for winning +$1 and +$2, loss if incorrect, fee-adjusted break-even rate.
- `server/waterx/filled-entry-training.ts`: read-only data audit and cohort report. Distinguishes official WaterX verified Chainlink TWAP60 settlement evidence from Coinbase spot and from unverified market labels.
- `scripts/train-filled-entry-timing.ts`: manually run with an externally verified JSON array of actual fills. Nothing runs automatically or starts a collector. No database migration or storage writes.
- `client/src/TradeReadinessPanel.tsx`: more prominent user objective, ask thresholds and live price/payoff comparison. Retains the TIME-ONLY 1–10 grade as non-predictive until rigorously held-out timing/value evidence exists.

## What does NOT exist (must not be claimed)
- Production has not supplied signed/verified fill confirmations for every position. A placed order time, owner anecdote or indicative ask is not a filled price.
- Public WaterX `round.anchorPriceConfirmed=false` samples cannot be silently interpreted as official live settlement anchor.
- The dataset import fields `verified:true` are asserted by a prior *external verifier*, not independently validated cryptographically by this script. Do NOT let user-supplied booleans grant prediction or trading authority. A future verified on-chain proof ingestion path is necessary.
- Training calculates *historical outcomes of selected fills*, which have strong selection bias. It cannot prove a strategy would have won on unfilled/avoided rounds. It never promotes a model, signs a transaction, or creates an entry recommendation.
- Timing grade is a manually specified operational heuristic. Neither this nor a qualifying payout price proves positive expected value, especially with total $5 downside.

## Reconciliation contract per actual fill
```ts
{
  intervalMinutes: 5|15,
  marketId, roundId, startMs, expiryMs,
  side: "UP"|"DOWN",
  filledAtMs, fillId, fillPriceCents,
  stakeUsd, entryFeesUsd, gasUsd,
  fillProof:{source:"WATERX_EXECUTION_RECEIPT",receiptId,marketId,verified:true},
  settlement:{source:"WATERX_VERIFIED_CHAINLINK_TWAP60",
    marketId,roundId,verified:true,disputed:false,
    anchorPrice,settlementPrice,settledAtMs,labelAvailableAtMs,proofId}
}
```
All times are epoch milliseconds. Confirm match of exact round, side, market and stake, provider fill receipt, recorded effective purchase price and total fees, and a **post-expiry** WaterX final settlement using Chainlink BTC/USD TWAP60 before including it. Duplicate fills per round are excluded from the test to prevent outcome reuse; multi-fill orders require a separate volume-weighted aggregation before research. Coinbase comparison snapshots and placed-at-only screens do not qualify.

## Research protocol
- Isolate 5m and 15m. Four mutually exclusive clock fractions (0–20%,20–40%,40–70%,70–100%), stratified by YES/NO.
- Keep one whole unique market/round per dataset record; chronological 60/20/20 training/calibration/untouched test, labeling embargo equal to interval duration.
- Require at least 60 train, 24 calibration, 30 test and both outcomes per partition. Report missing and invalid evidence counts, test win/loss, actual net USD, average purchase cost, $1–$2 winning-return count and forecast model edge only where an independently qualified pre-entry forecast exists.
- **Candidate timing research:** from TRAIN and CALIBRATION only, identify a (time band, YES/NO side) with at least 10 training and 6 calibration actual fills, both wins and losses, and positive mean net on both. Freeze the selected band before viewing the held-out TEST cohort. Display held-out count and mean realized net, with selection bias warning. Final TEST results cannot select or tune the band.
- **Even a full dataset remains OBSERVATIONAL_TEST_AVAILABLE, NOT an approved strategy.** Validate an independent probability model and all-round unselected baselines on later non-overlapping data, compare post-fee predictive expected value and confidence bands, and independently verify full-size execution quotes.
- Losses can be the entire $5 plus costs. Explicit fail-closed on unresolved/contradictory labels and after-entry forecasts.

## Cost and production safety
This patch does not change collection cadence, visitor-only mode, database schema, agent trading flags, wallet signing or keeper withdrawal. Training is a manually invoked offline step and makes **zero Replit production database queries**.

## Learning page local import
Use Learning → Executed fills / offline training → choose the externally reconciled JSON file. This evaluates the same validated schema for the selected 5m/15m interval entirely inside your browser, with no Replit storage or network upload. It is not automatic acquisition or cryptographic verification of WaterX receipts. Without actual confirmed fill and settlement proofs, the section intentionally says no eligible dataset rather than returning a fabricated success rate.
