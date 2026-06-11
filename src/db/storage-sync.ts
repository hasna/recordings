import { type Database } from "bun:sqlite";
import { getDatabase, getDbPath } from "./database.js";
import {
  STORAGE_DATABASE_ENV,
  getStorageConfig,
  getStorageConnectionString,
  getStorageDatabaseEnv,
  type StorageMode,
} from "./storage-config.js";
import { PgAdapterAsync } from "./remote-storage.js";
import { PG_MIGRATIONS } from "./pg-migrations.js";

type Row = Record<string, unknown>;

export interface SyncResult {
  table: string;
  direction: "push" | "pull";
  rows_read: number;
  rows_written: number;
  errors: string[];
}

export interface StorageStatus {
  configured: boolean;
  mode: StorageMode;
  enabled: boolean;
  env: typeof STORAGE_DATABASE_ENV;
  activeEnv: string | null;
  service: "recordings";
  db_path: string;
  tables: Array<{ table: string; rows: number }>;
}

export const STORAGE_TABLES = [
  "projects",
  "agents",
  "recordings",
  "recording_tags",
  "feedback",
] as const;

export const RECORDINGS_STORAGE_TABLES = STORAGE_TABLES;

const TABLE_KEYS: Record<string, string[]> = {
  projects: ["id"],
  agents: ["id"],
  recordings: ["id"],
  recording_tags: ["recording_id", "tag"],
  feedback: ["id"],
};

function quoteId(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

async function getRemoteColumns(remote: PgAdapterAsync, table: string): Promise<Set<string>> {
  const rows = await remote.all(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    table
  ) as Array<{ column_name: string }>;
  return new Set(rows.map((row) => row.column_name));
}

async function upsertPg(remote: PgAdapterAsync, table: string, rows: Row[]): Promise<number> {
  if (rows.length === 0) return 0;

  const keyColumns = TABLE_KEYS[table] ?? ["id"];
  const remoteColumns = await getRemoteColumns(remote, table);
  let written = 0;

  for (const row of rows) {
    const columns = Object.keys(row).filter((column) => remoteColumns.has(column));
    if (keyColumns.some((column) => !columns.includes(column))) continue;

    const values = columns.map((column) => row[column]);
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
    const updateColumns = columns.filter((column) => !keyColumns.includes(column));
    const updateClause = updateColumns.length > 0
      ? `DO UPDATE SET ${updateColumns.map((column) => `${quoteId(column)} = EXCLUDED.${quoteId(column)}`).join(", ")}`
      : "DO NOTHING";

    await remote.run(
      `INSERT INTO ${quoteId(table)} (${columns.map(quoteId).join(", ")})
       VALUES (${placeholders})
       ON CONFLICT (${keyColumns.map(quoteId).join(", ")}) ${updateClause}`,
      ...values
    );
    written++;
  }

  return written;
}

function upsertSqlite(db: Database, table: string, rows: Row[]): number {
  const keyColumns = TABLE_KEYS[table] ?? ["id"];
  let written = 0;

  for (const row of rows) {
    const columns = Object.keys(row);
    if (keyColumns.some((column) => !columns.includes(column))) continue;

    const updateColumns = columns.filter((column) => !keyColumns.includes(column));
    const updateClause = updateColumns.length > 0
      ? `DO UPDATE SET ${updateColumns.map((column) => `${quoteId(column)} = excluded.${quoteId(column)}`).join(", ")}`
      : "DO NOTHING";

    db.query(
      `INSERT INTO ${quoteId(table)} (${columns.map(quoteId).join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})
       ON CONFLICT(${keyColumns.map(quoteId).join(", ")}) ${updateClause}`
    ).run(...columns.map((column) => row[column]) as any[]);
    written++;
  }

  return written;
}

export async function getStoragePg(): Promise<PgAdapterAsync> {
  return new PgAdapterAsync(getStorageConnectionString("recordings"));
}

export async function runStorageMigrations(remote: PgAdapterAsync): Promise<void> {
  for (const migration of PG_MIGRATIONS) {
    await remote.exec(migration);
  }
}

export function getStorageStatus(db: Database = getDatabase()): StorageStatus {
  const config = getStorageConfig();
  const activeEnv = getStorageDatabaseEnv();
  return {
    configured: Boolean(activeEnv),
    mode: config.mode,
    enabled: config.mode === "hybrid" || config.mode === "remote",
    env: STORAGE_DATABASE_ENV,
    activeEnv: activeEnv?.name ?? null,
    service: "recordings",
    db_path: getDbPath(),
    tables: STORAGE_TABLES.map((table) => {
      try {
        const row = db.query(`SELECT COUNT(*) as count FROM ${quoteId(table)}`).get() as { count: number };
        return { table, rows: row.count };
      } catch {
        return { table, rows: 0 };
      }
    }),
  };
}

export async function pushStorageChanges(tables: string[] = [...STORAGE_TABLES]): Promise<SyncResult[]> {
  const db = getDatabase();
  const remote = await getStoragePg();
  const results: SyncResult[] = [];

  try {
    await runStorageMigrations(remote);
    for (const table of tables) {
      const result: SyncResult = { table, direction: "push", rows_read: 0, rows_written: 0, errors: [] };
      try {
        const rows = db.query(`SELECT * FROM ${quoteId(table)}`).all() as Row[];
        result.rows_read = rows.length;
        result.rows_written = await upsertPg(remote, table, rows);
      } catch (error) {
        result.errors.push(error instanceof Error ? error.message : String(error));
      }
      results.push(result);
    }
  } finally {
    await remote.close();
  }

  return results;
}

export async function pullStorageChanges(tables: string[] = [...STORAGE_TABLES]): Promise<SyncResult[]> {
  const db = getDatabase();
  const remote = await getStoragePg();
  const results: SyncResult[] = [];

  try {
    await runStorageMigrations(remote);
    for (const table of tables) {
      const result: SyncResult = { table, direction: "pull", rows_read: 0, rows_written: 0, errors: [] };
      try {
        const rows = await remote.all(`SELECT * FROM ${quoteId(table)}`) as Row[];
        result.rows_read = rows.length;
        result.rows_written = upsertSqlite(db, table, rows);
      } catch (error) {
        result.errors.push(error instanceof Error ? error.message : String(error));
      }
      results.push(result);
    }
  } finally {
    await remote.close();
  }

  return results;
}

export async function syncStorageChanges(tables: string[] = [...STORAGE_TABLES]): Promise<{ push: SyncResult[]; pull: SyncResult[] }> {
  return {
    push: await pushStorageChanges(tables),
    pull: await pullStorageChanges(tables),
  };
}

export function parseStorageTables(raw?: string): string[] {
  if (!raw) return [...STORAGE_TABLES];
  const requested = raw.split(",").map((table) => table.trim()).filter(Boolean);
  if (requested.length === 0) return [...STORAGE_TABLES];
  const allowed = new Set<string>(STORAGE_TABLES);
  const invalid = requested.filter((table) => !allowed.has(table));
  if (invalid.length > 0) throw new Error(`Unknown recordings sync table(s): ${invalid.join(", ")}`);
  return requested;
}
