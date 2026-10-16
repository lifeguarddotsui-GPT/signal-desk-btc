# Blue Water visitor-only collection: production release plan

Status: draft-only GitHub source. NOT deployed or merged.

## When WATERX_VISITOR_ONLY_MODE=true

- Server boot serves website/static and passive health/status WITHOUT initializing PostgreSQL or starting market collectors.
- React sends a same-origin browser POST heartbeat with a random session UUID only while the page is visible.
- First accepted visible visitor causes one shared database initialization and starts the WaterX/Coinbase/Two-Stage/learning collectors.
- While visible, each browser renews a **non-database** lease about every 15 seconds.
- Hidden/unloading pages relinquish leases and unmount dashboard data requests. Crashed/suspended browsers expire after 45 seconds. Every 5 seconds an in-memory sweep stops backend collectors and research timers when no leases remain.
- Without an active initialized visitor, regular /api endpoints respond 503 without PostgreSQL access. Health, static and visitor status remain available.
- No database migrations, existing-record deletions, secret changes or trading permissions.

## Honest limitations

- There will be no new prospective prediction capture, normal settlement checks or training while nobody is visiting. Past immutable history remains in PostgreSQL; absent rounds stay absent, never retroactively scored.
- This prevents autonomous agent trading when nobody is visiting. Presence does NOT authorize trading.
- Client presence is not proof of a human. Bots can imitate requests; add WAF/rate limits for cost abuse if needed.
- Replit Autoscale multiple replicas track presence separately. More than one replica, an external worker, Reserved VM, Cron or other database-consuming projects can continue background queries. This source change alone cannot stop services outside the web process.
- Pending asynchronous database work may still complete after an idle transition. Replit database sleep occurs only after the last query plus the provider's idle timeout.
- Stored PostgreSQL bytes still incur their own storage costs; the intended savings concern active compute hours.

## Owner-approved production steps

1. Establish the REAL currently published Replit source SHA, compare against the integration/replit-release-review-20261014 source base, and reconcile Replit-only changes. Branch code is not proof of current production parity.
2. Verify production database backup and recovery, including immutable prediction and settlement records; never paste credentials into chat.
3. Ensure all external collectors and scheduled DB users are stopped or deliberately excluded. WATERX_EXTERNAL_COLLECTOR=true and visitor-only mode are incompatible unless the external worker is stopped; setting a web env variable alone cannot disable it.
4. Require GitHub CI npm ci, npm run check, npm test, npm run build. Validate zero/one/multiple viewers, mobile background/foreground, 5m/15m lock quality, graceful expiry, uninterrupted existing historic rows.
5. On explicit user approval only: deploy exact tested SHA, enable WATERX_VISITOR_ONLY_MODE=true in the production deployment environment; do not activate paid tiers or automatic deploy.
6. Compare Replit Per project / Blue Water Agents / Storage: actual Production Database Compute hours and charge; wait at least several minutes after all tabs close. Confirm visitor-status indicates zero leases while passive uptime checks do not reawaken DB.
7. Next visit should start live capture again. Mark gaps as NO OBSERVATION, not wrong trades or predictions; verify pending actual settlements are retried with original evidence.
8. Rollback: set WATERX_VISITOR_ONLY_MODE=false and publish previous approved revision. This intentionally restores around-the-clock DB work and likely higher costs.

No merging, deploying, database removal, schema modifications, wallet signing, or production changes are authorized by this document.