/** Resolve the remote DATABASE_URL from the supported env vars (priority order). */
export function resolveCloudDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    env.HASNA_RECORDINGS_DATABASE_URL ||
    env.RECORDINGS_DATABASE_URL ||
    env.DATABASE_URL ||
    undefined
  );
}

/** Resolve the HMAC signing secret used to verify API keys. */
export function resolveSigningSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    env.HASNA_RECORDINGS_API_SIGNING_KEY ||
    env.HASNA_API_SIGNING_KEY ||
    env.API_KEY_SIGNING_SECRET ||
    undefined
  );
}

/** Validate auth configuration without opening a database connection or exposing the secret. */
export function requireSigningSecret(env: NodeJS.ProcessEnv = process.env): string {
  const signingSecret = resolveSigningSecret(env);
  if (!signingSecret) {
    throw new Error(
      "Cloud /v1 auth requires a signing secret (HASNA_RECORDINGS_API_SIGNING_KEY / HASNA_API_SIGNING_KEY / API_KEY_SIGNING_SECRET).",
    );
  }
  if (Buffer.byteLength(signingSecret, "utf8") < 16) {
    throw new Error("Cloud /v1 auth signing secret must be at least 16 bytes.");
  }
  return signingSecret;
}

/** True when this process is configured to serve the cloud `/v1` API. */
export function isCloudModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = (env.HASNA_RECORDINGS_STORAGE_MODE || env.RECORDINGS_STORAGE_MODE || "").toLowerCase();
  if (mode === "remote" || mode === "hybrid") return true;
  return Boolean(resolveCloudDatabaseUrl(env));
}
