# BlueWaterAI — five-minute prediction profitability audit
Status: **development branch only**, 2026-10-25. No production changes, Replit operations, signing changes, or autonomous orders.

## Goal
Protect $5 downside and investigate the desired $1–$2 **profit only on a winning trade**. A trade with $1.50 win profit and $5 loss needs 5 / 6.5 = **76.923%** true win probability before costs. An extra $0.10 expense paid on every trade raises the break-even rate to 5.1 / 6.5 = **78.462%**. A model's 85% display, measured accuracy, and executable positive expected value are different objects.

For verified receipts: `netWin = grossWinReceipt - winReceiptFees - allInEntryCost - networkExpense`; `netLoss = grossLoseReceipt - loseReceiptFees - allInEntryCost - networkExpense`. Expected net = `p*netWin + (1-p)*netLoss`. Break-even = `-netLoss/(netWin-netLoss)`. Do not subtract a fee a second time when it is already included in all-in entry cost or receipts.

## Code audit: what already works
- `server/waterx/research-decision.ts` freezes checkpointed decisions and scores against officially reconciled settlement; market baseline is distinguished from independently promoted model forecasts.
- `server/waterx/research-training-model.ts` and `research-baseline-training.ts` use chronological train/calibration/test partitions, Platt calibration, matched Brier and log-loss evaluation.
- `server/waterx/bluewater-report.ts` exposes sampled qualification, calibration, mistakes, and separate market baselines. Forecasts are not a live trading authorization.
- `server/waterx/advisory.ts` explicitly refuses to treat indicative public odds as executable $5 pricing. `shared/waterx-value-policy.ts` has `eligibilityEnabled:false`. Do not change it without a separate documented security and financial review.
- `server/waterx/bluewater-fast.ts` captures point-in-time distance, volatility, price returns, market odds changes and remaining time with timestamp checks.

## Gaps uncovered
1. Brier improvement is **not trade profitability**. No complete cohort of accepted fills / executable-at-decision-time $5 quotes / net receipts and trading/network fees was established by inspecting the code. Do not report a profitable strategy or convert probability directly into a trade action.
2. The operationally displayed green/red time and area measurements are not direct names in the current trained feature schema. They need a validated as-of-time back-end definition and feature-ablation experiment.
3. The original model promotion comparison used round-level independent standard error. Five-minute observations are correlated. It can overstate certainty.
4. WaterX's BTC five-minute market page states its settlement source is Chainlink **BTC/USD TWAP 60-second stream**. The market page also warns its WaterX preview chart can differ from settlement. A Coinbase proxy or Pyth spot is not settlement truth. Existing WaterX provider settlement results are valuable, but independently matching the official Chainlink stream and round anchor is a separate verification task. Never transfer the DeepBook Predict/Pyth settlement rule to WaterX prediction markets.
5. Probability and quote freshness, missing rounds when the service sleeps, actual fill delay, and selected/abstained signals all bias a naïve backtest. Track missingness rather than filling lost intervals or retrospectively reconstructing decisions.

WaterX example published rules: https://waterx.app/en/predict/market/crypto/crypto-btc-updown-5m/1783822800
(Note: verify each live market's rule/version and asset feed at execution time; this historical example does not attest to every future listing.)

## Changes in this branch
- `shared/waterx-ev-evidence.ts`: exact receipt-based EV and break-even accounting; two-sided Wilson 95% **descriptive** interval; immutable-key, quote-matched research cohort diagnostics. Missing fees/gas, stale or indicative quotes, disputed settlements and market-only forecasts fail closed. NO_TRADE is an explicit captured category. Counterfactual returns remain separate from verified fills.
- `server/waterx/price-path-features.ts`: a non-serving 60-second, source/receipt-time bounded green/red duration and signed area research feature. Crossing the WaterX anchor is interpolated between genuinely observed Coinbase proxy ticks; gaps, provisional reference or late-received ticks withhold the feature. It is **not** a Chainlink TWAP model.
- `server/waterx/bluewater-metrics.ts`: a minimum seven UTC day-block screening interval replaces five-minute-round independent standard errors for promotion reporting. The gate also requires seven days of span. This is a conservative modeling gate, not a profit-proof gate.
- `client/src/WaterxValueEvidencePanel.tsx` and `BluewaterResearchPanel.tsx`: visible **NO TRADE / UNVERIFIED EDGE** status with a future typed value-audit display. Back-end reports currently provide `valueAudit:null` intentionally; no quote/feed measurements are fabricated.
- Tests in `scripts/waterx-ev-evidence.test.ts` and `scripts/waterx-price-path-features.test.ts`, plus updated promotion test.

## Next safe build sequence (not implemented in this branch)
**Phase A — verified data contract.** Ingest every scheduled five-minute BTC/ETH/SOL candidate with stable market ID, venue round key, asset, decision timestamp, reference and source stamps, forecast version, model probability, quote ID and complete executed **net** payout/cost accounting. Include NO_TRADE, missing quotes, rejected orders and every settlement; guard against different settlements and duplicate opportunities. Use WaterX's exact per-market rules / verified Chainlink TWAP feed for label reconciliation.

**Phase B — prospective proof.** Paper-record at least 300 quote-matched independent-model decisions across multiple conditions and calendar days, then evaluate by asset, side, probability bucket, remaining seconds, payout band, and volatility. Freeze thresholds before untouched forward evaluation. Include day-block / regime-sensitive confidence, quoted break-even, calibrated win rates, counterfactual quote return, and actual filled-trade return **separately**.

**Phase C — feature ablation.** On identical forward rows and timestamps compare baseline (market odds, distance, volatility, remaining time) with and without red/green duration and area. Require Brier and log-loss improvement plus stable performance after fees; do not select an area signal because it looks visually persuasive.

**Phase D — release gates.** No use of live agent execution before signed custody tests, mandatory user approval, cheap/verified execution source, cutoff/latency validation, positive conservative **fillable** EV, pause and revocation proof, and explicit publication approval. No promise of $1–$2 per trade; loss of the whole stake remains possible.

## Verification / cost control
From a local Git checkout: `npm ci`, `npx tsc --noEmit`, `npm test`, then inspect a development-only sample report and compare with a known WaterX settlement. These commands have **not** been executed by the connector in this task; tests are committed for the subsequent review. No new npm dependency or Replit Agent call is required for this branch. Do not merge/publish until all gates pass. This change does not turn on extra polling or require paid background infrastructure.
