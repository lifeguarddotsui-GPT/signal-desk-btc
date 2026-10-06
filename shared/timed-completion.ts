/** Operational delivery policy, separate from prediction qualification.
 * Initial observations: production ACK minus evaluation, 2026-10-05:
 * 5m p95=2903ms/n=17; 15m p95=746ms/n=5. These exclude queue/acquisition.
 * Rounded upward with 2000ms explicit provisional scheduling/acquisition allowance.
 * This is not a verified safe cutoff, nor a promise under outages.
 */
export function timedCompletionPolicy(interval:5|15) {
  return {version:"early-completion-v3",allowanceMs:interval===5?5000:3000,
    basis:"observed evaluation-to-ACK tail plus provisional pilot scheduling buffer",
    measuredP95Ms:interval===5?2903:746,measuredN:interval===5?17:5,
    verifiedSafeCutoff:false,extraSafetyMs:2000};
}
