# Cloudflare trial report and safety boundary

## Timing and permitted work

- Trial bootstrap: 2026-09-30 22:02:44.752 UTC.
- First full 24 hours complete: 2026-10-01 22:02:44.752 UTC. Report no earlier than October 1 at 16:03 Belize time.
- Fixed polling cutoff: 2026-10-02 00:02:44.752 UTC, October 1 at 18:02:44.752 Belize time.
- Do not reset or extend the trial, redeploy its collector during this measurement, change production, buy a paid tier, provision a Reserved VM, or migrate the database.
- The Cloudflare collector owns its cutoff. A reporting process in the development workspace is not responsible for keeping collection running or stopping it.
- Preserve D1 and Durable Object trial evidence. The remaining minute cron is separate from provider polling and may continue making requests after polling stops; report that fact. Any later cleanup must target only this trial.

## Required report

Report both intervals independently. Label every result **verified**, **failed**, or **not measured/incomplete**, with observation time and evidence source.

1. **Collection:** expected and collected round identities, missing starts/intervals, initial and terminal partial rounds, longest observation gap, source freshness, field completeness, delayed scheduling, provider/database failures, and browser independence. Distinguish the actual high-frequency freshness maxima from gaps between the approximately 30-second D1 snapshots. A fixed 24-hour start-time denominator is 288 five-minute and 96 fifteen-minute rounds; rounds intersecting the window and fully completed rounds have different denominators.
2. **Cloudflare consumption:** actual account/dashboard analytics for Worker requests and CPU, Durable Object requests/errors/CPU/duration/SQLite storage operations and size, and D1 operations/index-inclusive rows and storage. Report missing or lagged analytics as unknown, not zero. Compare each daily and per-invocation limit separately; project 30- and 31-day months without presenting daily quotas as monthly quotas. Separate one-time initialization/report reads from steady collection where the evidence permits. State retention and browser/read-traffic assumptions and remaining account-shared capacity.
3. **Identity:** verify interval, market UUID, round UUID, exact starts/ends and cadence, observation time within the round, rollover sequence, collisions/conflicting mappings, and joins between prospective observations and settlement evidence. A snapshot gap, or a lack of samples immediately around rollover, limits proof of rollover behavior even when the stored joins are consistent.
4. **Labels:** count distinct trustworthy round labels, not settlement attempts. List withheld reasons and missing fields. Require the recorded WaterX round UUID and closing time, correct market, explicit provider resolution/outcome, confirmed anchor, settlement price/time consistency, and no conflicting evidence. Never infer a verified label from Coinbase/comparison prices, an unconfirmed reference, or a provisional winner.
5. **App reads:** assess existing API/UI compatibility, not merely whether the D1 query succeeds. Propose a bounded, source-stamped, read-only shadow adapter with explicit interval/identity checks, freshness expiry, last-known display marked stale, timeout/circuit-breaker behavior, and source attribution. Never silently replace WaterX settlement with comparison data or label stale odds as live.

## Accuracy is not collection uptime

This source-only trial does not establish prediction accuracy or active learning. Report those separately as unmeasured unless frozen, pre-expiry model predictions are joined to verified labels and compared prospectively against the WaterX market baseline at identical observation times. Availability, verified outcomes, retrospectively selected samples, and model training completion are not evidence of improved accuracy.

## Known evidence limits to audit, not silently fix mid-trial

- Worker `/latest` reads the Durable Object's latest snapshot, not a D1 historical query. Its data format is not the existing app's `/api/waterx/live` or advisory contract. The present app does not read this edge database.
- `/coverage` may be cached for five minutes; it is not a live quote-freshness signal. The last saved `LIVE` status can survive an outage, so current server time and actual observation/round expiry must decide freshness.
- The worker compares historical market identity against the frozen prospective market when verifying settlement, but D1 evidence does not separately retain the returned historical market ID or a complete raw provider response. Report code-enforced checks separately from independently reproducible row-level provenance.
- Historical anchor confirmation is enforced. Equality to an initially provisional prospective anchor is not enforced and should not be assumed; a provisional anchor is not authoritative.
- The current edge verifier stops re-probing after its first `VERIFIED` evidence. It does not establish detection of subsequent WaterX corrections/disputes. Count distinct provider-verified rounds, audit any recorded conflicts, and disclose that later revision safety remains unproved.
- Persisted settlement read failures are observable. Complete cumulative current-market HTTP error/status counts are not stored, and current clean health is not proof of zero past errors.

Do not redeploy or change these semantics during this run simply to make a gate pass. Report gaps and propose a separate corrective validation if necessary.

## Smallest next step, conditional on passing

Propose only a read-only development shadow adapter to compare edge reads against the unchanged legacy path. Do not enable it in production or retire any collector. Estimate incremental Workers/D1 read traffic against actual remaining Free-tier quotas; $0/month is conditional on the measured total staying within those limits, and does not eliminate existing Replit app/database charges. If any decisive runtime metric is unavailable, the free-trial conclusion remains incomplete.

For a concrete bounded candidate, a single server-side `/latest` read every five seconds adds at most 17,280 Worker and Durable Object requests/day (518,400 per 30-day month; 535,680 per 31-day month), excluding retries and occasional diagnostics. Coalesce reads across clients, use a bounded timeout and circuit breaker, and do not issue a D1 history query for every browser refresh. This is incremental request arithmetic, not a measured monthly cost or permission to deploy. Validate the real combined request/CPU/storage budget first.

That first shadow step tests live snapshot compatibility only: `/latest` is backed by Durable Object state. It does **not** establish reliable D1 history/settlement reads or migrate the app's PostgreSQL learning/history tables. For D1-backed history, separately specify a bounded read-only endpoint with prepared queries, explicit source/round provenance, pagination, and contract tests against frozen D1 records and the existing app's response types. Keep database credentials out of the browser. Do not add this endpoint or adapter during the measurement run.

Before changing production collector topology, publishing an adapter, or migrating/retiring storage, require a current full backup retained privately outside the workspace, successfully recovered from that retention and restored in isolation, with integrity, schema and historical row checks. The old workspace-only archive is not sufficient. Preserve the app and its history throughout.

## Reporting delivery limitation

A development-workspace background check is best-effort and can be lost if the workspace stops or restarts. It is not a durable scheduling service. No paid chat routine or scheduled deployment is authorized for this report. If the background check does not return, resume the report after the due time using the read-only evidence scripts; Cloudflare polling and its automatic cutoff remain independent.

The best-effort watcher is `node scripts/cloudflare-waterx-report-watch.mjs`. It waits until October 1 at 16:03 Belize, then runs the fail-closed read-only report and emits a completion notice. Its output is `.local/edge-trial/24-hour-report.json`; it does not publish, change the collector, or control cutoff. If needed after the due time, run:

```sh
node scripts/cloudflare-waterx-report.mjs --out .local/edge-trial/24-hour-report.json
```

The final report freezes analytics and observations to the first 24 hours even if generated later. Later settlement evidence and stopped/live health are separately timestamped. `--preview` is only for an explicitly incomplete pre-deadline check and must never be presented as the final result.