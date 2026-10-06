/** Presence-only checks. Never return credential values or treat this check as
 * proof that managed connectors/deployment configuration are also isolated. */
export const deploymentCredentialNames = [
  "CLOUDFLARE_API_KEY", "CLOUDFLARE_API_TOKEN", "CF_API_KEY", "CF_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_API_TOKEN", "WRANGLER_API_TOKEN",
  "BLUEWATER_OPERATOR_DEPLOY_TOKEN",
] as const;

export function websiteControlPlaneStatus(env: Record<string, string | undefined>) {
  const administrationCredentialPresent = deploymentCredentialNames.some(name => !!env[name]?.trim());
  return {
    administrationCredentialPresent,
    state: administrationCredentialPresent
      ? "UNSAFE_DEPLOYMENT_AUTHORITY_PRESENT"
      : "DIRECT_CREDENTIALS_ABSENT_EXTERNAL_VERIFICATION_REQUIRED",
    separationVerified: false,
    fundedSigningAllowed: false,
    requiredVerification: [
      "Editor, shared, production and managed connector privilege removal",
      "Superseded credential revocation at Cloudflare",
      "Fresh production process and no-admin negative check",
      "Successful protected operator deployment and recovery",
    ],
  };
}

export function assertWebsiteInvocationEnvironment(env: Record<string, string | undefined>) {
  if (websiteControlPlaneStatus(env).administrationCredentialPresent)
    throw new Error("Signer invocation blocked: website still has deployment authority.");
  if (!env.AGENT_SIGNER_INVOKE_TOKEN || env.AGENT_SIGNER_INVOKE_TOKEN.length < 32)
    throw new Error("Dedicated signer invocation credential unavailable.");
  const url = new URL(env.AGENT_SIGNER_URL ?? "");
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.search || url.hash || !["", "/"].includes(url.pathname) ||
      !/^bluewater-single-wallet-executor\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname))
    throw new Error("Pinned Cloudflare pilot signer URL required.");
  return url.origin;
}
