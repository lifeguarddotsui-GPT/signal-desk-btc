// An accidental-use guard, NOT the credential-isolation security boundary.
// Actual isolation is absence of administration credentials in every web runtime.
export function assertOperatorEnvironment(env) {
  if (env.REPL_ID || env.REPLIT_DEPLOYMENT || env.REPLIT_DEV_DOMAIN ||
      env.REPLIT_CONNECTORS_HOSTNAME || env.BLUEWATER_PUBLIC_WEB_RUNTIME)
    throw new Error("Use the owner-controlled administrative terminal outside Replit web/development runtimes.");
  if (env.BLUEWATER_OPERATOR_CONTEXT !== "owner-admin")
    throw new Error("Explicit owner-admin context is required.");
  if (!env.BLUEWATER_OPERATOR_DEPLOY_TOKEN)
    throw new Error("Load the scoped deployment token from your local credential manager; never pass it as a command argument.");
}

export function validateOperatorArtifact(manifest, bytes, approvedSha256, actualSha256) {
  if (manifest.script !== "bluewater-single-wallet-executor" ||
      !/^[a-f0-9]{64}$/.test(approvedSha256 ?? "") ||
      manifest.sha256 !== approvedSha256 || actualSha256 !== approvedSha256 ||
      manifest.file !== "executor.mjs" || !bytes.length)
    throw new Error("Only the exact owner-reviewed pilot artifact is deployable.");
  if (manifest.storageMigration || manifest.deleteNamespace || manifest.activatePaid)
    throw new Error("Storage migration, namespace deletion and paid activation are not authorized.");
}
