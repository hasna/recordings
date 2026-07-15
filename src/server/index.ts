#!/usr/bin/env bun
/**
 * Entry point for `recordings-serve` — the @hasna/recordings HTTP API.
 *
 * Usage:
 *   recordings-serve [--port <port>] [--host <host>]
 *   recordings-serve migrate      # one-shot cloud schema migration (ECS task)
 *   recordings-serve --version
 *
 * In cloud (A1 pure-remote) mode the process reads/writes the shared cloud Postgres
 * Postgres directly with @hasna/contracts API-key auth. Fail-closed: `/v1`
 * refuses to serve without a DSN + signing secret (503).
 */
import { VERSION } from "../version.js";

const DEFAULT_PORT = 8874;

function parsePort(): number {
  const arg = process.argv.find((a) => a === "--port" || a.startsWith("--port="));
  if (arg) {
    if (arg.includes("=")) return parseInt(arg.split("=")[1]!, 10) || DEFAULT_PORT;
    const idx = process.argv.indexOf(arg);
    return parseInt(process.argv[idx + 1]!, 10) || DEFAULT_PORT;
  }
  const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;
  return envPort || DEFAULT_PORT;
}

function parseStringArg(name: string): string | undefined {
  const arg = process.argv.find((a) => a === name || a.startsWith(`${name}=`));
  if (!arg) return undefined;
  if (arg.includes("=")) return arg.split("=")[1] || undefined;
  const idx = process.argv.indexOf(arg);
  return process.argv[idx + 1] || undefined;
}

function printHelp(): void {
  console.log(`Usage: recordings-serve [options]

Start the @hasna/recordings HTTP API server.

Options:
  --port <port>   HTTP port to bind. Defaults to ${DEFAULT_PORT} (or $PORT)
  --host <host>   Hostname to bind. Defaults to 127.0.0.1 (or $HOST)
  -V, --version   output the version number
  -h, --help      display help for command

Commands:
  migrate         Apply the cloud schema, then exit. Idempotent.

Environment:
  HASNA_RECORDINGS_DATABASE_URL   Remote Postgres DSN (enables cloud /v1)
  HASNA_RECORDINGS_API_SIGNING_KEY  HMAC signing secret for API-key auth`);
}

async function runMigrate(): Promise<void> {
  const {
    closeCloud,
    getCloudPg,
    migrateCloudSchema,
    pingCloudConnectivity,
    resolveCloudDatabaseUrl,
  } = await import("./cloud.js");
  const { assertCloudSchemaContract } = await import("./cloud-readiness.js");
  const { runCloudMigration } = await import("./migrate-command.js");
  if (!resolveCloudDatabaseUrl()) {
    console.error(
      "migrate: no database URL (HASNA_RECORDINGS_DATABASE_URL / RECORDINGS_DATABASE_URL / DATABASE_URL)",
    );
    process.exit(2);
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
  process.exit(0);
}

async function main() {
  if (process.argv.includes("migrate")) {
    await runMigrate();
    return;
  }
  if (process.argv.includes("--version") || process.argv.includes("-V")) {
    console.log(VERSION);
    return;
  }
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }
  const port = parsePort();
  const { startServer } = await import("./serve.js");
  await startServer(port, { host: parseStringArg("--host") || process.env.HOST });
}

main().catch((e) => {
  console.error("recordings-serve: fatal:", (e as Error).message);
  process.exit(1);
});
