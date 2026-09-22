# Operational trading-system evidence

## Implemented in this update

- Backend health contracts for collector, database, Sui provider, Suipump adapter, replay, Paper worker, Mainnet executor, and signer.
- Public APIs:
  - `GET /api/operations`
  - `GET /api/markets`
  - `GET /api/markets/:curveId`
  - `GET /api/candidates`
  - `GET /api/activity`
  - `GET /health/live`
  - `GET /health/ready`
- Wallet-authenticated agent APIs for Paper creation, listing, details, mode, pause, resume, decisions, orders, fills, positions, ledger, and fail-closed arming/withdrawal.
- Persisted deterministic candidate ranking snapshots.
- Disabled protocol-manifest lead with a checksum and no accepted transaction evidence.
- Additive operational tables for manifests, rankings, agents, execution records, and collector dead letters.

## Current evidence

- Collector checkpoint: `325571714` at verification time.
- Discovery observations: 153 at verification time.
- Candidate markets ranked: 109 at final verification time.
- Raw chain events: 0.
- Verified executable protocol manifests: 0.
- Mainnet orders, fills, deposits, reconciliations, and withdrawals: 0.

The collector is therefore reported `BLOCKED`, not healthy. Candidate scores are reproducibly zero and hard-vetoed until lineage, sell construction, exit quotes, holder data, and raw event reconciliation are proven.

## Environment variables

- `DATABASE_URL`
- `SESSION_SECRET`
- `AUTH_CANONICAL_DOMAIN`
- `SUI_GRAPHQL_URL` (optional; defaults to Sui Mainnet GraphQL)
- `ACCUMULATION_COLLECTOR_ENABLED` (optional)

No signer secret is accepted by the current application. A future Mainnet signer must use a KMS/HSM or envelope-encrypted external signer and store only an opaque key reference.

## READY_FOR_FUNDED_CANARY status

`BLOCKED`. No funds or explicit owner arming were available, and the verified buy/sell manifest, isolated signer, transaction simulation, reconciliation, and complete withdrawal path are not implemented. No digest or fill has been fabricated.