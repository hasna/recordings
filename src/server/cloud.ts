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
import {
  isCloudModeEnabled,
  requireSigningSecret,
  resolveCloudDatabaseUrl,
} from "./cloud-config.js";
import {
  assertCloudSchemaReady,
  pingCloudConnectivity as pingCloudConnectivityWith,
  pingCloudReadiness,
} from "./cloud-readiness.js";
import { applyRecordedCloudMigrations } from "./migrate-command.js";

export const RECORDINGS_APP_SLUG = "recordings";
export { isCloudModeEnabled, requireSigningSecret, resolveCloudDatabaseUrl, resolveSigningSecret } from "./cloud-config.js";

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
  const signingSecret = requireSigningSecret();
  const store = getApiKeyStore();
  cachedVerifier = verifyApiKey({
    app: RECORDINGS_APP_SLUG,
    signingSecret,
    isRevoked: store.isRevoked,
  });
  return cachedVerifier;
}

/**
 * Apply the owner-managed relational and API-key schemas. This is intentionally
 * separate from runtime readiness so it can bootstrap an empty database and
 * upgrade a migration-17 database before the migration-18 contract is checked.
 */
export async function migrateCloudSchema(): Promise<void> {
  await applyRecordedCloudMigrations(getCloudPg(), () => getApiKeyStore().ensureSchema());
}

/** Request-path gate: validate the externally managed schema and DML-only role. */
export async function ensureCloudSchema(): Promise<void> {
  if (schemaEnsured) return schemaEnsured;
  schemaEnsured = assertCloudSchemaReady(getCloudPg()).catch((error) => {
    schemaEnsured = null;
    throw error;
  });
  return schemaEnsured;
}

export async function pingCloudConnectivity(
  pg: Pick<PgAdapterAsync, "get"> = getCloudPg(),
): Promise<boolean> {
  return pingCloudConnectivityWith(pg);
}

/** Schema-aware readiness probe for the DML-only cloud service role. */
export async function pingCloud(
  pg: Pick<PgAdapterAsync, "all" | "get"> = getCloudPg(),
): Promise<boolean> {
  return pingCloudReadiness(pg);
}

/** Test/shutdown helper. */
export async function closeCloud(): Promise<void> {
  if (cachedPg) await cachedPg.close();
  cachedPg = null;
  cachedStore = null;
  cachedVerifier = null;
  schemaEnsured = null;
}
