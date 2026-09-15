# Blue Water Agents — SUI accumulation experiment

This repository is documented as an **Observe/Paper MVP** for researching
tokens verifiably launched on Suipump and measuring realized SUI accounting.
It is not a profitability product, a live trading authorization, or a promise
that 10 SUI will become 100 SUI.

## Current safety status

- Chain identity is pinned to Sui **mainnet** in
  `config/suipump-mainnet.manifest.json`.
- `live_signing` is **false**. No live signing, buy, sell, sweep, or
  withdrawal is enabled by these artifacts.
- The manifest intentionally leaves package IDs, object IDs, functions,
  event types, lineage, and transaction evidence empty until independently
  verified on chain.
- Paper data must remain isolated from any live signer.
- A server-held agent key would be server-controlled custody, not
  noncustodial custody. Never use an owner's primary-wallet seed.
- No profitability, audit, SDK capability, public endpoint, or performance
  claim is made beyond the evidence cited in `docs/suipump-integration.md`.

## Evidence and operating artifacts

| Artifact | Purpose |
| --- | --- |
| `docs/suipump-integration.md` | Public-source evidence register, unresolved integration fields, and go-live gates |
| `docs/architecture.md` | Component boundaries, invariants, custody, accounting, and deployment design |
| `docs/operations-runbook.md` | Observe/Paper operations, reconciliation, incidents, pause, and withdrawal procedures |
| `docs/acceptance-report.md` | Acceptance matrix using VERIFIED, IMPLEMENTED_NOT_LIVE_TESTED, BLOCKED, and HYPOTHESIS |
| `config/suipump-mainnet.manifest.json` | Machine-readable mainnet-pinned adapter evidence; signing remains disabled |
| `config/risk-policy.json` | Versioned initial policy and fail-closed limits |
| `config/research-output.schema.json` | Strict non-signing research response contract |
| `.env.example` | Secret and deployment variable names only; no credentials |

The source brief reports that Suipump's public frontend advertises a 1% curve
trade fee, mainnet configuration, multiple lineages through V17, and several
graduation destinations. These are discovery observations, not authoritative
contract facts. Exact package/object IDs, fee math, capabilities, restrictions,
routes, and successful recent buys and sells remain blocked until corroborated
with current on-chain evidence. Solana services cited by the brief are not Sui
integrations.

## Accounting and the 10→100 target

The dashboard and records must distinguish liquid SUI (including gas reserve),
conservative net liquidation value, cumulative confirmed SUI returned, and net
performance:

`liquid SUI + conservative liquidation value + confirmed withdrawals − deposits`

Hosting, RPC, and AI costs are separate lines converted to SUI at a recorded
rate. Deposits are never profit; stale or unsellable marks are not accumulated
SUI. Success for the experiment means **100 SUI actually returned after
on-chain costs with no extra deposits**. Ten SUI to 100 SUI requires a 900% net
gain and is an experimental goal, not a forecast, timeline, or service promise.

## Staged gates

1. **Observe:** ingest and retain launches, trades, and migrations with
   provenance, coverage, checkpoint cursors, and rejection reasons.
2. **Paper:** replay decisions chronologically with decision-time data,
   realistic latency, fees, graduation gaps, gas failures, and complete losses.
3. **Operational safety:** demonstrate restart recovery, one fenced worker,
   stale/unknown transaction handling, owner withdrawal, sweep idempotency,
   malicious-input rejection, and health/cost monitoring.
4. **Integration evidence:** verify current package/object lineage, functions,
   exact fee math, restrictions, exit routes, and successful buys and sells.
5. **Bounded canary:** only after owner policy enablement, with at most 1 SUI
   funded and 0.1 SUI orders when gas economics permit. This verifies plumbing,
   not profitability.

Any failed gate returns to Observe/Paper. Research output cannot sign, alter
limits, reset drawdown, change payout addresses, approve packages, transfer
funds, or invent trading rules.

## Deployment blocker

The trading worker must be always-on and independent of dashboard visitors.
Autoscale may scale to zero, so it is not an acceptable trading-worker
deployment. An always-on/Reserved VM pattern is required, with supervision,
graceful shutdown, durable jobs, bounded retry/backoff, health checks, and
distinct production secrets/database. The repository artifacts do not claim
that this worker is deployed or live-tested.

See `docs/acceptance-report.md` for the complete status matrix and explicit
non-claims.