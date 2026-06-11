import { PgAdapterAsync } from "./remote-storage.js";
import { PG_MIGRATIONS } from "./pg-migrations.js";

export interface PgMigrationResult {
  applied: number[];
  alreadyApplied: number[];
  errors: string[];
  totalMigrations: number;
}

export async function applyPgMigrations(connectionString: string): Promise<PgMigrationResult> {
  const pg = new PgAdapterAsync(connectionString);
  const result: PgMigrationResult = {
    applied: [],
    alreadyApplied: [],
    errors: [],
    totalMigrations: PG_MIGRATIONS.length,
  };

  try {
    await pg.run(`
      CREATE TABLE IF NOT EXISTS _pg_migrations (
        id SERIAL PRIMARY KEY,
        version INT UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const applied = await pg.all("SELECT version FROM _pg_migrations ORDER BY version") as Array<{ version: number }>;
    const appliedSet = new Set(applied.map((row) => row.version));

    for (let index = 0; index < PG_MIGRATIONS.length; index++) {
      if (appliedSet.has(index)) {
        result.alreadyApplied.push(index);
        continue;
      }

      try {
        await pg.exec(PG_MIGRATIONS[index]!);
        await pg.run("INSERT INTO _pg_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING", index);
        result.applied.push(index);
      } catch (error) {
        result.errors.push(`Migration ${index}: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
  } finally {
    await pg.close();
  }

  return result;
}
