/** Read-only funding and policy preview. Never a trading permission.
 * Exact eligibility still needs fresh WaterX credit, owned account proof,
 * quote/fees, signer gas, on-chain delegation and an explicit mainnet release.
 */
import {agentPolicySchema, type AgentPolicy} from "../../shared/agent-policy";
import {sizePosition, type Equity} from "./risk";

export type PilotBudgetPreview = {
  status: "UNFUNDED" | "PREFLIGHT_ONLY";
  availableCents: number;
  reserveCents: number;
  hypotheticalStakeCents: number;
  targetStakeCents: number;
  blockers: string[];
  orderAuthorized: false;
};

export function previewPilotBudget(balanceAtomic: string, policy: AgentPolicy): PilotBudgetPreview {
  const p=agentPolicySchema.parse(policy);
  if(!/^(0|[1-9]\d*)$/.test(balanceAtomic))throw new Error("Exact nonnegative WaterX USD atomic credit required");
  const credit=BigInt(balanceAtomic);
  if(credit>BigInt(Number.MAX_SAFE_INTEGER)*BigInt(10000))
    throw new Error("Credit exceeds safe preview range");
  // WaterX USD carries six decimals; exactly 10,000 atomic USD = 1 cent.
  // Fractional cents remain unspendable in a cent-based policy preview.
  const cents=Number(credit/BigInt(10000));
  const e:Equity={availableCents:cents,committedCents:0,startingCents:cents,
    dayStartingCents:cents,dayTurnoverCents:0,dayRealizedPnlCents:0,
    highWaterCents:cents,consecutiveLosses:0};
  const hypotheticalStakeCents=sizePosition(p,e);
  const blockers:string[]=[];
  if(cents===0)blockers.push("WATERX_ACCOUNT_CREDIT_ZERO");
  if(p.network!=="mainnet")blockers.push("MAINNET_POLICY_REQUIRED");
  if(hypotheticalStakeCents===0)blockers.push("NO_SPENDABLE_COLLATERAL_AFTER_POLICY_LIMITS");
  if(hypotheticalStakeCents<p.fixedCents&&p.sizingMode==="FIXED")
    blockers.push("FIXED_STAKE_REDUCED_BY_BALANCE_RESERVE_OR_LIMITS");
  if(p.sessionGasBudgetMist<=0)blockers.push("POSITIVE_RESTRICTED_SESSION_GAS_BUDGET_REQUIRED");
  blockers.push("LIVE_SIGNER_DELEGATION_QUOTE_FEES_AND_RELEASE_UNVERIFIED");
  return {status:cents===0?"UNFUNDED":"PREFLIGHT_ONLY",
    availableCents:cents,reserveCents:p.reserveCents,hypotheticalStakeCents,
    targetStakeCents:p.sizingMode==="FIXED"?p.fixedCents:hypotheticalStakeCents,
    blockers,orderAuthorized:false};
}
