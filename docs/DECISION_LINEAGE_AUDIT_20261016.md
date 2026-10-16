# Blue Water decision lineage and round-history audit — 2026-10-16

Status: source audit and proposed user-interface changes on a REVIEW BRANCH ONLY. No database migrations, updates, training promotion, Replit publish, or live trading authorization.

## Production evidence and limits

- Replit previously confirmed publication at https://bluewaterai.app; screenshots sent after publication show Blue Water Decision market data marked CURRENT, an active 30-second benchmark with 1/4 conditions met, and current historical WaterX outcomes. This is evidence of functioning public display at one instant, not independent proof of production source revision, accurate database joins, actual serverless sleep or reduced billing.
- The screenshot around 08:00 5m shows Early=DATA FAILURE/no saved lock, Confirmation=DATA FAILURE/no saved lock, WaterX final DOWN verified. It does NOT prove a contradiction between saved directions. The 08:00 15m screenshot shows Early=DOWN/PENDING and Confirmation=OBSERVING/no lock while official settlement is pending. Pending is not incorrect.
- Visitor-only mode deliberately does not collect prospective choices while no browser is visible. Unobserved rounds are NOT failed forecasts. Any history record lacking evidence needs differentiation among VISITOR_IDLE, SOURCE_UNAVAILABLE, POLICY_ABSTENTION, NOT_DISCOVERED, and DATABASE_ERROR. A missing stage record cannot be silently called DATA_FAILURE.

## Actual code boundaries

1. Active 30-second benchmark: shared/timed-decision.ts and server/waterx/timed-decision-store.ts, independently stored in waterx_timed_decisions and waterx_timed_outbox; the live UI displays preliminary LEANING vs committed LOCKED. This is market-probability research, not an independently calibrated Blue Water forecast. Historical results are under TimedStrategyHistory.
2. Separate shadow two-stage experimental early and confirmation decisions: shared/two-stage.ts, server/waterx/two-stage-runtime.ts, server/waterx/two-stage-store.ts. Committed records are in waterx_two_stage_locks and acknowledged in waterx_two_stage_outbox; audit states in waterx_two_stage_assessments and observations in waterx_two_stage_observations. These do not replace the active benchmark.
3. Confirmation is intentionally unavailable until a qualifying selected artifact exists for interval/stage. The registry requires held-out test evidence, at least 60 calibration/test examples, adequate Brier score, selector parity and artifact cutoffs (two-stage-registry.ts and two-stage-policy.ts). NO automatic fallback to market opinion should be labeled 'confirmation'. An unqualified model is INACTIVE rather than 'incorrect'.
4. Frozen Bluewater champion choices in waterx_research_choices represent another separate policy family from waterx_timed_decisions and the two-stage experiments. The main research-training pipeline selects frozen champion choices and verified waterx_learning_rounds outcomes. The two-stage policy has its own stage-training/report path. A single unified learning system across all three is NOT currently established by this source audit.
5. Exact verified settlement is stored in waterx_learning_rounds. Never infer outcome from Coinbase comparison direction or unverified provider display; never re-score frozen decisions retroactively on revised odds.

## Presentation changes staged in this branch

- Live Desk: active 30-second Bluewater Decision now appears above optional shadow research; provisional LEANING explicitly differs from frozen/saved decision.
- An unqualified Confirmation experiment is folded under a clearly labeled, optional inactive panel. Early research is separately labeled. No model status or stored decision data has been altered.
- Round History: show the actual active 30-second benchmark first (5m and 15m separately). Experimental Early/Confirmation, prior timed strategies and legacy champion/market archives load only after the corresponding section is expanded. This avoids default redundant history queries and mixing incompatible strategy cohorts.

## Next backend implementation — must be separately tested before production

A. Introduce a read-only exact-round lineage projection keyed by (network, market_id, interval_minutes, round_id, start_ms, expiry_ms), with an explicit policy/strategy ID on every decision. Strategy rows must NEVER be UNIONed as if they were one decision.
B. Per round, expose four distinct columns: ACTIVE_TIMED_BENCHMARK, EXPERIMENTAL_EARLY, EXPERIMENTAL_CONFIRMATION, and RESEARCH_CHAMPION (only if that policy actually created a frozen choice). Include side, qualification state, immutable decision/ack timestamp, source, calibration/method, strategyVersion and decision ID.
C. Outcome is shared only on exact identity and verified official WaterX provenance. If no frozen choice, classify as NOT_OBSERVED_VISITOR_IDLE (where proven by prospective visitor-activity metadata), NO_QUALIFIED_SIGNAL, SOURCE_FAILURE, DB_FAILURE or CONFIRMATION_MODEL_UNQUALIFIED; these are not CORRECT or INCORRECT and cannot be counted as losses.
D. Preserve cohort metrics per interval and strategy: total observed rounds, eligible rounds, committed predictions, abstentions, missing observations, verified outcomes, pending/disputed outcomes, correct/incorrect, coverage and conditional accuracy. Only paired, verified, same-round locks support congruence comparison. Compare the active benchmark with Early and Confirmation separately; do not assume the two-stage relationship measures benchmark congruence.
E. Report paired benefit explicitly: agreement %, disagreement %, confirmation corrected early, confirmation reversed a correct early, both wrong, and remaining seconds available at each commit; include paired cohort n to avoid cherry-picking. Report primary-vs-stage pairing in separate cohort.
F. Train a predictive model ONLY on precommitted observations available at prediction time and later officially verified labels; time-based train/validation/test boundaries and versioned artifacts. Preserve a model version, dataset fingerprint, as-of cutoff, receipt timestamps and immutable prediction snapshot. The label is allowed to arrive later; features or recalibrated probabilities must not.
G. Keep confirmation inactive until measured out-of-sample incremental advantage over the active benchmark, rather than merely repeating current market odds; separately show score quality (Brier/log loss), calibration curves, prediction coverage and time-to-decision. Never silently promote a shadow policy to auto-trading.
H. Cost: create lineage projection via bounded read-only queries when history is actively opened, not continuously. Cache by cohort and/or last saved round, no new 5s PostgreSQL polling, no 24/7 collector, no backfill of made-up signals. A visitor-only idle round should be absent unless a prospective lightweight visitor lease record proves an actual idle gap; audit writer choice before schema changes.
I. Validate on a database backup and comparison fixture: single round with primary lean but no lock, early only, confirmation only, both in agreement, disagreement, absent visitor session, missing data, pending label, verified settlement, disputed/mismatched identity, and missing commit acknowledgment.
J. After approved release verify /api/visitor/status passive health, no collector/production DB background activity after last visitor, 5m and 15m active-window reception, and Replit per-project Database Compute active hours. Published status alone does not prove idle sleep.

## Statistical references

- scikit-learn, Probability calibration documentation: calibration requires separate data, Brier and log loss assess predictive probabilities but are not identical to accuracy, and reliability diagrams evaluate calibration. https://scikit-learn.org/stable/modules/calibration.html
- Waghmare & Ziegel, Proper Scoring Rules for Estimation and Forecast Evaluation, Annual Review of Statistics and Its Application 13 (2026): appropriate proper scores for probabilistic forecasts. https://doi.org/10.1146/annurev-statistics-042424-050626
- NIST AI Risk Management Framework: provenance, validation and ongoing measurement guidance. https://www.nist.gov/itl/ai-risk-management-framework

Review branch only; no secrets or production data touched.
