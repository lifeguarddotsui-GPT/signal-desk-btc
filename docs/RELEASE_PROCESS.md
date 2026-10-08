# BlueWaterAI: low-cost GitHub-first release process

Status: **CI / release-evidence proposal, no production publishing configured.**

## Goals

- GitHub becomes the reviewed source of truth, not an automatic substitute for live Replit workspace state.
- ChatGPT/GitHub engineers implement code without Replit Agent usage.
- Every pull request is typechecked, tested, built, and linked to a source commit before release.
- Production publishing remains a *separate operator-approved operation* until a documented, authenticated, least-privilege deployment mechanism is verified.
- No production database, trading keys, Slush authorization, or environment secrets enter GitHub Actions.

## Repository / hosting reality

1. GitHub `main` contains a reviewed source-only snapshot, not necessarily the latest Replit workspace. Inspect and reconcile any newer Replit commits before merging or syncing.
2. The active app contains both server and client plus an optional leased WaterX collector; do not replace its deployment type or startup command from source assumptions.
3. The checked-in `edge/wrangler.toml` describes a limited 26-hour Cloudflare *trial*, not a validated always-on production ingestion process. Do not silently rely on it for round completeness.
4. GitHub Actions build evidence is **not** a production release, database backup, or a guarantee of continuous collectors.
5. A public repository's Actions logs and artifacts can be visible. Do not send credentials, private production exports, or database dumps to this pipeline.

## Phase A — first-time verification (once, no Replit Agent required)

1. In Replit, open BlueWaterAI **Tools → Git**. Check repository remotes and current branch. Compare its latest commit and uncommitted files to GitHub `main`.
2. Ensure every change currently running on bluewaterai.app has been copied or committed somewhere safe; reconcile newer Replit source *before* importing a GitHub branch. Do **not** hard-reset the live workspace.
3. Open **Publishing** and record (without credentials): published app type (Autoscale/Reserved VM), build command, run command, whether app and worker share a process, and whether production uses a separate database.
4. Confirm Replit's current **Republish** control updates the intended production app. If possible test first in a staging app.
5. Confirm a current full production-database backup exists, then verify restore to an isolated disposable database. Keep backup evidence and secrets out of GitHub.
6. For each change: require a passing GitHub CI check, reviewed diff, and a saved rollback source commit. Apply DB migrations only through separately reviewed, backup-verified procedures.
7. Prevent trading-state or wallet-signing changes from hitchhiking on unrelated data/chart changes.

## Phase B — GitHub changes without Replit Agent

1. Develop on a feature branch, not directly on `main`.
2. Open a pull request. `.github/workflows/ci.yml` runs `npm ci`, `npm run check`, `npm test`, `npm run build`, and `node scripts/release-evidence.mjs`.
3. Review the build evidence artifact: source Git SHA, build ID, schema version, policy version, and output checksums. A `deployStatus: NOT_DEPLOYED` marker prevents mistaking CI success for a live release.
4. Stop and fix any failing check. Do not merge or promote failing builds.
5. Merge only after the Replit workspace and source-of-truth divergence has been resolved and backward compatibility reviewed.

## Phase C — production publishing (current safe bridge)

1. Stop if a separate Replit workspace is ahead of the reviewed GitHub commit. Preserve its files/branch and reconcile first.
2. With Replit's Git tool or an operator-reviewed Git command, fetch the approved Git commit and ensure the workspace exactly matches that commit. Do not use `git reset --hard` to mask divergence.
3. Run the same CI checks in the Replit environment if its runtime or build configuration differs. Confirm `npm run build` succeeds.
4. Confirm the production database backup and restore evidence. If any schema change is involved, follow a separately reviewed migration plan; never run schema modifications from a GitHub CI job.
5. Use Replit **Publishing → Republish** (human confirmation). This step does not require prompting Replit Agent.
6. Inspect Replit publish logs. Verify the production build's public build ID / source commit against the GitHub CI evidence. Use `/api/health` and the WaterX-specific health routes, while respecting their documented scopes.
7. Check live desk, SSE chart, WaterX 5m and 15m capture, live round IDs, new settlement outcomes, and rollback readiness. A healthy HTTP status alone is insufficient.
8. If a regression occurs: return to the last known working source revision and republish; restore a database only when a separately reviewed database change actually requires it.

## Phase D — future automated publishing

A fully automatic GitHub-to-Replit publishing action is **NOT IMPLEMENTED** here. GitHub does not deploy to Replit merely because this workflow passes.

Only add a deployment job after verifying a supported and authenticated Replit deployment interface and proving that it selects a specific immutable Git SHA. Do not store a Replit login-session cookie in GitHub secrets or use undocumented private GraphQL operations as a deploy API. Do not store full production database URLs in GitHub Actions for chart-only deployments.

Preferred release safeguards:

- `workflow_dispatch` release only, single in-flight deployment (concurrency), dedicated `production` environment and required human review.
- Required passing CI checks, backed-up migration gate, least-privilege deploy token, no direct production database access unless absolutely necessary.
- SHA-pinned artifact, authenticated deployment status check, post-deploy functional smoke tests, rollback to prior release.
- No autonomous mainnet trading policy or signer changes without separate explicit owner authorization.

## Expected savings

Most iterations (UI, logic, tests, API parsing, chart durability, data-quality reports) can be developed on GitHub without consuming Replit Agent editing checkpoints. Replit hosting/storage/bandwidth and any required always-on worker remain separately billed. Review and publish steps may still be manual until a supported deployment bridge is available.
