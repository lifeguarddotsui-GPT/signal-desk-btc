# Open-wallet mainnet beta: development readiness review

## Status

**NOT RELEASED. No owner-signed prediction order, delegate order, automatic
signing, automatic submission, claim, fill or realized mainnet P/L is proven.**
The new wallet and account identity paths are development-only. Production has
not been modified or published. Passing tests are not execution evidence.

## Implemented boundaries

- Compatible Wallet Standard wallets are selected by features, not brand or an
  owner-address allowlist. A mainnet-capable selected account signs a
  domain-bound, 2-minute single-use login challenge. HttpOnly mainnet sessions
  expire after 15 minutes. Connecting does not authorize any transaction.
- Legacy testnet sessions cannot authenticate mainnet routes. Legacy policies
  and histories are retained; a testnet policy cannot arm mainnet observation
  and must be explicitly replaced by the owner.
- Mainnet policy validation requires fixed orders at most 500 cents, no
  compounding/percentage sizing, bounded daily turnover and at most 1,000 cents
  combined unresolved exposure. Risk evaluation includes entry fees in the $5
  ceiling. **These checks do not substitute for durable order-intent accounting;
  all order submission remains unavailable.**
- The production configuration is explicitly supplied to SDK 6.1.0 at
  `https://main-v2.waterx-config.pages.dev/mainnet.json`. Chain identifier,
  prediction/account packages, registry object types and settlement coin are
  pinned and checked through read-only mainnet gRPC calls. Identity drift fails
  closed. Startup checks run in development; production Agent routes remain
  disabled pending release approval.
- The observed settlement coin is WaterX USD, with 6 decimals. Wallet USDC is
  **not** spendable WaterX collateral merely because a wallet holds it.
  No USDC-to-USD conversion, credit backing or redemption path is qualified.
- Owner account-management transactions can be prepared for review against
  verified mainnet account ownership. They are not prediction-order proofs.
  Their 0.1 SUI gas budget is a ceiling, not an estimate. Frontend signing stays
  disabled; enabling it requires the remaining reviewed release evidence.
- History uses exact interval/round/start/end joins, immutable canonical choices
  or frozen CHAMPION primary checkpoints, never later odds or unqualified shadow
  forecasts. Correctness uses currently verified non-disputed WaterX outcomes;
  withdrawal removes a label from scored denominators. Missing/invalid/ambiguous
  choices remain visible. Source, interval and window filters recompute ratios
  and hit rates. Public prediction history never exposes wallet trading records.
- Closed observed rounds form history; completely uncaptured rounds remain a
  separate collector-coverage failure. Lifetime queries fail explicitly beyond
  50,000 rounds rather than silently reporting truncated statistics. Displayed
  cards are bounded to 200, independently from full selected-cohort statistics.
- Canonical lock timing and learning/promotion rules are unchanged. Existing
  prospective mechanical early candidates remain shadow-only. Readiness is
  decision progress, not win probability. No execution deadline is invented.

## Mandatory work/evidence remaining

1. Verify exact BTC 5m/15m mainnet market IDs, YES/NO mapping and actual entry
   deadlines. Verify USD funding/conversion, received collateral and all fees.
2. Supply a fresh executable quote and exact build/simulation adapter with
   owner balances, gas estimate/cap, minimum shares, spend/price ceilings,
   quote expiry and immutable round identity. Indicative odds are insufficient.
3. Implement durable wallet-wide per-round reservation/fill accounting and
   unknown-send reconciliation across accounts, sides, policy changes, worker
   duplication and restart. A unique intent identifier alone is not a $5 limit.
4. Prove an explicitly owner-signed small mainnet prediction order, fills,
   actual cost, settlement and net P/L; then a separately opted-in dedicated
   restricted delegate order, withdrawal/management denial, expiry and revoke.
   No owner keys/seeds may enter the service.
5. Review a recoverable production signer and persistent worker architecture,
   unknown-send recovery, eligibility and recurring costs. No 24/7 claim.
6. Measure quote-to-accepted-order latency and actual order deadline, disclose
   the conservative buffer, then shadow-score a separately versioned early
   execution signal including quote/liquidity/reference validity. Existing
   mechanical baseline candidates do not establish an executable edge.
7. Continue prospective daily error/calibration/coverage/economics audits and
   untouched embargoed forward evaluations. No new champion or improved ratio
   is claimed by this change.
8. Complete real-browser multi-wallet/chain-change/expiry/revoke/rollover and
   phone testing at 320/375/390/430 pixels and desktop. Capture tools cannot
   authenticate or prove owner-wallet behavior.

## Migration, backup, cost and rollback plan

- Development migration adds a network discriminator to sessions; existing
  sessions default to testnet and are refused by mainnet authentication.
  No development rows are removed or account histories rewritten. Source
  migrations remain separate from canonical research.
- Production schema changes must use normal Publish only: no startup/deployment
  DDL, custom production migration or overwrite-data operation. Before public
  rollout, restore a current complete production backup in isolation, review the
  schema diff and retain the backup privately outside this workspace.
- No new hosting/signer service or recurring cost was approved or enabled.
  Report an actual provider/host/database/signer cost before activation.
- Before release, retain a reviewed source/build checkpoint and keep the
  server-side execution kill switch disabled. Stop submissions before rollback;
  reconcile UNKNOWN orders, filled exposure and settlement first. A code
  rollback cannot reverse mainnet trades or safely assume a database rollback.
  The session column is additive and can remain during a code rollback.
- Do not upload secrets, signing material, production exports or backups to
  GitHub. Wallet-signed evidence and public configuration identity are separate
  from private wallet history and production data.