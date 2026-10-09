# Blue Water production Confirmation Lock incident — 2026-10-09

**Status:** verified public production evidence and pinned live-source snapshot. **No production changes, no database writes, no trading, no release approval.**

## Production provenance

- `GET https://bluewaterai.app/api/waterx/version` returned packaged build ID `sha256:cfb864048c825da43fb4a64e54c766d090ed319bb2c9e22b04b1e4a14ce8529c`.
- Source commit recorded in production: `09c0f4c74d9fac5da03946cb1b1a21bd57d7b8fe`; build timestamp `2026-10-08T23:11:18.853Z`. This commit is not in the accessible GitHub history.
- Already-public source archive SHA256: `444d97a454b0c5704956bc248b6f71b9c2d937ea7fc724187cff42d6ec051c30` (964,521 compressed bytes), imported to the isolated `sync/production-source-20261009` branch with an allowlist and immutable checksum. No deployment was made.
- The production `/api/waterx/paired-history` endpoint returned HTTP 404; its proposed implementation exists only on a separate Oct 8/9 GitHub history branch.

## Actual operational issue (24-hour frozen-cohort read)

On 2026-10-09 at approximately 22:36 UTC, a GET-only GitHub Actions diagnostic fetched `/api/waterx/timed-history?interval=5&window=24h&limit=200` and the corresponding 15-minute endpoint. The API reported `rowsTruncated=false` for both.

| Measure | 5m | 15m |
| --- | ---: | ---: |
| Observed strategy-round cohort | 115 | 56 |
| Stored LOCKED records | 57 (varied by a live round) | 21 |
| Stored DATA_FAILURE records | 54 | 35 |
| DATA_FAILURE rounds containing MISSED_GATE | 54/54 | 35/35 |
| MISSED_GATE results within DATA_FAILURE gate journals | 440/486 | 970/1015 |
| DATA_FAILURE rounds also containing WAIT_FRESH_DATA | 4 | 3 |
| Missing final-record rows | 2 | 0 |

**Conclusion:** Among the observed DATA_FAILURE rounds, every one has a missed scheduled checkpoint. Stale-data waits are a smaller overlap, not the dominant *recorded* cause. This proves a checkpoint scheduling/capture reliability problem; it does not by itself prove whether hosting sleep, timer jitter, a disabled writer, database contention, or other causes are principally responsible.

A single passive instance was LIVE during two samples. Its metrics had approximately 18.8 seconds maximum scheduler jitter, about 19.1 seconds maximum event-loop delay, database transaction maxima above 5 seconds, and more than 30 bounded critical queue failures within the instance lifetime. Maxima do not establish frequency or causality; both exceed the legacy **2-second scheduled gate grace**. The producer is not autoscale-independent.

### Source-level mechanism

In deployed `server/waterx/timed-decision-coordinator.ts`, gates are enqueued using in-process `setTimeout` at successive 30-second offsets and depend on the decision-writer process staying alive. In deployed `server/waterx/timed-decision-store.ts`, overdue checkpoints are recorded as `MISSED_GATE` without reconstructing a prediction from retrospective odds (correct and important for integrity). `DATA_FAILURE` is persisted at expiry when any gate has failed. Recovery can journal failure events, but **cannot recreate timely opportunities**.

These are *not* evidence that Confirmation Lock predicts 0% accurately. Indeed, timed strategy V3 has saved verified correct/incorrect predictions, while a separate paired-history UI may not access the same records.

## Design for a cost-controlled fix: proposal, not enabled

1. **Preserve legacy V3 without rewrite.** Do not widen its fixed two-second gate retroactively, silently substitute Bluewater Decision, or improve statistics by inventing old locks.
2. **Introduce separate, versioned V4 event-driven confirmation in shadow mode.** Use already accepted public provider observations on their **actual arrival/DB availability timestamps**, evaluate stability/strength/freshness prospectively during the active round, and persist at most one immutable confirmation choice or an explicit reason for no qualifying confirmation. A decision is made *when fresh evidence is present*, not dependent on recovering an arbitrary 30-second callback.
3. **Keep Early Lock and qualified confirmation independent.** The market-derived frozen `Bluewater Decision` remains a separately labeled benchmark, never silently treated as a qualified V4 lock. Compare early, V3, V4, benchmark at the *same exact-round verified WaterX settlement*, never hindsight.
4. **Protect the critical path.** Persist durable decision/outbox before optional research, training, chart archive or daily reports. Use a bounded, indexed query and no new per-tick DB scans. Limit immutable V4 writes to one decision plus its audit trail per round, using existing observed tick flow.
5. **Do not increase ordinary polling.** Use the cost-optimization branch's adaptive schedule where it passes matched-round freshness tests. Read-only status pages must not wake extra provider calls. Avoid a new paid Replit VM unless explicitly approved.
6. **Treat sleeping infrastructure as a separate constraint.** No in-process-only scheduler can guarantee 24/7 coverage if the free/scale-to-zero runtime is inactive. A paid always-on component or an appropriately capable independent scheduler may ultimately be required for continuous strict-time locks; do not claim a free-tier guarantee.
7. **Keep mainnet execution OFF.** Prediction records are research, not an order or verified fill. Add no Slush signing or autonomous trading as part of this repair.

## Acceptance before any merge/deploy

- Dedicated tests for timely receipts, interrupted evidence, stale odds, delayed queue, process restart, duplicate receipts, final settlement revisions, 5m and 15m lock rules; no retroactive choices.
- Green `npm ci`, `npm run check`, `npm test`, `npm run build` against **the source-synchronized branch**, not just older `main`.
- Versioned DB schema migration reviewed, backup and restore verified, idempotency/rollback proven. Do not delete old events.
- 24-hour controlled shadow comparison on matching verified rounds: on-time confirmation coverage, missed gate rate, precision/Brier/calibration as applicable, look-ahead audit, median/p95 lock lead time, polling/DB queries, chart gaps and billed Replit usage. No change to V3 live display/trading by default.
- Explicit owner approval for the exact tested deployment commit. Never merge `sync/`, historical PR#4, or cost branch directly into production without source reconciliation.

## Read-only evidence

GitHub Actions probe and archive inspection runs, October 9 2026:
- https://github.com/lifeguarddotsui-GPT/signal-desk-btc/actions/runs/38000089712
- https://github.com/lifeguarddotsui-GPT/signal-desk-btc/actions/runs/38000174954

The reported production data is a time-bounded snapshot; refreshed counts may differ as ongoing rounds lock/settle.
