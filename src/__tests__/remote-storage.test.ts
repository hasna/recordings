import { describe, expect, test } from "bun:test";
import type { Pool, PoolClient, QueryResult } from "pg";
import { PgAdapterAsync } from "../db/remote-storage.js";

type QueryCall = { sql: string; params?: unknown[] };

function queryResult(rows: unknown[] = [], rowCount: number | null = rows.length): QueryResult {
  return {
    command: "SELECT",
    rowCount,
    oid: 0,
    fields: [],
    rows,
  } as QueryResult;
}

function fakePool(results: QueryResult[] = []) {
  const calls: QueryCall[] = [];
  let ended = false;
  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return results.shift() ?? queryResult();
    },
    async end() {
      ended = true;
    },
  } as unknown as Pool;
  return { pool, calls, ended: () => ended };
}

describe("PgAdapterAsync", () => {
  test("translates placeholders, flattens array arguments, and normalizes undefined", async () => {
    const fake = fakePool([
      queryResult([], 3),
      queryResult([{ id: 1 }, { id: 2 }]),
      queryResult([]),
      queryResult([{ id: 1 }, { id: 2 }]),
    ]);
    const adapter = new PgAdapterAsync("unused", fake.pool);

    expect(await adapter.run("UPDATE things SET label = ? WHERE id = ?", [undefined, 7])).toEqual({
      changes: 3,
    });
    expect(await adapter.get("SELECT * FROM things WHERE id = ?", 1)).toEqual({ id: 1 });
    expect(await adapter.get("SELECT * FROM things WHERE id = ?", 99)).toBeNull();
    expect(await adapter.all("SELECT * FROM things WHERE id > ?", [0])).toEqual([
      { id: 1 },
      { id: 2 },
    ]);

    expect(fake.calls).toEqual([
      { sql: "UPDATE things SET label = $1 WHERE id = $2", params: [null, 7] },
      { sql: "SELECT * FROM things WHERE id = $1", params: [1] },
      { sql: "SELECT * FROM things WHERE id = $1", params: [99] },
      { sql: "SELECT * FROM things WHERE id > $1", params: [0] },
    ]);
  });

  test("executes raw SQL and closes its pool", async () => {
    const fake = fakePool();
    const adapter = new PgAdapterAsync("unused", fake.pool);

    await adapter.exec("CREATE TABLE example (id int)");
    await adapter.close();

    expect(fake.calls).toEqual([{ sql: "CREATE TABLE example (id int)", params: undefined }]);
    expect(fake.ended()).toBeTrue();
  });

  test("runs a successful transaction on one retained client", async () => {
    const calls: string[] = [];
    let released = false;
    const client = {
      async query(sql: string) {
        calls.push(sql);
        if (sql.startsWith("SELECT")) return queryResult([{ value: 4 }]);
        return queryResult();
      },
      release() {
        released = true;
      },
    } as unknown as PoolClient;
    const pool = {
      async connect() {
        return client;
      },
    } as unknown as Pool;
    const adapter = new PgAdapterAsync("unused", pool);

    const value = await adapter.transaction(async (transaction) => {
      expect(await transaction.get("SELECT value FROM example")).toEqual({ value: 4 });
      expect(await transaction.transaction(async (nested) => nested === transaction)).toBeTrue();
      return "committed";
    });

    expect(value).toBe("committed");
    expect(calls).toEqual(["BEGIN", "SELECT value FROM example", "COMMIT"]);
    expect(released).toBeTrue();
  });

  test("rolls back and releases the client when an operation fails", async () => {
    const calls: string[] = [];
    let released = false;
    const client = {
      async query(sql: string) {
        calls.push(sql);
        return queryResult();
      },
      release() {
        released = true;
      },
    } as unknown as PoolClient;
    const pool = { async connect() { return client; } } as unknown as Pool;
    const adapter = new PgAdapterAsync("unused", pool);

    await expect(adapter.transaction(async () => {
      throw new Error("transaction failed");
    })).rejects.toThrow("transaction failed");

    expect(calls).toEqual(["BEGIN", "ROLLBACK"]);
    expect(released).toBeTrue();
  });

  test("constructs and closes owned pools for plain and TLS-required URLs", async () => {
    const plain = new PgAdapterAsync("postgres://user:pass@127.0.0.1:1/db");
    const tls = new PgAdapterAsync("postgres://user:pass@127.0.0.1:1/db?sslmode=require");

    await plain.close();
    await tls.close();
  });
});
