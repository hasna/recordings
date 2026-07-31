// Server-side data-backend configuration for `recordings-serve`.
//
// The server has exactly TWO internal storage backends: `sqlite` (an on-box
// file) and `postgresql` (the shared dataset). Deployment modes
// (`local | self_hosted | cloud | remote | hybrid`) are removed — where the
// server runs and who operates it never selected a backend, it only looked like
// it did. See src/lib/retired-deployment-modes.ts.

import {
  asRetiredDeploymentMode,
  normalizeModeToken,
  retiredDeploymentModeError,
  type RetiredModeReplacement,
} from "../lib/retired-deployment-modes.js";

/** The server's internal storage engine. Two arms, no third. */
export type DataBackend = "sqlite" | "postgresql";

/** Variables that select the backend, in priority order. */
export const DATA_BACKEND_ENV_KEYS = [
  "HASNA_RECORDINGS_STORAGE_MODE",
  "RECORDINGS_STORAGE_MODE",
] as const;

function backendReplacement(): RetiredModeReplacement {
  return { envKey: DATA_BACKEND_ENV_KEYS[0], onBox: "sqlite", offBox: "postgresql" };
}

/** Resolve the Postgres DSN from the supported env vars (priority order). */
export function resolveCloudDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    env.HASNA_RECORDINGS_DATABASE_URL ||
    env.RECORDINGS_DATABASE_URL ||
    env.DATABASE_URL ||
    undefined
  );
}

/**
 * The explicitly configured backend, or null when no variable named one.
 *
 * Throws — never normalizes — on a retired deployment word or an unrecognized
 * value. Before this change, ONLY `remote` and `hybrid` were recognized here and
 * every other value (including `self_hosted`, including a typo) fell silently
 * through to "is a DATABASE_URL set?", so the operator's stated intent was
 * discarded without a word.
 */
export function configuredDataBackend(
  env: NodeJS.ProcessEnv = process.env,
): { backend: DataBackend; source: string } | null {
  for (const key of DATA_BACKEND_ENV_KEYS) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    const token = normalizeModeToken(raw);
    if (token === "sqlite") return { backend: "sqlite", source: key };
    if (token === "postgresql" || token === "postgres") return { backend: "postgresql", source: key };
    if (asRetiredDeploymentMode(raw)) {
      throw retiredDeploymentModeError(raw, key, backendReplacement());
    }
    throw new Error(
      `${key}=${raw} is not a data backend. Use ${DATA_BACKEND_ENV_KEYS[0]}=sqlite or ` +
        `${DATA_BACKEND_ENV_KEYS[0]}=postgresql.`,
    );
  }
  return null;
}

/**
 * The backend this process will use. An explicit setting wins; otherwise the
 * presence of a DSN is taken as the request for `postgresql`.
 */
export function resolveDataBackend(env: NodeJS.ProcessEnv = process.env): DataBackend {
  const configured = configuredDataBackend(env);
  if (configured) return configured.backend;
  return resolveCloudDatabaseUrl(env) ? "postgresql" : "sqlite";
}

/** True when this process serves `/v1` out of PostgreSQL. */
export function isPostgresBackendEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveDataBackend(env) === "postgresql";
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
      "The /v1 API requires a signing secret (HASNA_RECORDINGS_API_SIGNING_KEY / HASNA_API_SIGNING_KEY / API_KEY_SIGNING_SECRET).",
    );
  }
  if (Buffer.byteLength(signingSecret, "utf8") < 16) {
    throw new Error("The /v1 API signing secret must be at least 16 bytes.");
  }
  return signingSecret;
}
