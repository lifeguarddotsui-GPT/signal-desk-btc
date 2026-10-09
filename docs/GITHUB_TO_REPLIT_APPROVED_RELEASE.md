# Blue Water GitHub → Replit controlled release procedure

**State:** setup documentation only. No release is authorized by this file or its GitHub PR.

## Source of truth

Production currently reports build source commit `09c0f4c74d9fac5da03946cb1b1a21bd57d7b8fe` (Oct 8). That Git commit was not present in the connected repository. A pinned, already-public source archive was imported into the isolated `sync/production-source-20261009` GitHub branch. V4 is proposed in the separate `feature/v4-event-confirmation-shadow-20261009` branch, PR #6.

**Never merge historical main into deployed source or perform a force-push/reset of the Replit workspace.** Reconcile source and Replit's Git state first, then choose a single canonical protected production branch.

## One-time Replit linking, with human involvement

1. Inside the **existing bluewaterai.app** Replit project, open Tools → Git. Confirm whether Git is already initialized, show the current branch, commit hash, and origin URL **without exposing secrets**. Do not click any reset/overwrite button.
2. Confirm the GitHub origin is `lifeguarddotsui-GPT/signal-desk-btc` and Replit's worktree has no uncommitted changes. If origin differs or there are local changes, STOP. Save a new backup/branch in Replit first.
3. Confirm the production DB backup and tested restore path. Development and production DBs can differ; never paste production connection strings in chat.
4. After a tested PR is approved and merged into an explicitly selected **canonical release branch**, use Git pane → Fetch/Pull from GitHub (or, after verifying its origin and clean tree, Shell `git fetch origin` and `git merge --ff-only origin/<canonical-release-branch>`). Never run `git reset --hard` or `git push --force`.
5. Compare Replit worktree commit SHA to the approved GitHub SHA. Run `npm ci --no-audit --no-fund` and `npm run build`. CI should already have passed typecheck and tests, minimizing expensive Replit Agent usage.
6. Publish from the existing Replit app only after the owner explicitly approves the **specific source SHA** and the backup/rollback checks. Verify `GET /api/waterx/version` reports the expected source commit and build ID. A successful GitHub merge does **not** automatically change Replit production.
7. Initial publishing should keep `WATERX_V4_SHADOW_ENABLED` **unset or false**. Confirm V3 locks, chart, history, and learning continue normally. A later separate owner-approved shadow toggle can collect prospective V4 evidence.
8. Compare both intervals' V3/V4 prospective locked/abstained/missing coverage, latency, and verified correct/incorrect. V4 is not a proven replacement for V3 before a monitored trial. Mainnet trading stays off.

## GitHub release controls

- GitHub CI on PRs: `npm ci`, `npm run check`, `npm test`, `npm run build`.
- The protected release branch should require approved PR review, passing CI, no force pushes and no direct pushes. This requires repository administrative settings, which the connected GitHub app may not be authorized to edit.
- A production GitHub environment should require a manual reviewer and use immutable commit SHA, not mutable branch HEAD.
- Avoid third-party webhook daemons that can overwrite Replit workspace state. GitHub Actions deployment secrets/credentials should only be configured after validating an **official supported authenticated Replit publishing interface**, not assumed.
- There is **no supported unattended Replit publication connection configured here**. The initial safe bridge is one-time GitHub sync followed by an authorized Replit Publish action. After the user's Replit Git pane is verified, CI-to-production automation can be investigated separately.
- Cheap update cycle: ChatGPT changes source with GitHub PR → GitHub's included CI runs tests/build → user approves → Replit Git pull of exact reviewed commit → user publishes, with build ID verified.

## V4 rollout gate

**Do not consider V4 for live production until:**
- [ ] GitHub V4 PR passes all CI tests and build.
- [ ] Production backup is checked via a tested restore, and rollback to the prior published build is documented.
- [ ] Replit existing workspace is verified as compatible with GitHub sync (no unsaved changes).
- [ ] Owner explicitly approves deploying V4 **with flag OFF** to existing Replit app.
- [ ] Existing V3, Event V1, and Two Stage V2 exhibit no regression after first publish.
- [ ] Owner separately approves V4 shadow flag ON, and watches actual 5m/15m cohorts.
- [ ] Both intervals have sufficient verified prospective outcomes and no worse source/lock health or costs. Re-examine model risk, calibration, and timing before any promotion.
- [ ] An explicit owner-approved production SHA and rollback instructions are ready.

**No production deletion, backfill of decision direction, retroactive V4 locks, unreviewed autonomous execution, or hosting paid-tier upgrade.**
