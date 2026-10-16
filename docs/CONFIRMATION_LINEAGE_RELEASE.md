# Blue Water AI · Confirmation & exact-round lineage release gate (2026-10-16)

**Draft only. Do not deploy / merge or modify any production database without owner approval.**

## Why Confirmation was inactive
The previous Confirmation stage required a stage-specific selected calibrated policy. Without at least 60 validation examples per relevant selection/test partition, verified outcomes, held-out score better than matching market baseline, and correct pre-round model provenance, no artifact is eligible. This is a desirable rule **for calling a model calibrated**, not a useful substitute for a simpler second-opinion baseline.

## Proposed option, not ML qualification
Opt-in `WATERX_RULE_CONFIRMATION_ENABLED=true` allows a separately labeled, experimental **uncalibrated evidence confirmation** if no eligible trained Confirmation policy exists:
- Source remains the genuine WaterX accepted odds. It is not a Bluewater probability forecast or an independently verified order price.
- Must have valid complementary odds, fresh observations, existing event qualification, at least two changed valid evidence frames, change since first odds / early lock, no future/source-time leakage, and a >=30s remaining reserve before expiry. Earlier model-qualification guards remain unchanged for genuine learned policies.
- On commit, permanent policyVersion `confirmation-evidence-guard-v1`, source `WATERX_MARKET`, calibrationStatus `UNQUALIFIED`, modelVersion null, shadowOnly true, execution disabled.
- No synthetic locks, fabricated historical backfills, reclassification of old predictions, or claim that Confirmation improves win rate. New future predictions can be evaluated for incremental information advantage on matched, verified rounds.
- This switch defaults **OFF**. To launch after approved testing, add the exact deployment env variable in Replit production secrets, then synchronize the approved tested GitHub revision and publish. Merely setting a secret without the code does nothing.

## Unified Round History
- `GET /api/waterx/decision-lineage?interval=all&window=24h&limit=40` is a bounded **single read**, called only on page mount or manual refresh. No timer, collector, migration, background writer, index rebuild or raw-price archive.
- Source cohort = previously discovered primary timed rounds, not all 5/15m wall-clock slots. Visitor-idle periods are not assumed erroneous.
- Join strict exact round identity across frozen primary, two-stage and separately frozen checkpoint research, plus already verified WaterX settlement. Database identity and outbox existence are checked for live-stage scoring. Never alter historic row side/policy after settlement.
- The default page stats cover only displayed rows. No unsupported claim about lifetime accuracy; add paginated and separate all-time indexed aggregates after costs are measured.
- The two-stage table and model learner remain independent. This PR improves auditable pairing and makes future no-model Confirmation captures possible. A future **training qualification PR** should use versioned, time-split evaluation, adequate sample sizes, proper scoring and no future feature leakage before suggesting promotion.

## Release blockers
1. CI full regression suite green.
2. Test actual read-only SQL on a **restored backup**, including `EXPLAIN (ANALYZE, BUFFERS)` outside production, and verify schema compatibility. No production migrations are included.
3. Test 5m/15m early, confirmation, source gaps and round boundaries under real capture; separately compare baseline/early/evidence confirmation on verified same-round labels. 30s reserve does not prove a WaterX order can fill.
4. Verify previously published visitor-only deployment is sleeping after zero visible leases, no independent worker keeping PostgreSQL active, and actual Replit storage/DB compute hours decrease. No new production spend to investigate.
5. Do not enable rule confirmation if its added DB writes or query plan exceed the cost budget; the main new history read is explicitly on-demand.
6. Keep `WATERX_RULE_CONFIRMATION_ENABLED` unset/false in production until the owner approves this separate feature release. Preserve production decision history; test rollback and full restorable backup.
7. Replit may be on a different workspace branch than current PR; sync source revision only with reviewed Git state and do not publish a stale or divergent workspace.

## Evaluation milestones
- Cohort counts: observed rounds, saved predictions by policy, abstentions, source failures, official verified/pending/disputed outcomes, paired verified samples.
- Accuracy with denominators + Brier/log loss of *frozen* odds separately for each strategy; never compare unequal observation windows as if equal.
- Correction rate: primary correct after Early incorrect; Confirmation correct after Early incorrect; and reverse (early/primary correct then later Confirmation incorrect).
- Median time to lock, time left before close, and realized WaterX quote/fill latency when independently verified. Indicative $5 return is not realized P/L.
- Only promote a learned Confirmation artifact when a proper held-out time split demonstrates incremental benefit vs the active 30-second benchmark and safe execution timing.

This documentation does not attest to production data access or successful cost verification.
