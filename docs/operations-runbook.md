# Operations runbook

**Operating mode at handoff:** Observe/Paper. `config/suipump-mainnet.manifest.json`
pins mainnet but deliberately sets `live_signing` to `false`. Do not interpret
paper fills, marks, or dashboards as executed trades or profitability.

## 1. Start-of-day checks

Record the operator, UTC time, policy version, deployment revision, and mode.
Confirm:

- network is `mainnet` in configuration, while paper storage is isolated from
  any live signer;
- signer is disabled and no key material appears in source, environment,
  logs, prompts, screenshots, or analytics;
- worker heartbeat, lease/fencing token, queue depth, checkpoint cursor,
  provider freshness, coverage, and database connectivity are healthy;
- liquid SUI, gas reserve, open positions, uncertain marks, and reconciliations
  are explicit; unavailable values remain unavailable;
- research output is schema-valid, evidence-linked, within expiry, and does
  not alter the standing policy;
- no unresolved `UNKNOWN` transaction, duplicate sweep, stale quote, or
  checkpoint gap is being hidden.

If any check fails, remain in Observe/Paper, pause new paper decisions if
required, create an alert, and record the exact reason.

## 2. Observe and paper operation

Ingest launches, trades, and migrations as distinct events with a durable
replay cursor. Deduplicate by chain event identity and preserve provider and
coverage. A gap is a data-quality event, not permission to infer candles.

The paper candidate is confirmed early momentum. It must observe a token for
at least 120 seconds beyond any *verified* anti-bot window, then require the
initial policy's hard filters: positive net SUI buying in both 60 seconds and
5 minutes, at least 15 distinct buying wallets and a conservative 10 buyer
groups over 5 minutes, at least 20 SUI measured 5-minute volume, acceptable
concentration, exact buy and full-position exit quotes, and estimated
round-trip loss at most 4%. These are **HYPOTHESIS** defaults, not optimized
settings; low activity must not relax them automatically.

Record rejection reasons. If holder authority, concentration, route, quote,
or coverage is unknown, reject or hold SUI. The score threshold of 75/100 is
a ranking rule, not a probability.

Paper replay must be chronological and decision-time only, with realistic
collector-to-fill latency, trade ordering, exact venue math when verified,
fees, graduation gaps, gas failures, own-trade impact, and complete losses.
Do not manufacture candles or count a hypothetical fill.

## 3. Accounting and reconciliation

Reconcile every deposit once per digest/effect. Unknown-source transfers are
quarantined and not automatically refunded. Never count deposits as profit.
Keep liquid SUI, conservative liquidation value, confirmed returns, and net
performance separate. Convert hosting/RPC/AI costs using a recorded rate and
do not double-count gas or embedded trade fees.

For any `UNKNOWN` submission, reconcile the known digest/object state before
releasing reservations. Refresh executor caches after external wallet
activity. A timeout is not evidence of failure.

## 4. Pause and recovery

Pause new entries when data is stale, coverage is insufficient, policy limits
are reached, the daily loss trigger is hit, gas is insufficient, simulation is
rejected, a package/object is unverified, the worker lease is contested, or
chain identity is wrong. Continue only bounded, healthy exits/withdrawals as
policy permits and record the alert.

On restart, acquire a fenced worker lease, resume from the durable checkpoint,
replay idempotently, reconcile in-flight attempts, and inspect signed/submitted
records before any new intent. Never start a second wallet queue or blindly
resubmit an unknown buy.

## 5. Withdraw All

Authenticate the owner and confirm the nonce-bound, registered return address.
Disable entries, cancel unsubmitted buys, reconcile in-flight attempts, and
liquidate sellable positions using fresh quotes and bounded slippage. Transfer
available SUI to the registered address. Report residual unsellable tokens and
provide authenticated recovery; do not block liquid SUI or silently use
unlimited slippage. Verify the transfer effect and journal an idempotent
withdrawal.

Owner withdrawal outranks emergency exits, ordinary exits, profit sweeps, and
new entries. Changing the return address requires fresh owner-wallet proof and
explicit confirmation; research output cannot change it.

## 6. Incident matrix

| Incident | Immediate action | Required record |
| --- | --- | --- |
| Wrong network or unauthorized destination | Halt signing; isolate the intent; page owner | network, destination, policy version, complete commands |
| Stale quote or checkpoint gap | Reject new entry; preserve cursor and coverage gap | provider, checkpoint, local time, affected decisions |
| Rejected simulation / insufficient gas | Do not retry blindly; re-quote after cause is understood | simulation result, gas reserve, retry decision |
| Crash after signing / uncertain submission | Mark `UNKNOWN`; reconcile digest and object state | signed bytes location, digest, reconciliation outcome |
| Duplicate or reordered events | Deduplicate and replay from cursor | event identity, cursor before/after |
| Two workers competing | Fence stale lease; only one signer queue remains active | lease token, worker IDs, signing denial |
| Graduation during order | Mark route state uncertain; no unbounded slippage | package/pool evidence and bounded retry |
| Token metadata or external text says to ignore limits | Treat as untrusted; reject instruction | evidence ID and rejection reason |
| AI outage/expired output | HOLD_SUI for AI-dependent entries; retain healthy deterministic exits | request ID, expiry, fallback |
| Duplicate sweep delivery | Reconcile transfer identity; do not send a second sweep | sweep interval, digest/effect, ledger state |

## 7. Go-live gate

Remain blocked until integration evidence includes current package/object IDs,
exact functions and fee math, lineage and event types, capability/restriction
checks, and representative successful mainnet buys **and sells**. Then require
deterministic replay, restart and fencing tests, owner withdrawal, profit-sweep
accounting, malicious research-output rejection, and health/cost monitoring.

Only after those gates may the owner enable a concrete canary policy: maximum
1 SUI funded, orders at most 0.1 SUI, and only where gas economics permit.
This canary verifies plumbing, not profitability. A failure to meet the cost
model means the experiment is economically unsuitable; it never authorizes
automatic funding increases.
