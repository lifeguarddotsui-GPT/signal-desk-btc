import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { policyProposals, researchSnapshots } from "../../shared/schema";

export const researchProposalInput = {
  proposedVersion: "string",
  summary: "string",
  changes: "array",
  evidenceSnapshotId: "string",
  expiresAt: "string",
} as const;

export async function latestResearchSnapshot() {
  try {
    const [snapshot] = await db.select().from(researchSnapshots)
      .orderBy(desc(researchSnapshots.capturedAt)).limit(1);
    return snapshot ?? null;
  } catch {
    return null;
  }
}

export async function saveResearchProposal(input: {
  id: string;
  idempotencyKey: string;
  proposedVersion: string;
  summary: string;
  changes: readonly string[];
  evidenceSnapshotId: string;
  expiresAt: string;
}) {
  const [existing] = await db.select().from(policyProposals)
    .where(eq(policyProposals.idempotencyKey, input.idempotencyKey)).limit(1);
  if (existing) return existing;
  const [proposal] = await db.insert(policyProposals).values({
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    proposedVersion: input.proposedVersion,
    proposal: {
      summary: input.summary,
      changes: input.changes,
      evidenceSnapshotId: input.evidenceSnapshotId,
      expiresAt: input.expiresAt,
    },
  }).onConflictDoNothing({ target: policyProposals.idempotencyKey }).returning();
  if (proposal) return proposal;
  const [concurrent] = await db.select().from(policyProposals)
    .where(eq(policyProposals.idempotencyKey, input.idempotencyKey)).limit(1);
  if (!concurrent) throw new Error("Proposal insert did not produce a row");
  return concurrent;
}