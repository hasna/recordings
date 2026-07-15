import { PG_MIGRATIONS } from "../db/pg-migrations.js";
import type { PgAdapterAsync } from "../db/remote-storage.js";

export interface CloudMigrationSteps {
  pingConnectivity(): Promise<unknown>;
  applyMigrations(): Promise<unknown>;
  validateContract(): Promise<unknown>;
}

/** Apply the versioned relational migrations, then the contracts API-key schema. */
export async function applyRecordedCloudMigrations(
  pg: Pick<PgAdapterAsync, "all" | "exec" | "run">,
  ensureApiKeySchema: () => Promise<unknown>,
): Promise<void> {
  await pg.run(
    `CREATE TABLE IF NOT EXISTS _pg_migrations (id SERIAL PRIMARY KEY, version INT UNIQUE NOT NULL, applied_at TIMESTAMPTZ DEFAULT NOW())`,
  );
  const applied = (await pg.all("SELECT version FROM _pg_migrations ORDER BY version")) as Array<{
    version: number;
  }>;
  const appliedSet = new Set(applied.map((row) => Number(row.version)));
  for (let version = 0; version < PG_MIGRATIONS.length; version++) {
    if (appliedSet.has(version)) continue;
    await pg.exec(PG_MIGRATIONS[version]!);
    await pg.run("INSERT INTO _pg_migrations (version) VALUES (?) ON CONFLICT DO NOTHING", version);
  }
  await ensureApiKeySchema();
}

/** Run owner-role migration steps without requiring the pre-migration schema to be ready. */
export async function runCloudMigration(steps: CloudMigrationSteps): Promise<void> {
  await steps.pingConnectivity();
  await steps.applyMigrations();
  await steps.validateContract();
}
