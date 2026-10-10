import type {AgentPolicy} from "./agent-policy";

export type PilotCheck={id:string;status:"PASS"|"BLOCKED"|"UNVERIFIED";detail:string};
export type PilotPreflightInput={
  policy:AgentPolicy;nowMs:number;ownerSessionExpiresAtMs:number|null;
  accountId:string|null;accountBalanceAtomic:string|null;accountBalanceReadAtMs:number|null;
  controlPlaneIsolated:boolean;onChainDelegateVerified:boolean;
  signerProvisioned:boolean;executableQuoteVerified:boolean;
  continuouslyLeasedWorkerVerified:boolean;releaseApproved:boolean;
};
const cents=(atomic:string|null):number|null=>{
  if(typeof atomic!=="string"||!/^\d{1,32}$/.test(atomic))return null;
  const n=BigInt(atomic)/BigInt(10000); // WaterX USD credit is six decimals, 1 cent is 10,000 atomic units
  return n<=BigInt(Number.MAX_SAFE_INTEGER)?Number(n):null;
};
/** Inspection only: no order sizing can authorize an on-chain spend.
 * Every enabled pilot still requires immutable signed owner permit,
 * fee-inclusive executable quote, simulation, reservation and signer checks.
 */
export function assessMainnetPilot(input:PilotPreflightInput){
  const p=input.policy,availableCents=cents(input.accountBalanceAtomic);
  const cap=Math.min(p.roundCollateralCents,p.maxOrderCents??Number.MAX_SAFE_INTEGER,
    p.maxUnresolved.mode==="AMOUNT"?p.maxUnresolved.value:Number.MAX_SAFE_INTEGER);
  const basis=p.sizingMode==="FIXED"?p.fixedCents:p.sizingMode==="ALLOCATION_PERCENT"?
    Math.floor(p.allocationCents*p.sizingPercent/100):
    availableCents==null?null:Math.floor(availableCents*p.sizingPercent/100);
  const draftStake=availableCents==null||basis==null?null:
    Math.max(0,Math.floor(Math.min(cap,basis,availableCents-p.reserveCents,
      p.dailyTurnoverCents??Number.MAX_SAFE_INTEGER)));
  const checks:PilotCheck[]=[];
  const add=(id:string,ok:boolean,detail:string,status:PilotCheck["status"]="BLOCKED")=>
    checks.push({id,status:ok?"PASS":status,detail});
  add("owner-session",input.ownerSessionExpiresAtMs!==null&&input.ownerSessionExpiresAtMs>input.nowMs+60000,
    "A signed owner session valid for at least another minute is required.");
  add("account-selected",!!input.accountId,"Select a verified, owner-controlled WaterX mainnet account.");
  add("account-credit-read",availableCents!==null&&input.accountBalanceReadAtMs!==null&&
    input.nowMs-input.accountBalanceReadAtMs>=0&&input.nowMs-input.accountBalanceReadAtMs<=30000,
    "A fresh verified WaterX USD credit read is required; wallet USDC is a different asset.","UNVERIFIED");
  add("positive-executable-stake",draftStake!==null&&draftStake>0,
    "Policy, reserve, fixed/percentage sizing and turnover limits must leave a positive proposed order.");
  add("pilot-cap",draftStake!==null&&draftStake<=500&&p.roundCollateralCents<=500,
    "Initial pilot must be capped at $5 all-in per round (including fees).");
  add("strategy",p.network==="mainnet"&&p.signalSource==="EXPERIMENTAL_QUALIFICATION_GATES"&&
    p.intervals.includes(5)&&!p.compound,
    "Current final-signal adapter accepts only separately consented V3 5-minute experimental decisions, not unqualified Bluewater champion probabilities.");
  add("session-gas-budget",p.sessionGasBudgetMist>0&&p.sessionGasBudgetMist<=500_000_000,
    "Owner must approve a positive bounded SUI gas budget; current defaults may be zero.");
  add("control-plane-isolation",input.controlPlaneIsolated,
    "Website administration must be separated from isolated signing authority.","UNVERIFIED");
  add("on-chain-delegate",input.onChainDelegateVerified,
    "Verify effective PLACE_ORDER permission and prove WITHDRAW and delegate-management are denied.","UNVERIFIED");
  add("signer",input.signerProvisioned,"Provision and independently verify restricted signer with protected keys.","UNVERIFIED");
  add("executable-quote",input.executableQuoteVerified,
    "Verify full stake, fees, market identity, price cap, min shares, expiry and simulate.","UNVERIFIED");
  add("independent-worker",input.continuouslyLeasedWorkerVerified,
    "Agent cannot depend on browser-woken Autoscale timers.","UNVERIFIED");
  add("release-authority",input.releaseApproved,
    "Explicit owner-approved one-order mainnet release and kill-switch rehearsal are required.");
  return {mode:"READ_ONLY_PREVIEW" as const,ready:checks.every(x=>x.status==="PASS"),
    canSign:false as const,canSubmit:false as const,plannedStakeCents:draftStake,
    observedAvailableCents:availableCents,allInMaximumCents:500,checks,
    note:"A preflight report does not grant delegation, authorize a transaction, or release real-money execution."};
}
