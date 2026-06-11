import type { Command } from "commander";
import chalk from "chalk";
import { getStorageConnectionString } from "../db/storage-config.js";
import {
  getStorageStatus,
  parseStorageTables,
  pullStorageChanges,
  pushStorageChanges,
  syncStorageChanges,
} from "../db/storage-sync.js";
import { getAdapter } from "../db/database.js";

function shouldJson(program: Command, opts: { json?: boolean }): boolean {
  return Boolean(opts.json || program.opts().json);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printResults(results: Awaited<ReturnType<typeof pushStorageChanges>>): void {
  for (const result of results) {
    const line = `${result.table}: ${result.rows_written}/${result.rows_read} row(s)`;
    console.log(result.errors.length > 0 ? chalk.yellow(line) : chalk.green(line));
    for (const error of result.errors) {
      console.error(chalk.red(`  ${error}`));
    }
  }
}

export function registerStorageCommands(program: Command): void {
  const storage = program
    .command("storage")
    .description("Manage recordings local/remote storage sync");

  storage
    .command("status")
    .description("Show local database and storage sync status")
    .option("--json", "Output JSON")
    .action((opts: { json?: boolean }) => {
      const status = getStorageStatus();
      if (shouldJson(program, opts)) {
        printJson(status);
        return;
      }
      console.log(`Mode: ${status.mode}`);
      console.log(`Enabled: ${status.enabled ? "yes" : "no"}`);
      console.log(`Database: ${status.db_path}`);
      for (const table of status.tables) {
        console.log(`  ${table.table}: ${table.rows}`);
      }
    });

  storage
    .command("push")
    .description("Push local recordings data to PostgreSQL")
    .option("--tables <tables>", "Comma-separated table names")
    .option("--json", "Output JSON")
    .action(async (opts: { tables?: string; json?: boolean }) => {
      try {
        const results = await pushStorageChanges(parseStorageTables(opts.tables));
        if (shouldJson(program, opts)) printJson(results);
        else printResults(results);
      } catch (error) {
        if (shouldJson(program, opts)) printJson({ error: error instanceof Error ? error.message : String(error) });
        else console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
      }
    });

  storage
    .command("pull")
    .description("Pull PostgreSQL recordings data into the local database")
    .option("--tables <tables>", "Comma-separated table names")
    .option("--json", "Output JSON")
    .action(async (opts: { tables?: string; json?: boolean }) => {
      try {
        const results = await pullStorageChanges(parseStorageTables(opts.tables));
        if (shouldJson(program, opts)) printJson(results);
        else printResults(results);
      } catch (error) {
        if (shouldJson(program, opts)) printJson({ error: error instanceof Error ? error.message : String(error) });
        else console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
      }
    });

  storage
    .command("sync")
    .description("Push local changes, then pull remote changes")
    .option("--tables <tables>", "Comma-separated table names")
    .option("--json", "Output JSON")
    .action(async (opts: { tables?: string; json?: boolean }) => {
      try {
        const result = await syncStorageChanges(parseStorageTables(opts.tables));
        if (shouldJson(program, opts)) {
          printJson(result);
          return;
        }
        console.log(chalk.bold("Push"));
        printResults(result.push);
        console.log(chalk.bold("Pull"));
        printResults(result.pull);
      } catch (error) {
        if (shouldJson(program, opts)) printJson({ error: error instanceof Error ? error.message : String(error) });
        else console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
      }
    });

  storage
    .command("migrate")
    .description("Apply PostgreSQL migrations")
    .option("--connection-string <url>", "PostgreSQL connection string")
    .option("--json", "Output JSON")
    .action(async (opts: { connectionString?: string; json?: boolean }) => {
      try {
        const { applyPgMigrations } = await import("../db/pg-migrate.js");
        const result = await applyPgMigrations(opts.connectionString || getStorageConnectionString("recordings"));
        if (shouldJson(program, opts)) {
          printJson(result);
          return;
        }
        if (result.applied.length > 0) console.log(chalk.green(`Applied ${result.applied.length} migration(s)`));
        if (result.alreadyApplied.length > 0) console.log(chalk.gray(`Already applied: ${result.alreadyApplied.length}`));
        if (result.errors.length > 0) {
          for (const error of result.errors) console.error(chalk.red(error));
          process.exitCode = 1;
        }
      } catch (error) {
        if (shouldJson(program, opts)) printJson({ error: error instanceof Error ? error.message : String(error) });
        else console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
      }
    });

  storage
    .command("feedback <message>")
    .description("Save feedback locally")
    .option("--email <email>")
    .option("--category <category>", "Feedback category", "general")
    .option("--json", "Output JSON")
    .action((message: string, opts: { email?: string; category?: string; json?: boolean }) => {
      try {
        const adapter = getAdapter();
        adapter.run(
          "INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)",
          message,
          opts.email || null,
          opts.category || "general",
          "recordings"
        );
        if (shouldJson(program, opts)) printJson({ saved: true });
        else console.log(chalk.green("Feedback saved."));
      } catch (error) {
        if (shouldJson(program, opts)) printJson({ error: error instanceof Error ? error.message : String(error) });
        else console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
      }
    });
}
