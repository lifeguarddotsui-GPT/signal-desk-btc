# Confirmation Lock and Round History — source-only investigation

Status: **review branch only; not merged, deployed, or approved for live changes.**
Reference: screenshots from 2026-10-09, independently reviewed against GitHub `feature/paired-history-readable-scorecard-20261008`. GitHub `main` is older, and the live deployment revision has **not** been verified.

## What the screenshots establish

- Early Lock: 57 correct / 15 incorrect / 64 without saved locks = 79.2% only among 72 verified scored predictions. Its 64 no-lock cases include 59 labelled data failure, 4 abstentions and 1 missing cause.
- Confirmation Lock: 0 correct / 0 incorrect / 138 without saved locks, including 118 labelled data failure, 17 abstentions, 2 observing and 1 unclassified. **Zero scored does not mean 0% prediction accuracy.**
- A frozen `Bluewater Decision` is visible while the qualification-gate Confirmation Lock reports `Fresh odds unavailable`. These use *different persisted records and rules*; equivalence cannot be assumed.

## Data provenance

1. Early Lock: `bluewater_lock_candidates` with `checkpoint_seconds=0`.
2. Qualified Confirmation Lock: `waterx_timed_decisions` with `strategy_version='waterx-qualification-gates-v3'`; gate evidence `waterx_gate_journals`.
3. Bluewater Decision market benchmark: prospectively persisted `waterx_research_choices`, market-baseline source, exact round identity, frozen `state`, excluding the 50/50 tie-break path.
4. Verified outcome: `waterx_learning_rounds`; no unverified or disputed settlement may score a prediction.
5. Missing/unverified settlement is NOT the same as missing decision, and abstention is NOT incorrect prediction.

This branch exposes (3) as an **additional, separate** summary and detailed row. It never backfills (2) from (3), including when they agree. A frozen benchmark is shown only if there is exactly one exact-round prospective frozen record with a valid decision clock; ambiguous/invalid records remain unscored. An absent benchmark stays absent.

## Production operator audit (read-only SQL)

Run in the authorized SQL console, never paste production secrets or raw personally identifying account data in chat.
Confirm you are connected to the **intended production database**, not development. Start with a small lookback; no write access is necessary.

**A. Confirmation status and gate cause distribution**
```sql
SELECT d.status, count(*) AS rounds
FROM waterx_timed_decisions d
WHERE d.network='sui:mainnet'
  AND d.strategy_version='waterx-qualification-gates-v3'
  AND d.decision_at_ms > (extract(epoch FROM now()) * 1000)::bigint - 86400000
GROUP BY d.status ORDER BY rounds DESC;
```

**B. Checkpoint evidence, missed gates, freshness failures**
```sql
SELECT j.interval_minutes, j.result, count(*) AS gates
FROM waterx_gate_journals j
WHERE j.network='sui:mainnet'
  AND j.strategy_version='waterx-qualification-gates-v3'
  AND j.evaluated_at_ms > (extract(epoch FROM now()) * 1000)::bigint - 86400000
GROUP BY j.interval_minutes,j.result
ORDER BY j.interval_minutes,gates DESC;
```

**C. Same-round missing confirmations vs available frozen benchmarks**
```sql
SELECT r.interval_minutes,r.round_id,r.start_ms,r.expiry_ms,
  d.status AS confirmation_status,
  count(c.*) FILTER (WHERE c.state='FROZEN'
    AND (c.choice_source IS NULL OR c.choice_source='market_baseline')
    AND COALESCE(c.evidence->>'tieBreakApplied','false')<>'true') AS prospective_benchmarks
FROM waterx_timed_rounds r
LEFT JOIN waterx_timed_decisions d
  ON d.network=r.network AND d.strategy_version=r.strategy_version
  AND d.interval_minutes=r.interval_minutes AND d.round_id=r.round_id
LEFT JOIN waterx_research_choices c ON c.interval_minutes=r.interval_minutes
  AND c.round_id=r.round_id AND c.start_ms=r.start_ms AND c.expiry_ms=r.expiry_ms
WHERE r.network='sui:mainnet' AND r.strategy_version='waterx-qualification-gates-v3'
GROUP BY r.interval_minutes,r.round_id,r.start_ms,r.expiry_ms,d.status
ORDER BY r.start_ms DESC LIMIT 30;
```

**D. Provider evidence received before a gate**
```sql
SELECT j.interval_minutes,j.round_id,j.gate_index,j.result,
  j.scheduled_at_ms,j.evaluated_at_ms,
  j.evaluated_at_ms-j.scheduled_at_ms AS evaluation_lag_ms,
  j.journal->>'reason' AS reason
FROM waterx_gate_journals j
WHERE j.network='sui:mainnet' AND j.strategy_version='waterx-qualification-gates-v3'
ORDER BY j.evaluated_at_ms DESC LIMIT 60;
```

## Root-cause priorities (verify from production)

- `WAIT_FRESH_DATA`: provider odds absent/partial, non-complementary probabilities or stale at the exact gate. Check HTTP receive timestamps and the live quote validation path.
- `MISSED_GATE`: process sleep, scheduling jitter, background queue delay, database pool acquisition, or transaction duration beyond the **current 2-second gate grace**. Check gate latency and presence of checkpoint logs before altering policy.
- `DATA_FAILURE`: may be a final classification even if some later gates were good. Inspect all gate journals before blaming the scoring UI.
- `ABSTAINED_NO_QUALIFIED_SIGNAL`: complete evidence but signal not qualified, distinct from infrastructure failure. Do not force a lock to raise coverage.
- Missing `waterx_learning_rounds` or unverified outcome: settle/reconcile the provider independently; never infer settlement from public BTC price alone.

## Required gate/runtime improvements after evidence review

- Preserve timed evidence at the **source receipt**, with immutable original timestamps; schedule exact gates independently of browser visits.
- Ensure priority queue service of due gate / committed lock precedes background training, chart archive and history reporting. Do not increase baseline polling just to hide deadline misses.
- Keep provider reads and settlement reconciliation bounded and separate. No retroactive gate snapshots.
- Expose blocker-specific counts and last gate freshness/lag in Data Health. Treat 5m and 15m independently.
- If product owners want one definitive final decision rather than three sources, adopt an **explicit policy-versioned selection rule** for *future* rounds, such as qualified confirmation if available, otherwise independently frozen market benchmark labelled `BENCHMARK_ONLY`. Never rewrite previous rows or imply its market probability was a calibrated forecast.

## Acceptance checks before deployment

1. Resolve running production commit/build provenance and compare the actual deployed code to this branch and the separate cost-optimization branch.
2. Verify production backup and rollback. Perform read-only database diagnostics above.
3. CI typecheck, regression suite and production build green. Check that the history endpoint works with the real production schema using read-only staging queries.
4. The same exact-round frozen benchmark appears on Live Desk and Round History with identical timestamp, direction and source. No lock is scored as wrong. Confirmation still shows no lock unless its independent journal holds a qualified saved decision.
5. 24-hour shadow comparison for both intervals: gate coverage, `WAIT_FRESH_DATA`, `MISSED_GATE`, verified settlement coverage and live-chart gaps. No worsening against the prechange baseline. Confirm no new polling or material cost increase.
6. Publish only after explicit owner approval. No production data deletion, historical decision reconstruction, trading or unattended deployment.
