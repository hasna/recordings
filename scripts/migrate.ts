#!/usr/bin/env bun
/**
 * Migration runner for the recordings cloud (A1 pure-remote) database.
 *
 * Applies the relational recordings schema and the contracts API-key store,
 * idempotently (CREATE ... IF NOT EXISTS). NEVER drops or rewrites existing
 * tables — safe to run against a populated DB. Shares the exact code path used
 * by the serve process (`ensureCloudSchema`).
 *
 * The canonical DDL is committed under migrations/*.sql for transparency.
 *
 * Env: HASNA_RECORDINGS_DATABASE_URL (or RECORDINGS_DATABASE_URL / DATABASE_URL).
 * Usage: bun run scripts/migrate.ts
 */
import { ensureCloudSchema, pingCloud, resolveCloudDatabaseUrl, closeCloud } from "../src/server/cloud.js";

async function main() {
  const url = resolveCloudDatabaseUrl();
  if (!url) {
    console.error(
      "migrate: no database URL (HASNA_RECORDINGS_DATABASE_URL / RECORDINGS_DATABASE_URL / DATABASE_URL)",
    );
    process.exit(2);
  }
  console.log("migrate: connecting…");
  await pingCloud();
  console.log("migrate: applying schema (recordings tables + api_keys)…");
  await ensureCloudSchema();
  console.log("migrate: done");
  await closeCloud();
  process.exit(0);
}

main().catch((e) => {
  console.error("migrate: failed:", (e as Error).message);
  process.exit(1);
});
