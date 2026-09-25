# Signal Desk upgrade — owner review

**Status: development preview only. Not published. Do not treat the public site as upgraded.**

## Recoverability before edits

- Source tag: `pre-btc-learning-upgrade-2026-09-25` (`ff0044b`). The earlier `pre-deepbook-rebuild-2026-09-25` tag is a different, older snapshot.
- Production read-only export: `backups/pre-upgrade-production/manifest.json`, four `rounds-*.csv` and fourteen `snapshots-*.csv`. Cutoff: **2026-09-25 16:48:53.425 UTC**. Export contains **709 complete normalized rounds and 2,800 immutable raw snapshots**. A CSV reader successfully decoded all JSON rows: 709/2,800 distinct IDs and zero missing snapshot-to-round references. This is an application-table export, not a PostgreSQL cluster-wide dump; do not confuse it with a complete database backup. Keep a copy off the workspace for disaster recovery.
- Development and production databases are separate. Production rows were never replaced, cleared, or migrated by this upgrade. Additive development schema is in `migrations/btc-learning.sql`; Replit Publish must show the production schema diff before release. **Do not select “overwrite data”** when publishing.

## Existing published collector reconciliation

The currently published app discovers active DeepBook Predict markets with a process-local six-second loop started by the web server, appends snapshots, reconciles known expired market IDs, and reports retrospective baseline scores. There is no confirmed independent production scheduler. Replit Autoscale can scale to zero when idle, so progress in published counters cannot prove browser-independent, uninterrupted capture. A dedicated always-on or scheduled worker is needed for that claim.

At the backup cutoff the production export contained **709 observed rounds and 2,800 snapshots**. A read-only query later saw **727 observed, 726 verified settled, 2,871 snapshots**. Three consecutive newly settled production rounds were:

| Expiry UTC | Round ID | First raw snapshot UTC | Verified outcome |
| --- | --- | --- | --- |
| 17:04:00 | `0xf1752e9bec5f0352b3962df970b0bd6fef038a8e72c5d85066523bf76b73f107` | 17:03:02.096 | DOWN |
| 17:05:00 | `0x78c0710f64b03e7b7ac714a5a4e5eba0600a7cad4a6314c5ee543072426865b5` | 17:04:02.074 | UP |
| 17:06:00 | `0x23445990ba2b845c7b8a03f69bf2f0e3f3f7c1b645ea943e41773b17c31fa779` | 17:05:02.083 | DOWN |

**This does not satisfy the requested production proof:** the published version has no prospective forecast/evaluation table, model version, captured-before-settlement forecast, verified-settlement timestamp, or measured evaluation latency. Those records cannot truthfully be reconstructed by backdating predictions. Verify three *new* rounds after a reviewed publication, not these old ones.

## Development-only functional evidence

After the development workflow restarted, three consecutive verified rounds each had an immutable raw snapshot and HOLD/no-model prediction captured before expiry and verified settlement. Baseline scoring completed within about **0.01 seconds after the local settlement-verification write**:

| Round ID | Raw + prediction UTC | Verification UTC | Scored UTC | Outcome |
| --- | --- | --- | --- | --- |
| `0xa8c5095629046ec539874f9095fd3ec9194c5a1c832df6a4f45be378e30e7b97` | 17:08:20.450 / 17:08:20.461 | 17:09:08.505 | 17:09:08.512 | UP |
| `0xc75897a64872a63a2c9b4fd3623b1c2733819b0a7e9f7ea85dbb655b6a980f17` | 17:09:20.456 / 17:09:20.465 | 17:10:08.509 | 17:10:08.518 | UP |
| `0x7deaa06c96e26b0b28b90218f602d24985442d93992cbc693236dcee1fcd12b6` | 17:10:20.465 / 17:10:20.475 | 17:11:08.561 | 17:11:08.571 | DOWN |

All three prediction records say `NO_PROMOTED_MODEL` and `HOLD`; their on-chain indicative inputs were baseline-scored, **not** calibrated model forecasts. The development database had 70 observed / 69 settled / 0 evaluated at the first API check after preview startup; by the evidence query it had 84 observed / 83 settled / 13 prospectively baseline-evaluated. The original development sample was 60 observed / 59 settled. These are development observations, **not production proof**.

## Honest model and market boundaries

- Historical snapshots permit offline retrospective baselines. They cannot prove a model forecast existed at the time. A separate append-only table captures new predictions before settlement, with a fixed first usable 45–30-second window, and a separate idempotent score table stores outcomes after verification.
- Training code implements chronological L2 logistic fitting and separate Platt calibration/held-out testing, with a 90-second boundary embargo. It remains **shadow-only** and is gated by at least 300 unique rounds spanning two UTC dates. Neither database currently establishes a promoted multi-day validated model; no live calibrated UP/DOWN probabilities are shown.
- An honest volatility/distance directional baseline is unavailable without documented settlement-relevant signed distance. Coinbase comparison prices are not the DeepBook settlement oracle. Executable opposite-side prices, payout, fees, fills and contract equality/void rules are not fully verified; no profitability or hedge calculation is shown. Exact equality stays UNKNOWN, never silently DOWN.
- The collector can retry known unresolved IDs on restart, but the active-market SDK does not enumerate all historical BTC one-minute markets. A time gap is **unknown publication**, not proof a round existed. Twenty-four-hour and seven-day displays report observed counts, not completeness percentages.

## Release gates still open

1. Owner reviews the development preview, mobile/desktop screenshots, and schema diff. Keep the published app unchanged until approved.
2. Choose an always-on Reserved VM or an independently scheduled collection worker. Autoscale alone can sleep and cannot guarantee continuous capture; design and test replay/gap recovery and provider rate-limit behavior before claiming coverage.
3. Verify the exact DeepBook equality/void/payout semantics and settlement-relevant inputs before promoting a model or any directional/economic recommendation. Multi-day held-out quality, drift, confidence reliability, atomic champion promotion/rollback, and tested retraining schedule remain unavailable.
4. Run restart/fault-injection/database integration tests for duplicate writes, partial failures, reconciliation, provider outages and clock skew. Existing unit tests/build are necessary but not sufficient.
5. After approval and a safe additive publish (never overwrite production data), collect three consecutive new production settlements with pre-settlement raw snapshot + forecast, verified result, before/after counters, evaluation latency, model version and retraining status; then verify continuous collection and rollback/monitoring in the published deployment.

Screenshots are in `screenshots/` (320px and 390px phones, 820px tablet, 1280px desktop). The website and API never connect a trading wallet, sign, submit orders or execute a hedge.