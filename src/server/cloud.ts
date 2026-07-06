/**
 * Cloud (A1 pure-remote) service wiring for `recordings-serve`.
 *
 * Per Amendment A1 the serve process reads and writes the shared cloud Postgres
 * DIRECTLY through the repo-native async adapter (`PgAdapterAsync`) — there is
 * NO local sync/cache in the service. Everything is lazy: nothing touches
 * Postgres or crypto until the first `/v1` (or `/ready`) request, so the
 * local-first CLI/MCP paths keep ZERO cloud dependencies.
 *
 * Auth is enforced by the vendored `@hasna/contracts` kit: stateless HMAC-signed
 * API keys, hashed at rest in the cloud Postgres `api_keys` table, verified per request.
 */
import { verifyApiKey, type ApiKeyVerifier } from "@hasna/contracts/auth";
import { ApiKeyStore, type AuthQueryClient } from "@hasna/contracts/auth";
import { PgAdapterAsync } from "../db/remote-storage.js";
import { PG_MIGRATIONS } from "../db/pg-migrations.js";

export const RECORDINGS_APP_SLUG = "recordings";

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

/** True when this process is configured to serve the cloud `/v1` API. */
export function isCloudModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = (env.HASNA_RECORDINGS_STORAGE_MODE || env.RECORDINGS_STORAGE_MODE || "").toLowerCase();
  if (mode === "remote" || mode === "hybrid") return true;
  return Boolean(resolveCloudDatabaseUrl(env));
}

let cachedPg: PgAdapterAsync | null = null;
let cachedStore: ApiKeyStore | null = null;
let cachedVerifier: ApiKeyVerifier | null = null;
let schemaEnsured: Promise<void> | null = null;

/** The pure-remote Postgres adapter backing every `/v1` handler. */
export function getCloudPg(): PgAdapterAsync {
  if (cachedPg) return cachedPg;
  const url = resolveCloudDatabaseUrl();
  if (!url) {
    throw new Error(
      "Cloud /v1 requires a remote database URL (HASNA_RECORDINGS_DATABASE_URL / RECORDINGS_DATABASE_URL / DATABASE_URL).",
    );
  }
  cachedPg = new PgAdapterAsync(url);
  return cachedPg;
}

/**
 * Bridge the repo-native adapter to the contracts kit's `AuthQueryClient`
 * ({ many, get, execute }). The store emits `$1`-style SQL; `PgAdapterAsync`
 * only rewrites `?` placeholders, so those statements pass through untouched.
 */
function authClient(): AuthQueryClient {
  const pg = getCloudPg();
  return {
    async many<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      return (await pg.all(sql, ...(params as unknown[]))) as T[];
    },
    async get<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
      return (await pg.get(sql, ...(params as unknown[]))) as T | null;
    },
    async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
      await pg.run(sql, ...(params as unknown[]));
    },
  };
}

export function getApiKeyStore(): ApiKeyStore {
  if (cachedStore) return cachedStore;
  cachedStore = new ApiKeyStore(authClient());
  return cachedStore;
}

/**
 * The framework-agnostic API-key verifier for `/v1`. Tokens are stateless,
 * HMAC-signed by the contracts issuer; revocation is checked against the cloud Postgres
 * `api_keys` table. Fails closed when no signing secret is configured.
 */
export function getCloudVerifier(): ApiKeyVerifier {
  if (cachedVerifier) return cachedVerifier;
  const signingSecret = resolveSigningSecret();
  if (!signingSecret) {
    throw new Error(
      "Cloud /v1 auth requires a signing secret (HASNA_RECORDINGS_API_SIGNING_KEY / HASNA_API_SIGNING_KEY / API_KEY_SIGNING_SECRET).",
    );
  }
  const store = getApiKeyStore();
  cachedVerifier = verifyApiKey({
    app: RECORDINGS_APP_SLUG,
    signingSecret,
    isRevoked: store.isRevoked,
  });
  return cachedVerifier;
}

function isPrivilegeError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
  return (
    msg.includes("permission denied") ||
    msg.includes("must be owner") ||
    msg.includes("insufficient privilege")
  );
}

/** Cheap check (SELECT only) that the required tables already exist. */
async function requiredTablesExist(): Promise<boolean> {
  const pg = getCloudPg();
  const row = (await pg.get(
    `SELECT
       (to_regclass('public.recordings') IS NOT NULL) AS has_recordings,
       (to_regclass('public.api_keys')   IS NOT NULL) AS has_api_keys`,
  )) as { has_recordings: boolean; has_api_keys: boolean } | null;
  return Boolean(row?.has_recordings && row?.has_api_keys);
}

/**
 * Ensure the remote schema exists: the relational recordings tables plus the
 * contracts api-keys table. Idempotent (CREATE ... IF NOT EXISTS / ADD COLUMN IF
 * NOT EXISTS) — safe to run against a populated DB; NEVER drops or rewrites.
 *
 * Per the platform isolation model the request-path role (`recordings_app`) has
 * DML only — no DDL. DDL is owned by the `recordings_owner` role (the migration
 * task / out-of-band apply). So when this runs under the app role and the tables
 * already exist, a "permission denied" on the CREATE path is EXPECTED: we treat
 * the schema as externally managed and continue. If the tables are genuinely
 * missing we fail loudly (never a silent stub).
 */
export async function ensureCloudSchema(): Promise<void> {
  if (schemaEnsured) return schemaEnsured;
  schemaEnsured = (async () => {
    const pg = getCloudPg();
    try {
      await pg.run(
        `CREATE TABLE IF NOT EXISTS _pg_migrations (id SERIAL PRIMARY KEY, version INT UNIQUE NOT NULL, applied_at TIMESTAMPTZ DEFAULT NOW())`,
      );
      const applied = (await pg.all("SELECT version FROM _pg_migrations ORDER BY version")) as Array<{
        version: number;
      }>;
      const appliedSet = new Set(applied.map((r) => Number(r.version)));
      for (let i = 0; i < PG_MIGRATIONS.length; i++) {
        if (appliedSet.has(i)) continue;
        await pg.exec(PG_MIGRATIONS[i]!);
        await pg.run("INSERT INTO _pg_migrations (version) VALUES (?) ON CONFLICT DO NOTHING", i);
      }
      await getApiKeyStore().ensureSchema();
    } catch (e) {
      // App role lacking DDL is fine ONLY if the schema is already in place.
      if (isPrivilegeError(e) && (await requiredTablesExist())) {
        console.warn(
          "recordings-serve: schema is externally managed (owner-applied); the request-path role lacks DDL — continuing.",
        );
        return;
      }
      schemaEnsured = null; // allow a later retry
      throw e;
    }
  })();
  return schemaEnsured;
}

/** Cheap readiness probe: round-trips a trivial query to cloud Postgres. */
export async function pingCloud(): Promise<boolean> {
  const pg = getCloudPg();
  const res = (await pg.get("SELECT 1 as ok")) as { ok: number } | null;
  return Number(res?.ok) === 1;
}

/** Test/shutdown helper. */
export async function closeCloud(): Promise<void> {
  if (cachedPg) await cachedPg.close();
  cachedPg = null;
  cachedStore = null;
  cachedVerifier = null;
  schemaEnsured = null;
}
