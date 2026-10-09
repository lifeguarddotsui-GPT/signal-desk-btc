/** Final missing-decision classification is not the historical incident flag.
 * No observed cause may be inferred merely from a process disappearing. */
export type StageCaptureCause = "NO_QUALIFIED_SIGNAL" | "SOURCE_STALE" | "MISSED_GATE" |
  "DATABASE_FAILURE" | "SCHEDULER_FAILURE" | "SERVICE_INTERRUPTED" | "NO_VALID_INPUT" |
  "OBSERVING" | "RECORDED" | "UNCLASSIFIED";
export function stageCaptureCause(reason: string, expired: boolean, saved = false): StageCaptureCause {
  if (saved) return "RECORDED";
  if (!expired) return "OBSERVING";
  if (/IDENTITY_MISMATCH|NO_VALID_INPUT|NO_VALID_PROBABILITY|DATA_UNAVAILABLE/.test(reason)) return "NO_VALID_INPUT";
  if (/DATABASE|UNKNOWN.*COMMIT/.test(reason)) return "DATABASE_FAILURE";
  if (/SCHEDULER/.test(reason)) return "SCHEDULER_FAILURE";
  if (/MISSED_GATE/.test(reason)) return "MISSED_GATE";
  if (/SERVICE_INTERRUPTED/.test(reason)) return "SERVICE_INTERRUPTED";
  if (/MISSING.*ASSESSMENT|RECOVERY/.test(reason)) return "UNCLASSIFIED";
  if (/SOURCE_STALE|FRESH_DATA/.test(reason)) return "SOURCE_STALE";
  if (/POLICY_NOT_QUALIFIED|ABSTAIN|BELOW_POLICY|PERSISTENCE_INCOMPLETE|STABILITY_WINDOW|ADDITIONAL_EVIDENCE|NO_QUALIFYING|CALIBRATED_DIRECTION_CONFLICT|NO_QUALIFIED/.test(reason))
    return expired ? "NO_QUALIFIED_SIGNAL" : "OBSERVING";
  if (/INSUFFICIENT_PRICE_COVERAGE/.test(reason)) return "NO_VALID_INPUT";
  return expired ? "UNCLASSIFIED" : "OBSERVING";
}
