# Blue Water · Wallet recovery + trade readiness · release notes (2026-10-16)

## Verified owner funds evidence
- Owner wallet: `0xf9c496e9ac73fa9d6f75ba323b46fff11f714cd0cdcdc5751ebdff3d294f45ba`
- Deposit digest: `Dve8UyZtT5eqbKpC7sjPJ8TFM6SWW6NWQTgKbwZRzchT`
- Owned WaterX account: `0x57ee90694e63249c2ae75696239b8a6b0966d3ca49ce72b134fedf303c86761f`
- 5,000,000 atomic WaterX USD = **5 USD account credit**. Public RPC audit confirms the exact account ID belongs to owner and is credited.
- Unsigned checked **mainnet transaction simulation passed** for requested 5 USD credit with hypothetical minimum 4.90 native USDC output and 0.1 SUI MAX GAS BUDGET (not expected gas charge). Evidence: https://github.com/lifeguarddotsui-GPT/signal-desk-btc/actions/runs/38973558273.
- **No withdrawal has been signed/broadcast; keeper queue processing, actual return, fees, and final wallet receipt are not proven.**

## UI recovery mechanics
- After Slush wallet login and owned-account selection, the Fund step now includes a visible Recover Funds panel.
- Owner sets WaterX USD amount <= currently read WaterX credited balance and the absolute minimum USDC output. No auto-derived min is silently approved; 6-decimal integer amount conversion with no rounding up.
- Before prompting any wallet approval, amount/min must be valid, positive, and owner consents to queued withdrawal risks; existing `owner-simulation` and `owner-transaction` sign-reviewed flow is reused.
- Requires a second explicit review confirmation after simulation, then optional owner Slush signature. No service signing, no stored keys, no automated redemption.
- Server `ownerTransaction('REDEEM_USDC')` builds `routeNative` + `requestCreditWithdraw` + `enqueueWithdrawal` with recipient fixed to authenticated wallet; caller cannot substitute payout recipient.
- After signature, never retry submission on an uncertain digest; use existing `owner-confirm` reconciliation. A confirmed **queue request is not proof of received USDC**.
- If current balance is stale or source discovery fails, recovery form stays blocked.

## Why the old $5 Entry Window felt unusable
- The prior UI spent most of its footprint enumerating unavailable data and hypothetical fee cautions without telling a human what would change their decision. Its official WaterX price-to-beat is frequently unconfirmed, and the saved round stages may be empty.
- The source parser **requires provider `anchorPriceConfirmed===true`**; merely receiving BTC/Coinbase chart prices does not prove a WaterX official round reference. Do not fabricate this boolean or substitute Coinbase.
- New Trade Readiness display foregrounds one WAIT reason, time remaining, saved direction (or none), known side ask, hypothetical $5 winning gross, break-even winrate and a clear reason to abstain. If no quote is reported it says so plainly.
- Folded local economics calculator permits the owner to manually enter their actual WaterX YES/NO purchase ask and total estimated costs, calculates winning net, loss, and break-even win rate. It **does not** fetch/store quotes, issue BUY NOW or estimate trained model confidence.
- Correlated Early/Confirmation/Primary agreement remains described, not turned into invented predictive certainty.
- All advanced provenance warnings remain available on demand.

## Deployment constraints
- No database migration, SQL schema reset, custody/portfolio transfer, automatic order, or new polling interval.
- Existing visitor-only mode must remain enabled and database-copy-to-production option unchecked.
- PR CI must pass TypeScript, complete test suite in four shards, cost/visitor regression and PostgreSQL integration on exact final revision.
- Publish only after Replit checkout source is synchronized and approved; no Replit Agent needed to rewrite source.
- Production smoke test requires Slush owner login, correct account balance, valid minimum-output simulation, explicit review and the wallet's approved transaction flow. Never mistake a simulation for a completed withdrawal.
- Trade Readiness smoke test on 5m and 15m when WaterX price-to-beat unavailable vs confirmed, when saved signals missing and when user enters a genuine purchase ask. Keep underlying flow non-executable.

## Priority next
Investigate upstream WaterX provider `anchorPriceConfirmed` field, exact market ask freshness and round-ID matching. The UI redesign does not itself fix missing provider data or demonstrate higher prediction accuracy/positive expected value.
