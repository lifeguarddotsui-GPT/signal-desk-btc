# Acceptance report

**Scope:** repository evidence and operating artifacts for an Observe/Paper
MVP. **Date:** artifact creation. **Live transaction status:** none submitted.
**Profitability status:** no claim; no profitability backtest was performed.

## Status definitions

- **VERIFIED:** supported by the supplied brief and cited public documentation,
  with limitations recorded.
- **IMPLEMENTED_NOT_LIVE_TESTED:** encoded in this repository's artifact,
  schema, or control but not exercised against live mainnet.
- **BLOCKED:** required evidence, service, deployment, or test is absent.
- **HYPOTHESIS:** proposed strategy, threshold, or experiment.

## Acceptance matrix

| Requirement | Status | Evidence / remaining condition |
| --- | --- | --- |
| Mainnet-pinned adapter manifest | IMPLEMENTED_NOT_LIVE_TESTED | `config/suipump-mainnet.manifest.json` pins `sui/mainnet` and `live_signing: false`; no chain read was performed here. |
| Suipump public research record | VERIFIED | `docs/suipump-integration.md` cites the site, bundle, whitepaper, Sui docs, and explicitly separates discovery evidence from contract evidence. |
| Package/object/function lineage | BLOCKED | Exact package IDs, defining IDs, write IDs, curve/pool IDs, event types, functions, and versions were not established in the brief. |
| Current on-chain buy and sell effects | BLOCKED | No transaction was submitted or corroborated. Live signing is prohibited. |
| Audit status | VERIFIED / BLOCKED | The brief reports experimental/unaudited-mainnet language; no matching report/deployed-version linkage is available. No audit claim is made. |
| Risk policy and bounds | IMPLEMENTED_NOT_LIVE_TESTED | `config/risk-policy.json` encodes initial limits and explicit mode; enforcement and failure tests remain outstanding. |
| Research response contract | IMPLEMENTED_NOT_LIVE_TESTED | `config/research-output.schema.json` is strict and denies transaction payloads/additional properties; no model call was run. |
| Architecture and custody boundary | IMPLEMENTED_NOT_LIVE_TESTED | `docs/architecture.md` documents isolated signer, server-controlled custody caveat, ledger invariants, and AI limits. |
| Operating procedures | IMPLEMENTED_NOT_LIVE_TESTED | `docs/operations-runbook.md` documents reconciliation, incidents, pause, recovery, and withdrawal; no drill was run. |
| Always-on worker | BLOCKED | The brief states Autoscale may scale to zero. An always-on worker independent of UI traffic, with supervision/health checks, has not been evidenced by this artifact set. |
| Deposit / Withdraw All | BLOCKED | Owner proof, transaction effects, liquidation, residual-token recovery, and idempotent transfers require implementation and live/canary testing. |
| 10→100 accounting | IMPLEMENTED_NOT_LIVE_TESTED | Accounting rules distinguish deposits, liquidation value, confirmed returns, costs, rebasing, and the 900% experimental goal. No return is asserted. |
| Paper replay and market coverage | BLOCKED | Required 14-day launch/trade observation, replay, holdout, latency, failed-token, and coverage evidence are not present. |
| AI safety behavior | IMPLEMENTED_NOT_LIVE_TESTED | Schema and architecture prohibit signer access, policy expansion, destination changes, and unsupported probabilities; outage behavior still needs tests. |
| Live canary | BLOCKED | It requires all integration/evidence gates, owner policy enablement, and always-on operations first. |

## Explicit non-claims

This report does **not** claim package IDs, object IDs, buy/sell effects, public
trading endpoints, SDK support for Suipump, audit status, successful execution,
performance, positive expectancy, or profitability. A frontend-discovered
constant is not on-chain corroboration. PumpPortal and other Solana sources
are not Sui integrations.

Ten SUI becoming 100 SUI requires a 900% net gain. It is an experimental target,
not a forecast, timeline, or service promise. A stop loss is an attempt to sell,
not a guaranteed loss limit. Server-held hot-wallet keys would be custody
controlled by the server and must not be labeled noncustodial.

## Staged acceptance gates

1. **Observe:** prove ingestion, provenance, coverage, replay cursor, and
   rejection reasons without trading.
2. **Paper:** prove deterministic decision-time replay, full-size executable
   quote assumptions, accounting, and chronological holdout reporting.
3. **Operational safety:** prove restart recovery, single-worker fencing,
   stale/unknown transaction handling, malicious-input rejection, withdrawal,
   sweep idempotency, and cost/health monitoring.
4. **Evidence:** corroborate current package/object lineage, exact functions,
   fee math, restrictions, route, and successful buys and sells.
5. **Bounded canary:** only after owner enables a concrete policy, maximum 1
   SUI funded and orders at most 0.1 SUI when economics permit. This verifies
   plumbing, not a profit outcome.

Any failed gate returns the system to Observe/Paper. The AI cannot reset a
drawdown or widen a gate.
