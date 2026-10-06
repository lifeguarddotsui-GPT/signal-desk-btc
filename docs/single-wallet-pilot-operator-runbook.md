# Single-wallet pilot: operator-only control plane

## Current state — NOT VERIFIED, NOT A TRADING RELEASE

Owner approved an operator-only administrative environment. The exact proposed
environment is a **local administrative terminal on an owner-controlled trusted
workstation, outside this Replit project**. The wallet owner controls its OS,
credential manager and Cloudflare account. Its trust/availability still requires
owner confirmation; this is not a claim that Agent inspected the workstation.

The administrative workstation is only needed for deployment, rollback or
credential recovery. It does not collect markets, schedule gates, sign routine
trades or reconcile orders. Those operations must run in the Cloudflare Worker
and SQLite Durable Object. No VM, scheduled Replit compute or paid service was
activated. The existing isolated feasibility Worker remains stopped.

Presence-only inventory confirmed Cloudflare administration credentials in
shared, development and production environments. They have **not** been removed
or rotated. The available secret callbacks inspect existence or request secure
input; they do not provide a secret move/delete operation or Cloudflare global-key
regeneration. Do not put a replacement administrative secret into this project.

## 1. Owner setup — secure settings actions

1. Use a patched, owner-controlled workstation with Node 22+, local disk
   encryption and a credential manager. No web server or public preview runs in
   this administrative environment. Obtain reviewed source/artifacts separately
   from the running website; verify the release hash before every deployment.
2. In Cloudflare's API-token settings create a new administrative token restricted
   to the intended account, with Worker deployment/secret-management permissions
   and the read permissions needed for account subscription checks. Keep this
   token **only in the workstation's credential manager**. Test operator access
   before revoking the old credential. Token scope/API rejection must be resolved
   securely, not by printing a token or response body.
3. Inventory other projects/operators using the old global key. Move legitimate
   administration off that key before rotation. Existing collector Worker secrets
   and history must be preserved. Historical probe control tokens derived from
   the old key need controlled replacement if future readback is required; key
   rotation does not automatically rotate the secret stored in the Worker.
4. In Replit **Tools → Secrets**, remove Cloudflare administration keys/tokens
   from shared and development scopes. In **Publishing → Adjust settings** remove
   their production copies as well. Removing development secrets alone does not
   remove the published app's copies.
5. Check Cloudflare integration/connector scope: if public application identity
   can invoke a deployment-capable Cloudflare connector, remove that runtime
   binding too. Moving a raw key while leaving an equivalent connector does not
   establish isolation. Do not disconnect unrelated GitHub or other integrations.
6. Regenerate/revoke the superseded Cloudflare credential in Cloudflare's secure
   settings. Never paste the old or new token/key into chat, logs, shell arguments,
   repository files or this project's secure-input form.
7. Restart development processes and republish the website with the cleaned
   production configuration so old process environments are not retained.
   Do not accept schema changes as part of this step. If publishing proposes
   database migration, stop and apply the existing verified-backup gate first.

## 2. Administrative commands

Copy the reviewed operator scripts into the separate administrative environment:
`scripts/operator-signer.mjs` and `scripts/operator-environment.mjs`.
Load `BLUEWATER_OPERATOR_DEPLOY_TOKEN` from the credential manager into that
process only, and set the non-secret `BLUEWATER_OPERATOR_CONTEXT=owner-admin`.
Never use the Replit workspace terminal for these commands.

```
node operator-signer.mjs verify ACCOUNT_ID
node operator-signer.mjs deploy ACCOUNT_ID REVIEWED_ARTIFACT_DIRECTORY REVIEWED_SHA256
node operator-signer.mjs rollback ACCOUNT_ID PREVIOUS_ARTIFACT_DIRECTORY PREVIOUS_SHA256
```

Account ID, artifact directory and artifact hash are not secrets. `verify` checks
Free subscription status and operator read access; it deliberately does not claim
write access or recovery. Deployment and rollback require an exact reviewed hash,
target only `bluewater-single-wallet-executor`, preserve secret bindings, and
refuse explicit storage deletion/migration or paid activation.

The reviewed artifact directory must contain `executor.mjs` and:

```
{"script":"bluewater-single-wallet-executor","file":"executor.mjs","sha256":"REVIEWED_SHA256"}
```

**The real executor artifact has not been built or deployed yet.** Do not substitute
the inert feasibility probe or describe this tooling as a working trading agent.
Before a funded artifact can be released it must implement the verified order,
policy, reservation and reconciliation path described in the pilot brief.

The environment guard prevents accidental use in recognizable Replit contexts;
it is not an isolation boundary against malicious code that can unset variables.
Credential absence and provider-side revocation are the actual boundary.

## 3. Website invocation access

After operator deployment, create a fresh independent high-entropy invocation
credential in secure settings. Store it as a secret in the Worker and as
`AGENT_SIGNER_INVOKE_TOKEN` in the website; it must not be a Cloudflare API token,
global API key or value derived from an administrative credential.
`AGENT_SIGNER_URL` is a non-secret pinned Worker endpoint.

