# Suipump integration evidence

**Scope:** Observe/Paper MVP only. This document is an evidence register, not an
integration claim or a trading recommendation. No transaction was submitted by
this repository and no private system was accessed.

## Status vocabulary

- **VERIFIED** — directly supported by the supplied research brief and its
  cited public source, with the limitation stated beside the claim.
- **IMPLEMENTED_NOT_LIVE_TESTED** — represented by a repository artifact or
  control, but not exercised against mainnet in this repository.
- **BLOCKED** — a prerequisite is missing; the system must not proceed past
  Observe/Paper.
- **HYPOTHESIS** — an experiment or proposed behavior, not an observed fact.

## Network and source register

| Item | Status | Evidence and limitation |
| --- | --- | --- |
| Sui mainnet is the intended live chain | VERIFIED | The brief requires chain identity to be pinned to Sui mainnet. This repository's adapter manifest pins `network` to `mainnet`. |
| Suipump public site | VERIFIED | <https://suipump.org/> was reviewed in the brief. Its served frontend was reported to advertise a 1% curve trade fee and to contain mainnet configuration. Frontend constants are discovery evidence, not an integration contract. |
| Public frontend bundle | VERIFIED | <https://suipump.org/assets/index-CF-MKHlY.js> was reviewed in the brief. The brief reports multiple contract lineages through V17, distinct defining/write-package handling, indexer integration, and an agent interface. Exact deployed identifiers were not established here. |
| Suipump whitepaper route | VERIFIED | <https://suipump.org/whitepaper> and text in the public bundle were reviewed in the brief. The brief reports an explicit experimental/unaudited-mainnet statement and conflicting testnet/future-audit text. Audit status therefore remains unresolved. |
| Linked source repository | BLOCKED | The bundle links to <https://github.com/cacoandrade455/suipump>, but the brief says it could not be retrieved during research. No commit or bytecode linkage is claimed. |
| Current curve write package | PARTIAL | On 2026-09-15 the live `/tokens` feed reported `0xb205...d9b0`; 50 current curve IDs were independently resolved through Sui GraphQL as shared `bonding_curve::Curve` objects under that immutable package. Defining/upgrade ancestry, raw event types, and executable buy/sell effects remain unverified. |
| Sui gRPC documentation | VERIFIED | <https://docs.sui.io/develop/accessing-data/grpc> documents backend access, simulation, submission, subscriptions, and retention considerations. It does not verify a Suipump adapter or endpoint. |
| Mysten transaction executors | VERIFIED | <https://sdk.mystenlabs.com/sui/executors> documents serial execution and object-version tracking, with coin-management care for parallel execution. It does not verify Suipump transaction functions. |
| PumpPortal services | VERIFIED, NON-SUI | <https://pumpportal.fun/local-trading-api/trading-api/> and <https://pumpportal.fun/data-api/real-time/> describe Solana transaction/data services. They are engineering-pattern evidence only and must not be used as Sui integrations. |

The brief is the point-in-time source record for this repository. It says it
was prepared 15 September 2026; that is the `source_snapshot_date` recorded in
the manifest, not a fresh retrieval by this artifact task. A future live
release must record the actual retrieval time, chain checkpoint, provider, and
coverage for every observation.

## What is and is not established

The following are **VERIFIED as research observations**, not as production
capabilities:

1. The frontend advertises a 1% curve trade fee. The exact contract formula and
   effective fee for a particular lineage remain unverified.
2. The frontend contains explicit mainnet configuration, several package
   lineages through V17, separate defining/write package handling, indexer
   integration, and an agent/session/runner interface.
3. One inspected session-sale payload sets minimum SUI output to zero. This is
   one observed frontend path, not proof about all paths. A Blue Water executor
   must independently require a positive minimum output and inspect the complete
   transaction.
4. The frontend advertises graduation choices including Cetus, Turbos, and
   DeepBook. A destination is not a usable exit route until the specific token,
   package version, pool, and transaction effects are verified.
5. The whitepaper text has an experimental/unaudited-mainnet statement. No
   matching audit report and deployed bytecode were verified, so this project
   makes no audit claim.

The following remain **BLOCKED** and are represented as `null` or empty
collections in `config/suipump-mainnet.manifest.json`:

- executable package IDs, original defining IDs, package versions, and commit /
  bytecode linkage;
- curve, pool, shared-object, and event type IDs/versions;
- exact buy, sell, graduation, and withdrawal function signatures;
- exact fee formula and fee recipient;
- capability custody, transfer/mint restrictions, anti-bot windows, and
  graduation transitions;
- successful recent mainnet buy **and** sell transaction effects;
- a stable documented public Suipump trading API or service-level commitment;
- enforceable bounds, expiry, revocation, beneficiary, and independent
  withdrawal semantics for native agent/session functionality.

It would be fabrication to fill those fields from frontend constants or
marketing text. Live signing is disabled until each applicable field is
corroborated from current on-chain objects and representative successful buy
and sell effects.

## Observe/Paper adapter contract

The proposed application interface is an internal contract, not a claim that
these are Suipump endpoints:

```text
discover(cursor) -> event batch
getMarket(asset) -> verified market state
quoteBuy(asset, suiMist) -> executable quote
quoteSell(asset, units) -> executable quote
build(validated intent) -> unsigned transaction
reconcile(digest) -> execution result
```

An executable quote must carry network, package lineage, exact inputs and
outputs, applicable fees, price impact, checkpoint, expiry, and a positive
minimum output. Assets are identified by coin type plus package lineage and
curve/pool ID; names and tickers are never trade identifiers. All amounts are
integer MIST or token base units represented as decimal strings at API
boundaries.

In Observe/Paper, discovery and quote-shaped records may be stored only when
their coverage and provenance are explicit. Paper fills must use decision-time
data and realistic latency; a candle low, a guessed market cap, or a
hypothetical quote is not a fill. No paper record is a real transaction.

## Evidence gates before any live canary

1. Retrieve current package and object data on Sui mainnet and populate the
   manifest with immutable identifiers, lineage, versions, and event types.
2. Verify exact fee math, capability custody, restrictions, anti-bot behavior,
   migration behavior, and a supported sell route for each enabled lineage.
3. Capture representative successful recent buys **and sells**, including
   transaction effects, gas, outputs, and failures; retain digests and
   checkpoints.
4. Verify the complete unsigned transaction and simulation independently of
   any quote or model service. Reject unexpected transfers, publishes,
   upgrades, objects, destinations, or zero minimum output.
5. Exercise deposit, buy, sell, crash recovery, and return transfer with a
   maximum 1 SUI canary only after the owner enables a concrete live policy.
6. Confirm an always-on worker, durable jobs, restart recovery, fencing,
   health/cost monitoring, and owner withdrawal. Dashboard traffic must not
   control trading.

Until all gates pass, the manifest's `live_signing` value remains `false` and
the policy's mode remains Observe/Paper.
