# BluewaterAI BTC pipeline follow-up — 2026-09-28 UTC

This is a development release review, **not** evidence that the published
application has been updated.

## Rechecked published state

At approximately 02:44 UTC, the published `/api/health` reported packaged
build `sha256:893b4a6ea8a78817aaabcc2cad48fb1963dbe102400b0832dead760d0e36ff42`,
3,247 observed rounds, 2,481 verified settlements, 466 probability-qualified
primary predictions, and 465 scores. Settlement continued while the last
qualified prediction and score remained at 2026-09-26 03:27–03:28 UTC.
Recent primary capture errors said “Artifact feature schema or feature order
is invalid.” The local packaged build had the same content-derived build ID
before edits; the clean local checkout at inspection was `79f0023`. Matching
package bytes identify a candidate source, **not proof of the deployed Git
commit**: the old package had no source-commit metadata.

Read-only inspection of the published model row confirmed that PostgreSQL
`jsonb` had serialized each feature-schema object's keys in a different order
than the original TypeScript literal. The previous validator compared the
*whole serialized array* to a `JSON.stringify` of that literal. Feature
positions and field values were unchanged, but object-key order alone caused
validation to fail. Shadow inference ran inside the same transaction as the
market-baseline prediction, so the exception rolled back **both**. Waiting
for additional rounds could not repair this.

## Development repair and evidence rules

Validation now compares each feature's exact keys and values **at its
original array position**. A genuinely reordered feature array or changed
field still fails. A model validation/inference error can be quarantined for
inference, recorded separately, and leave the contemporaneous market-baseline
prediction intact. Database errors are not reclassified as model failures.
Observation, primary capture, settlement, scoring, and shadow training have
separate operating paths; the fixed 45–30-second issuance window is unchanged.
Original rows and historical model artifacts are not rewritten.

The shadow experiment registry compares no-adjustment market probability,
regularized calibration, beta calibration, and the logistic correction on a
matched chronological cohort. Outcomes are revealed at their recorded
verification times; a round with no such time does not qualify. Candidate
evaluation does not confer promotion or trading authority. Retaining **no
champion** is the only justified decision until adequate *new prospective*
labels and prespecified matched evidence exist. Apparent older-market
accuracy is not live AI accuracy or proven profit.

The accuracy API reports scored prospective cohorts, exclusions, model
availability, and seven consecutive 24-hour UTC issuance cohorts. Outcomes
verified later belong to their original issuance cohort only after the
persisted score exists. Calibration-bin observed frequencies require at
least 20 outcomes, and descriptive clustered Brier intervals require at
least eight non-empty 30-minute blocks. An incomplete bounded query returns
unavailable rather than partial metrics. Prediction, outcome, and score
exports remain cursor-paginated; the UI follows all pages for full-period
downloads.

Anonymous UP/DOWN economics remain independent of model readiness, read-only,
round-bound, and explicitly **$5 gross winning payout quantity**, not a $5
purchase budget. Failure on one side must not fabricate or suppress the
other. Quotes and expiry terms are estimates, not guaranteed fills or a
reason to turn WAIT into a trading instruction.

## Release gates

- Confirm at least three consecutive **new development** primary-window
  predictions, post-expiry verification, and one score each after this repair;
  then perform the same check on the published build **only after approval**.
- Compare 15-minute and longer capture coverage, exclusion counts, scoring
  delay, and stage-specific error rates rather than treating a live heartbeat
  or zero backlog as a healthy learning pipeline.
- A production backup has not been restore-tested. Do not migrate or publish
  without reviewing that prerequisite and the publish-time schema diff.
- An idle autoscale instance still cannot guarantee continuous collection;
  choose and verify always-on hosting before promising uninterrupted history.
- A content-derived build ID and expected schema-source fingerprint are not
  proof of the runtime database schema or serving Git commit. Future packaged
  builds carry a commit only when built from a clean checkout; otherwise its
  source-commit field remains null.
- No wallet custody, signing, funding, order submission, or automatic
  execution is included.

## Development smoke check (not published proof)

After a development workflow restart at 02:57:20 UTC, the read-only
`/api/predictions?limit=100` response showed four consecutive new one-minute
rounds at 02:58–03:01 UTC. Each had five immutable probability-qualified
primary observations within the fixed window, one persisted evaluated score,
and a verified UP/DOWN result. A partially observed round at restart had
three qualified observations but no evaluated score, so it is **not**
counted as a passing round. `/api/health` reported a current scoring stage,
zero qualified-unscored backlog, and a distinct-round opportunity-coverage
ratio of 1 for its last-15-minute development window. That ratio estimates
coverage among rounds observed across the window; it does not establish
unbroken 24/7 collection. The model endpoint remained
`BASELINES_ONLY` because verified-history gaps exceeded 12 hours, so no
challenger is being promoted. The published instance was not changed.

## Later published-state recheck and next development release

At approximately 13:19 UTC the published app reported packaged source commit
`299700ed209bc92bc06852274588c23fc867a0f8`, with advancing primary
capture and scoring counters. This **supersedes the earlier stalled published
snapshot above**, but does not imply uninterrupted autoscale collection.
Read-only database metadata showed seven `btc_predict_*` tables, including
prediction/model records and a settlement-verification timestamp.
The fingerprint does not verify the physical runtime schema.

The public repository's `main` still pointed at `8029c612108dd77d7787bfd1eb2055a845babd41`
at this check. The workspace source matched the published revision's tracked
application files before the next development edits; its later local publish
checkpoint did not change those files. The source-only review branch already
carried the previous repair at `245c66e57acabf479b41c0e96954cca7abcc98e3`.
Neither remote ref should be mistaken for a new production deployment.

The published `/api/model` still used the entire archive for its
47.75-hour maximum-gap gate and had no champion. Around 13:23 UTC its
prospective matched shadow cohort had 453 scored rounds: raw market Brier
approximately 0.17565 and shadow Brier approximately 0.20828 (lower is
better). These moving published measurements are **not** the new development
release's outcome, and they do not support promotion. A new development
post-recovery cohort now excludes the old outage *only for eligibility* while
preserving every archived row. It retains the original 300 verified rounds,
48 elapsed clean hours, and 12-hour maximum **in-cohort** observation gap.

This development release also changes `/api/economics` from $5 **gross winning
payout quantity** to independently sized **$5 all-in USDC spend budgets**,
with the old sizing available as explicit `?mode=payout`. Gas is unknown and
excluded; neither quote is a fill. The client handles round rollover, source
freshness, late-window bias, and out-of-order requests separately. Build time,
policy-source fingerprint, and persisted-artifact digest are additional
provenance fields. No user wallet, order path, or automatic model promotion was
added. Check the new build and live rounds in development before considering a
publish; the published app has not been changed by this source update.