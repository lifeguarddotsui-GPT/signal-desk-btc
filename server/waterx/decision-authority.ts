import {randomUUID} from "node:crypto";
export const decisionClockDomain=`application-process:${randomUUID()}`;
let workerLeaseOwned=false;
/** When an external collector is configured, the website is read-only for
 * decision scheduling. Only the existing PostgreSQL-leased worker may write. */
export const decisionWriterAllowed=()=>process.env.WATERX_EXTERNAL_COLLECTOR!=="true"||workerLeaseOwned;
export function setDecisionWorkerLease(owned:boolean){workerLeaseOwned=owned;}
