/**
 * Independent, read-only-chain submission reconciliation.
 *
 * A successful Sui transaction proves only transaction finality. It DOES NOT
 * prove that a prediction order filled, at what price, or that it won.
 * No missing/failed/unavailable receipt releases any reserved collateral.
 * No signer, order submitter, wallet secret or website session is imported.
 */
import type { Pool } from "pg";
import { agentPool } from "./store";
import { MAINNET_IDENTITY, rpc } from "./protocol";

export type PendingExecution = {
  id: string;
  owner: string;
  transaction_digest: string;
  status: string;
};
export type FinalityObservation =
  | { kind: "FINAL_SUCCESS"; digest: string; chain: string; sender: string }
  | { kind: "INDETERMINATE"; reason: string };

export type SubmissionReconciliationResult = {
  inspected: number; accepted: number; held: number; failures: number;
};

/** Returns null for all uncertainties, including a finalized failed transaction:
 * failed gas effects and refund semantics require separate accounting.
 */
export function verifiedSuccessProof(
  pending: PendingExecution, observation: FinalityObservation, expectedChain = MAINNET_IDENTITY.chainIdentifier,
): { kind: "SUI_TRANSACTION_SUCCESS_ONLY"; digest: string; network: "sui:mainnet"; sender: string } | null {
  if (pending.status !== "UNKNOWN" ||
      !/^[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(pending.transaction_digest) ||
      !/^0x[0-9a-f]{64}$/i.test(pending.owner) ||
      observation.kind !== "FINAL_SUCCESS" ||
      observation.digest !== pending.transaction_digest ||
      observation.chain !== expectedChain ||
      !/^0x[0-9a-f]{64}$/i.test(observation.sender)) return null;
  return { kind: "SUI_TRANSACTION_SUCCESS_ONLY", digest: observation.digest,
    network: "sui:mainnet", sender: observation.sender };
}

/** Adapter reports final success only after checking the pinned network and
 * finalized Sui transaction effects for the EXACT reserved digest.
 * A tx sender may be a restricted delegate, not the WaterX account owner.
 * Restricted order intent was validated when the digest was reserved; this
 * receipt alone must never promote an order to FILLED.
 */
export async function lookupFinalizedMainnetSubmission(pending: PendingExecution): Promise<FinalityObservation> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(pending.transaction_digest))
    return { kind: "INDETERMINATE", reason: "INVALID_STORED_DIGEST" };
  try {
    const chain = await rpc.core.getChainIdentifier();
    if (chain.chainIdentifier !== MAINNET_IDENTITY.chainIdentifier)
      return { kind: "INDETERMINATE", reason: "WRONG_CHAIN" };
    const result = await rpc.core.getTransaction({
      digest: pending.transaction_digest, include: { transaction: true, effects: true, events: true },
    });
    if (result.$kind !== "Transaction" || !result.Transaction.transaction ||
        result.Transaction.status.success !== true)
      return { kind: "INDETERMINATE", reason: "NOT_VERIFIED_SUCCESS" };
    const sender = result.Transaction.transaction.sender;
    if (typeof sender !== "string")
      return { kind: "INDETERMINATE", reason: "MISSING_SENDER" };
    return { kind: "FINAL_SUCCESS", digest: pending.transaction_digest,
      chain: chain.chainIdentifier, sender };
  } catch {
    // Includes RPC timeouts and temporary transaction-index lag.
    return { kind: "INDETERMINATE", reason: "RPC_UNAVAILABLE" };
  }
}

/** One bounded pass; usable by an independent cron/worker. It does not submit,
 * retry, claim, release collateral or alter trading authorization.
 * Conditional UPDATE provides concurrency safety with a competing observer.
 */
export async function reconcileUnknownSubmissions(
  db: Pick<Pool, "query"> = agentPool,
  observe: (intent: PendingExecution) => Promise<FinalityObservation> = lookupFinalizedMainnetSubmission,
): Promise<SubmissionReconciliationResult> {
  const result: SubmissionReconciliationResult = { inspected: 0, accepted: 0, held: 0, failures: 0 };
  const pending = await db.query(`SELECT id, owner, transaction_digest, status
    FROM bluewater_execution_intents
    WHERE status='UNKNOWN' AND transaction_digest IS NOT NULL
    ORDER BY updated_at, id LIMIT 25`);
  for (const raw of pending.rows) {
    const item = raw as PendingExecution;
    result.inspected++;
    try {
      const observation = await observe(item);
      const proof = verifiedSuccessProof(item, observation);
      if (!proof) { result.held++; continue; }
      const updated = await db.query(`UPDATE bluewater_execution_intents
        SET status='ACCEPTED',
            proof=jsonb_set(COALESCE(proof, '{}'::jsonb), '{submissionFinality}', $4::jsonb, true),
            updated_at=clock_timestamp()
        WHERE id=$1 AND owner=$2 AND transaction_digest=$3 AND status='UNKNOWN'
        RETURNING id`, [item.id, item.owner, item.transaction_digest, JSON.stringify(proof)]);
      if (updated.rowCount === 1) result.accepted++;
      else result.held++; // A concurrent update or pause must not be overwritten.
    } catch {
      result.failures++; // Never turn a transient problem into a zero-spend proof.
    }
  }
  return result;
}
