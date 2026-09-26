# BluewaterAI BTC market audit — 2026-09-26

This is a dated diagnostic record, not a claim that the published site has been updated.

## Source and production

At 14:18 UTC the published autoscale site at `bluewaterai.app` reported packaged build
`sha256:118c1d4e22ca2094d7d8b592f33becd9aba1487eb9c7dc0253ada77b0151891f`.
The local pre-edit `dist/build-info.json` contained the same hash (server bundle, client output,
and dependency lockfile). The checked-out workspace was `a522adb` at inspection time.
Matching bytes make it a reproducible candidate source, not cryptographic proof of the Git
commit that was published: the build ID does not include a commit and the deployment metadata
does not expose one. Do not publish an older public-repository tree over this running package.

No production schema or data was changed during investigation. The production database
backup has **not** been restore-tested. Any future schema publish needs a reviewed backup
and Replit's supported publish-time schema diff; never run a startup migration.

## Reproduced pipeline stall

Read-only production checks near 14:20 UTC showed 1,775 observed rounds, 1,771 marked
`VERIFIED_SETTLEMENT`, 477 primary-window predictions, and 465 scores. The last score was
recorded at 03:28 UTC despite ongoing observations and settlements. The seven newer
primary-window records inspected had `indicative_up` absent and could not be scored.
Across the most recent 12 hours, about 98% of stored snapshots had a probability, but
virtually none landed **inside** the fixed 45–30-second primary window with one.
Representative rounds had snapshots around 53, 29, and 10 seconds remaining. These are
missed capture windows, not grounds to invent or retrospectively fill predictions.

The app had awaited discovery, probability reads, settlement reconciliation, and training
sequentially under one collector lease; provider latency and an approximately 20-second
effective capture cadence routinely skipped the 15-second eligibility interval. The repair
schedules bounded, near-window retries with a separately coordinated capture lease and
idempotent snapshot identities. It does not change the historical 45–30-second scoring
horizon or rewrite old predictions. Health now distinguishes capture, prediction, verified
settlement, scoring, and their backlog/exclusion reasons instead of treating a fresh
heartbeat as proof the learning pipeline is healthy.

For independent verification after a reviewed publish, compare successive `/api/health`
pipeline counters and inspect three newly issued, consecutive eligible predictions
**before expiry**, then their verified outcomes and one persisted score each. A development
preview or retrospective model backtest is not production proof.

**Development verification at 14:43 UTC:** After the final preview restart at
14:39:34 UTC, three consecutive one-minute rounds had immutable predictions issued
at 14:40:16, 14:41:16, and 14:42:16 UTC with 43.925, 43.899, and 43.925 seconds
remaining. Each had a valid market probability and pre-expiry capture timestamp;
settlement was independently verified after expiry at 14:41:10, 14:42:10, and
14:43:06 UTC respectively. Each then had exactly one persisted score. This demonstrates
the local pipeline and its idempotent persisted result, not a published-site repair.

## Estimated economics

The installed SDK's `read.quoteMint` needs an owner account. The generated on-chain
`expiry_market::quote_mint` supports anonymous, no-builder read-only simulation instead;
it is paired with the configured live pricer in one simulated transaction. A successful
mainnet read-only probe at 14:23 UTC returned two sides for **$5 gross winning payout
quantity**: UP premium $2.452511, trading fee $0.808884, all-in cost $3.261395
(65.23% break-even); DOWN premium $2.547488, trading fee $0.808884, all-in cost
$3.356372 (67.13% break-even). These are one-time observations, not standing prices.
Network gas, account balance, personal fees, slippage, and fill are not guaranteed.
No independent forecast edge or expected value follows from the quote.
The revised development `/api/economics` also returned both sides at 14:33:37 UTC:
UP cost $4.278537 for $5 payout (85.57% break-even) and DOWN cost $2.899240
for $5 payout (58.0% break-even). A later round populated the responsive Live
screen; costs were hidden when the manual entry window closed.

## Remaining release gates

- Restore-test a production backup and review any schema diff before publishing.
- Prove three **new consecutive** eligible rounds survive capture, verification, and scoring.
- Configure an approved always-on worker if uninterrupted collection is required;
  an idle autoscale instance cannot guarantee it.
- Prospective matched-baseline evidence, predetermined promotion/rollback criteria,
  and enough elapsed verified history are still required before any model claim.
- Validate the current published build, responsive screenshots, and non-degraded
  pipeline alerts after publishing. No automatic trading is permitted.