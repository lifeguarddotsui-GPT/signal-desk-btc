# 2026-10-16 Replit Cost Review: Blue Water Agents

## Grounded billing observations
The owner closed all Blue Water AI website sessions for the planned approximately 11:00–12:00 Belize time idle window. Replit Usage (per-project Blue Water Agents) displayed **125.93 h Production database compute**, at **$0.16/hour** before and after the one-hour test, and **$20.15** cumulative in both views. This is good evidence that the visitor-only collector allows database autosuspend, but usage figures are rounded and potentially delayed. Check again after billing data reconciliation before concluding the database is always asleep.

Latest Replit Blue Water project usage:
- $46.50 total resource usage in period.
- AI $21.45; Agent $21.44, integrations $0, Tools $0.02 (display rounding may account for small mismatch).
- Storage $20.15, entirely charged to Production database compute in the visible detailed resource category. Logical DB storage 0.87 GiB-month shows $0 after allowance in screenshot, not a reason to delete history.
- Project hosting $3.90.
- Project traffic & data $1.00.
- Initial reading within approximately the same test period showed $46.35 total and $3.81 hosting. The $0.15 increase is not extra DB compute or Agent usage; approximately $0.09 is additional hosting, and the remainder is traffic/data given the visible totals.
- A different Replit project, **Belize Fleet Monitor**, shows a separate cumulative $27.15 resource usage, which is not a Blue Water storage charge and deserves its own review.

## Immediate operational priorities
1. **Do not use Replit Agent for routine code fixes.** More than $21 in this period is AI Agent usage, not a background prediction-model API fee. Use GitHub branches, CI, approvals and one-click Replit publishing after controlled sync. Avoid buying additional Power/Max-mode credits.
2. Leave `WATERX_VISITOR_ONLY_MODE=true`. Test passive `/api/visitor/status` with only the status page open, without visiting the full dashboard. Confirm zero active visitors and database compute stays flat after lag.
3. Replit Autoscale was previously shown with two vCPUs, four GiB RAM, and a maximum of three machines; a newer screenshot truncates the label at Autoscale (4 v...). Confirm the actual setting. **Recommend a single maximum machine first**, because the current collector/lease is process-local and multiple instances could duplicate DB capture. Then reduce CPU/memory one tier at a time after checking real latency, chart continuity, and 5/15m lock scoring. Multi-user scaling will need a lease-coordinated collector architecture before restoring >1 replica.
4. Do not disable production DB backups or point-in-time recovery, reset the database, clear historic prediction data, or trade accuracy for cheaper sampling.
5. Set Replit usage budget alerts/hard caps appropriately; disabling auto-reload can interrupt public app availability when credits run out.
6. Track *daily incremental* usage by category, rather than historical cumulative total. No automated balance fetch is available from the connected Replit tool.

## Code improvements prepared, NOT deployed
- Run retrospective research reconciliation/scoring/report maintenance every 60s while viewers are active instead of every 15s. At most 60 instead of 240 scheduled cycles per hour (75% fewer scheduled passes). Instant catch-up occurs on visitor wake; 5m/15m WaterX polls, early/confirmation decisions, Coinbase stream and 30-second gates are untouched. Some historical status updates can lag up to 60s.
- Pause the Coinbase comparison chart archive's failed-write retry timer whenever the last visitor leaves. Existing in-flight writes complete normally. Bounded unsaved ticks stay in memory while the process is alive and resume on visitor return; autoscale recycling may still lose pending *uncommitted* in-memory ticks. Durable database rows are never deleted.
- CI requires all visitor, chart, prediction and full-suite tests, plus PostgreSQL integration. No new DB migration, paid tier, or continuous worker.
- **Important:** Fewer maintenance queries do not directly guarantee lower database compute-hour charges while a viewer is online. The main savings derive from periods when the database becomes inactive.

Do not publish this branch without user authorization.
