import pg from "pg";
import type { PoolClient } from "pg";
import { defaultAgentPolicy, agentPolicySchema, policySummary, type AgentPolicy } from "../../shared/agent-policy";
export const agentPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000 });
export const blockers = [
  "Isolated encrypted mainnet signer service is not provisioned.",
  "Production final-decision dispatch, wallet-wide reservations and UNKNOWN reconciliation are not connected.",
  "Order limits can be built, but fee-inclusive economics and permission simulations have not been verified with an owned account.",
  "Restricted delegate authorization, withdrawal/delegate-management denial and revocation require mainnet verification.",
  "Browser-independent production worker is not activated; current publication uses Autoscale.",
  "Auto claim unavailable pending explicit claim-permission and contract verification.",
];
export async function ledger(c: PoolClient, owner: string, event: string, version: number, details: unknown, roundKey: string | null = null) {
  await c.query("INSERT INTO bluewater_agent_ledger(owner,event,policy_version,round_key,details) VALUES($1,$2,$3,$4,$5)", [owner,event,version,roundKey,JSON.stringify(details)]);
}
export async function agentTransaction<T>(owner: string, run: (c: PoolClient, row: Record<string, any>) => Promise<T>): Promise<T> {
  const c = await agentPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("INSERT INTO bluewater_agents(owner,policy) VALUES($1,$2) ON CONFLICT DO NOTHING", [owner,JSON.stringify(defaultAgentPolicy)]);
    await c.query("INSERT INTO bluewater_agent_policies(owner,version,policy) SELECT owner,policy_version,policy FROM bluewater_agents WHERE owner=$1 ON CONFLICT DO NOTHING", [owner]);
    const row = (await c.query("SELECT * FROM bluewater_agents WHERE owner=$1 FOR UPDATE", [owner])).rows[0];
    const result = await run(c,row);
    await c.query("COMMIT"); return result;
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}
export async function readAgent(owner: string, sessionExpiresAtMs: number | null = null) {
  const row = (await agentPool.query("SELECT * FROM bluewater_agents WHERE owner=$1", [owner])).rows[0];
  if (!row) throw new Error("Authenticated agent is missing");
  const events = (await agentPool.query("SELECT id,event,at,details FROM bluewater_agent_ledger WHERE owner=$1 ORDER BY id DESC LIMIT 100", [owner])).rows;
  const policy=agentPolicySchema.parse(row.policy);
  return {owner,policy,policyVersion:Number(row.policy_version),status:row.status,
    accountId:row.account_id,delegateAddress:row.delegate_address,delegateExpiresAtMs:row.delegate_expires_at_ms == null ? null : Number(row.delegate_expires_at_ms),
    paper:row.paper,ledger:events,summary:policySummary(policy),blockers,balances:null,
    network:"mainnet",mainnetEnabled:false,signingSessionActive:false,
    policyAcceptanceRequired:row.policy?.network!=="mainnet",
    combinedOpenExposureCents:null,exposureVerification:"UNAVAILABLE",
    walletSessionExpiresAtMs:sessionExpiresAtMs};
}