#!/usr/bin/env bun
/**
 * Migration runner for the recordings cloud (A1 pure-remote) database.
 *
 * Applies the relational recordings schema and the contracts API-key store,
 * idempotently and safely against populated databases. Migration 18 replaces
 * the idempotency foreign key in place to preserve deletion tombstones.
 * Connectivity is checked before DDL; the contract is checked only afterward.
 *
 * The canonical DDL is committed under migrations/*.sql for transparency.
 *
 * Env: HASNA_RECORDINGS_DATABASE_URL (or RECORDINGS_DATABASE_URL / DATABASE_URL).
 * Usage: bun run scripts/migrate.ts
 */
import { fileURLToPath } from "node:url";

async function runPublishedEntrypoint(): Promise<boolean> {
  if (await Bun.file(new URL("../src/server/cloud.ts", import.meta.url)).exists()) return false;
  const entrypoint = fileURLToPath(new URL("../dist/server/index.js", import.meta.url));
  const child = Bun.spawn([process.execPath, entrypoint, "migrate"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
  return true;
}

async function main() {
  // Published packages ship the compiled server but intentionally omit src/.
  if (await runPublishedEntrypoint()) return;
  const {
    closeCloud,
    getCloudPg,
    migrateCloudSchema,
    pingCloudConnectivity,
    resolveCloudDatabaseUrl,
  } = await import("../src/server/cloud.js");
  const { assertCloudSchemaContract } = await import("../src/server/cloud-readiness.js");
  const { runCloudMigration } = await import("../src/server/migrate-command.js");
  const url = resolveCloudDatabaseUrl();
  if (!url) {
    console.error(
      "migrate: no database URL (HASNA_RECORDINGS_DATABASE_URL / RECORDINGS_DATABASE_URL / DATABASE_URL)",
    );
    process.exitCode = 2;
    return;
  }
  console.log("migrate: connecting…");
  await runCloudMigration({
    pingConnectivity: pingCloudConnectivity,
    applyMigrations: async () => {
      console.log("migrate: applying schema (recordings tables + api_keys)…");
      await migrateCloudSchema();
    },
    validateContract: () => assertCloudSchemaContract(getCloudPg()),
  });
  console.log("migrate: done");
  await closeCloud();
}

main().catch((e) => {
  console.error("migrate: failed:", (e as Error).message);
  process.exitCode = 1;
});
