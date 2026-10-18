# Existing funded WaterX wallet: path to one independently executed $1 trade

Status: planning/preflight only. No transaction has been built, signed, submitted or funded from this document. Mainnet agent release remains OFF.

## Verified historical evidence

- Owner Sui address: `0xf9c496e9ac73fa9d6f75ba323b46fff11f714cd0cdcdc5751ebdff3d294f45ba`.
- Owned WaterX account: `0x57ee90694e63249c2ae75696239b8a6b0966d3ca49ce72b134fedf303c86761f`.
- October 16 ledger audit: 5,000,000 atomic WaterX USD credited, equivalent to $5. This is not a current balance.
- Existing owner-signed account-management simulation and credit verification do not demonstrate authority to place a prediction order.
- `/api/agent/capabilities` has mainnet disabled, `/api/agent/control` rejects LIVE, `/api/agent/delegate` rejects authorization, the current agent worker cannot submit and no operational isolated signer exists.

## Immediate low-cost first-trade order

1. Refresh owner-account and WaterX USD credit balance, outstanding unresolved positions, wallet SUI gas and exact current WaterX BTC 5m/15m market mapping through pinned SDK mainnet reads.
2. Obtain an **actual** executable current order quote: YES/NO mapping, round ID, spend, entry fees, min shares, price cap, expiry and estimated gas. Test whether one order below or equal to $1 is allowed by WaterX; don't assume a protocol minimum.
3. Prepare one **owner-signed** transaction using `@waterx/sdk/prediction.placeOrder` for the exact current market and this owned WaterX account. Verify bytes, self receiver, full-size quote, permitted total spend plus entry fees no more than $1 in WaterX USD, acceptable SUI gas budget and fullnode simulation. Require wallet's explicit review and signature; submit at most once, persist digest, never blindly retry an unknown submission. This is a manual technical proof, **not autonomous execution**, and the current production owner-order endpoint does not exist yet.
4. Reconcile on-chain digest **and order/fill** evidence, not transaction success alone. Preserve event IDs, actual spent collateral, unfilled refunds, status and settlement.
5. Only then activate autonomous one-order mode by owner-approved restricted delegation. An owner-signed message by itself cannot give an unattended server Slush signing rights. A separate signer key with verifiably limited on-chain PLACE_ORDER permission and a durable one-order nonce/ledger is required. Do not grant withdrawal or delegate management.
6. Revoke test delegate after one autonomous order and reconcile all unsettled positions. Require a new explicit owner signature for any subsequent order/session.

## Exposure boundaries

- Target is **$1 total WaterX USD exposure including entry fees**, not a guaranteed filled $1 position; WaterX may reject amounts below its minimum.
- Keep the remaining $4 isolated to the existing small test account, but note an account-scoped PLACE_ORDER delegate could potentially lose **up to the full account's funded assets**, despite software limits, if its key/code is compromised. A $1 software cap is not an on-chain $1 restriction.
- Default mainnet policy is $5 fixed stake, $2 reserve and zero session authorized SUI gas. Change these through the **owner-reviewed, signed** policy—not a release flag or database override. SUI gas is separate from the $1 WaterX USD order cap.
- Even for a $1 test, no unattended signer private key belongs in public GitHub, Replit editor secrets or shared deployment credentials.
- AES-GCM encryption protects stored delegate key material against storage-only compromise, but unattended signing needs a decryption/signature path. Replit presently holds Cloudflare deployment authority according to the prior operator audit: a deploy-capable credential can replace Worker code and therefore bypass encryption-only protection. An independent deployment authority / key isolation boundary is necessary. This could be a separate owner-controlled Cloudflare account or narrowly scoped signer Worker with deployment administration rotated/revoked out of Replit. GitHub alone cannot verify the provider controls.
- Current Cloudflare background collector is a 26-hour trial and **has no funded submission path**. The October 5 short compatibility probe did confirm browser-free scheduling and encrypted test-key recovery, but not funded execution or continuous-cost headroom.
- Never describe the first real order as completed until owner-reviewed transaction, signed mainnet digest, provider-confirmed order/fill and accounting are verified.

## Free-first implementation acceptance

No paid always-on VM by default. Reuse Cloudflare Durable Object background alarms and once-per-minute Cron watchdog for 5m/15m collection, immutable decision evidence and eventual one-shot dispatch; Replit stays visitor-only. Run bounded tests of time-to-lock/actual quote freshness, source availability and rolling Free account limits before enabling perpetual operation. Keep market/order critical state in signer-controlled durable SQLite; archive results to Replit PostgreSQL infrequently to avoid waking billed compute on every tick. Do not move keys or override shared administrative access to hurry a $1 test.

**Integration:** Agent draft PR #25 only; preserve mainnet disabled, existing wallets, balances, Cloudflare account, Replit production and Live Desk source. Initial executable trade must be separately reviewed at an exact commit and is not authorized just by this plan.
