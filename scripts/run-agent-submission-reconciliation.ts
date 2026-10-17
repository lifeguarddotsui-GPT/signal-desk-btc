/** Independent one-pass transaction finality reconciliation.
 * Run from a separately operated process/cron, never a browser request.
 * No signing, trading, order submission, wallet delegation, or custody actions.
 * This file is NOT wired into production startup.
 */
import { agentPool } from "../server/agent/store";
import { reconcileUnknownSubmissions } from "../server/agent/submission-reconciliation";

async function main() {
  if (process.env.BLUEWATER_RECONCILE_MODE !== "submission-finality-only")
    throw new Error("Reconciliation is not enabled. Set explicit receipt-only mode.");
  if (!process.env.DATABASE_URL)
    throw new Error("Database access unavailable; no execution state changed.");
  const result = await reconcileUnknownSubmissions();
  console.log(JSON.stringify({ mode: "SUBMISSION_FINALITY_ONLY", ...result,
    fundedTradingEnabled: false, ordersSubmitted: 0, fillsClaimed: 0 }));
}
main().catch(() => { console.error("Agent submission reconciliation unavailable; reservations remain locked."); process.exitCode = 1; })
  .finally(async () => { await agentPool.end(); });
