import {randomUUID} from "node:crypto";
import {buildInfo} from "../btc/build-info";
export const decisionClockDomain=`application-process:${randomUUID()}`;
export const decisionDeploymentId=buildInfo().id??(process.env.NODE_ENV==="production"?"unknown":"development-unpackaged");
let workerLeaseOwned=false;
/** When an external collector is configured, the website is read-only for
 * decision scheduling. Only the existing PostgreSQL-leased worker may write. */
export const decisionWriterAllowed=()=>process.env.WATERX_EXTERNAL_COLLECTOR!=="true"||workerLeaseOwned;
export function setDecisionWorkerLease(owned:boolean){workerLeaseOwned=owned;}