The website may request only named owner/session/status operations. No deploy,
secret-edit, arbitrary Move target, arbitrary recipient or general transaction
signing endpoint is permitted. Knowledge of this invocation credential is not
authority to spend.

The isolated executor must independently verify the owner-signed permit, chain,
account ownership/delegation, exact committed decision and market mapping,
receiver, fee-inclusive amounts, atomic reservations, gas cap, pause/revocation,
nonce/replay state and session expiry before each signature and submission.
All execution state belongs to one authoritative SQLite ledger. PostgreSQL is
archival only and may not decide whether money is reserved or submitted.

Current implementation: presence checks are connected to the capabilities
endpoint and existing Agent blocker list. Invocation configuration validation is
implemented, but **no live invocation credential/client/executor is connected**.
Absence of known environment keys alone never returns “separation verified.”

## 4. Required verification receipt

Before continuing with funded delegate setup, retain sanitized evidence of:

- Shared, development and production administration-key absence, including the
  freshly published process, and connector privilege audit.
- Old credential revoked at Cloudflare; do not try a destructive deployment with
  an old credential as a test. Use provider token status and a non-mutating
  authenticated rejection where supported.
- Website invocation credential is not a recognized Cloudflare management token
  and has no deployment/secret-edit authority.
- Approved module uploaded from the separate operator environment; live build
  identity matches the reviewed release hash.
- Safe restart/rollback with preserved encrypted keys, ledger, uncertain
  reservations and transaction digests. Do not erase evidence to obtain a pass.
- Unsigned, modified, expired, wrong-wallet and arbitrary-transaction requests
  rejected independently inside the executor.

Without these receipts the separation remains **unverified**. The present
presence-only assessment is not a live production privilege test.

## 5. Rollback and credential recovery

Pause new execution first. Retain the previous reviewed artifact, its SHA256,
public version identity and storage schema compatibility record offline.
Rollback code only through the operator command; never delete the namespace,
overwrite the ledger with an old snapshot or release UNKNOWN reservations.
Reject incompatible schema rollback rather than attempting it.

Keep the signer's encryption/wrapping recovery material in the owner's protected
credential manager/offline encrypted backup, never in the website or repository.
Losing the invocation credential allows controlled rotation from the operator
environment. Losing the deployment token requires a replacement through
Cloudflare's secure account settings; it does not require a new delegate key.
Losing both wrapping material and its recovery copy can make encrypted delegate
keys unrecoverable. Do not claim successful recovery until tested.

## 6. Emergency pause and revocation

The final executor must provide independently owner-signed pause/revoke controls
and an operator break-glass pause that can stop new signatures/submissions without
destroying keys, ledger or pending transaction state. **These runtime controls are
not implemented yet; no autonomous trading is enabled.**

If the website is compromised, rotate/revoke invocation access through the
operator control plane, pause new execution in the Worker and revoke the on-chain
delegate using the Slush owner wallet. Owner wallet transactions require explicit
review/approval. Do not assume taking the website offline stops Cloudflare.
Continue digest/receipt, order/fill, position and claim reconciliation while
paused or expired. Already submitted transactions cannot be undone by a timer.

Delegate gas must be separately owner-approved; owner-wallet SUI is not available
to a delegate merely because the owner connected. The final design must expose
the SUI transfer, gas budget and restricted owner-only recovery path before
funding. No gas funding or recovery transaction is authorized by this runbook.

## Concrete next blockers

| Component | Implemented/connected | Required next action |
|---|---|---|
| Runtime administrative-key removal/rotation | Not applied | Owner secure-settings actions above, then independent verification |
| `operator-signer.mjs` | Tool implemented; no real executor artifact uploaded | Verify external operator access and deploy reviewed executor only when available |
| `control-plane.ts` → `/api/agent/capabilities` | Presence checks connected; actual isolation not verified | Fresh deployment/connector evidence, not an environment flag override |
| `AgentPage.tsx` / `routes.ts.authenticate` | Wallet-standard connection/account reads exist; auth uses PG | Verify actual Slush connection; move pilot's frequent operations off PG |
| `protocol.ts` / `order-adapter.ts` | Builders exist; real owned-account simulation not proven | Exact owned account, market mapping, permissions, fees, expiry and gas simulation |
| `execution-store.ts` | PG reservation foundations; no authoritative pilot SQLite port | Port transactional budget/nonce/intent recovery into one executor ledger |
| `worker.ts` | WOULD_HOLD observer only | Connect final commitment to durable intent, restricted signer, submission and digest reconciliation |

Do not request funds or authorize the mainnet test until these prerequisites are
ready. Then request approval for exactly one bounded delegated order, reconcile
it correctly, and separately request the two-hour session. Four-hour sessions
require their own reviewed budgets. No champion, profitability proof or daily
learning completion is a prerequisite for the explicitly experimental pilot.
