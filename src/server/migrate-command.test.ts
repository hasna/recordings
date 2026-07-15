import { describe, expect, test } from "bun:test";
import { PG_MIGRATIONS } from "../db/pg-migrations.js";
import { applyRecordedCloudMigrations, runCloudMigration } from "./migrate-command.js";
import type { PgAdapterAsync } from "../db/remote-storage.js";

describe("cloud migration command", () => {
  test("the published migration wrapper falls back to the shipped server entrypoint", async () => {
    const wrapper = await Bun.file(new URL("../../scripts/migrate.ts", import.meta.url)).text();
    expect(wrapper).toContain('../dist/server/index.js');
    expect(wrapper).toContain('await import("../src/server/cloud.js")');
    expect(wrapper).not.toMatch(/^import .*src\/server\/cloud/m);
  });

  test("probes connectivity before applying and validating a fresh schema", async () => {
    const calls: string[] = [];
    await runCloudMigration({
      pingConnectivity: async () => { calls.push("connect"); },
      applyMigrations: async () => { calls.push("apply"); },
      validateContract: async () => { calls.push("validate"); },
    });
    expect(calls).toEqual(["connect", "apply", "validate"]);
  });

  test("does not run schema readiness before an upgrade migration", async () => {
    let schemaVersion = 17;
    await runCloudMigration({
      pingConnectivity: async () => {},
      applyMigrations: async () => { schemaVersion = 18; },
      validateContract: async () => expect(schemaVersion).toBe(18),
    });
  });

  test("a fresh database applies every recorded migration before API-key schema", async () => {
    const executed: string[] = [];
    const recorded: number[] = [];
    let apiKeysEnsured = false;
    const pg = {
      async run(sql: string, version?: number) {
        if (/insert into _pg_migrations/i.test(sql)) recorded.push(version!);
        return { changes: 1 };
      },
      async all() { return []; },
      async exec(sql: string) { executed.push(sql); },
    } as unknown as PgAdapterAsync;
    await applyRecordedCloudMigrations(pg, async () => { apiKeysEnsured = true; });
    expect(executed).toEqual(PG_MIGRATIONS);
    expect(recorded).toEqual(PG_MIGRATIONS.map((_, version) => version));
    expect(apiKeysEnsured).toBe(true);
  });

  test("a migration-17 database applies only migration 18 before validation", async () => {
    const executed: string[] = [];
    const recorded: number[] = [];
    const pg = {
      async run(sql: string, version?: number) {
        if (/insert into _pg_migrations/i.test(sql)) recorded.push(version!);
        return { changes: 1 };
      },
      async all() { return Array.from({ length: 18 }, (_, version) => ({ version })); },
      async exec(sql: string) { executed.push(sql); },
    } as unknown as PgAdapterAsync;
    await applyRecordedCloudMigrations(pg, async () => {});
    expect(executed).toEqual([PG_MIGRATIONS[18]!]);
    expect(recorded).toEqual([18]);
  });
});
