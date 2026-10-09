import type {websiteControlPlaneStatus} from "../../infrastructure/agent-signer/control-plane";
type ControlPlane=ReturnType<typeof websiteControlPlaneStatus>;
/** Implemented code is not a mainnet proof; all release gates stay fail closed. */
export function liveExecutionReadiness(control:ControlPlane){
  return {released:false,activeStrategy:"waterx-qualification-gates-v3",shadowStrategy:"waterx-event-lock-v1",
    ownerInteractions:["Connect Slush and sign the login challenge","Select or create the owned account",
      "Review, simulate and explicitly sign each funding, redemption, withdrawal or revocation operation",
      "Review finite session budgets","Approve independently verified restricted permissions when released"],
    autonomousWhenReleased:["Collect new observations","Evaluate the authorized active strategy",
      "Refresh and validate full-size quotes","Reserve aggregate wallet/session limits",
      "Submit within restricted authority","Reconcile uncertain results, fills and settlement","Pause on expiry or risk limits"],
    blocker:control.administrationCredentialPresent?"Website deployment authority is not isolated from signer administration.":
      "Isolated signer and effective restricted delegate permissions are not verified.",
    nextAction:control.administrationCredentialPresent?
      "The protected operator must remove website deployment credentials, revoke superseded authority, and verify deployment/recovery outside the website.":
      "Provision and independently verify the owner-approved isolated signer before granting trading permissions.",
    items:[
      {id:"control-plane",label:"Deployment administration isolated",status:"BLOCKED",
        evidence:control.state,nextAction:"Operator credential removal, provider revocation and protected deployment/recovery proof."},
      {id:"signer",label:"Isolated signer and restricted delegate",status:"UNVERIFIED",
        evidence:"No production invocation credential or effective permission proof is established.",
        nextAction:"Prove signer ownership plus denial of withdrawal and delegate-management outside the permit."},
      {id:"funding",label:"Owned account funding and credited balance",status:"IMPLEMENTED",
        evidence:"Owner-only account checks, native USDC conversion/redemption builders, checked simulation and exact-intent confirmation exist. No funded recovery or credited-balance proof yet.",
        nextAction:"Owner explicitly signs a reviewed bounded operation; verify the credited amount and recoverability on chain."},
      {id:"mapping",label:"Exact round, market and side",status:"IMPLEMENTED",
        evidence:"Order-intent identity and distinct YES/NO mapping checks exist; no owned-account production order proof.",
        nextAction:"Verify a current mainnet round/market/side mapping with protocol evidence."},
      {id:"quote",label:"Fresh full-size quote and enforced order limits",status:"UNVERIFIED",
        evidence:"Max-spend, min-shares, price-cap and expiry builders exist; no fee-inclusive executable quote is provided.",
        nextAction:"Verify full $5 quote, gas basis, partial-fill behavior and on-chain limit enforcement."},
      {id:"dispatch",label:"Final dispatch and aggregate reservations",status:"UNVERIFIED",
        evidence:"Reservation and final-signal components exist but production signer dispatch remains disconnected.",
        nextAction:"Connect only after signer isolation; test simultaneous wallet/session/round reservations."},
      {id:"submission",label:"Submission, uncertainty, fills and settlement",status:"UNVERIFIED",
        evidence:"Owner-setup confirmation exists; autonomous production submission/fill evidence is absent.",
        nextAction:"Prove UNKNOWN reconciliation without duplicate submission and verify actual fills/settlement."},
      {id:"recovery",label:"Pause, expiry, revocation and withdrawal recovery",status:"UNVERIFIED",
        evidence:"Pause and owner recovery builders exist; no end-to-end funded recovery proof.",
        nextAction:"Owner verifies stop/expiry, revoke and withdraw after the approved bounded pilot."},
      {id:"collector",label:"Browser-independent production operation",status:"BLOCKED",
        evidence:"Current published hosting is Autoscale; durable production collector activation is not proven.",
        nextAction:"Complete backup/restore evidence and approve recurring host/database costs before activation."},
    ]};
}
