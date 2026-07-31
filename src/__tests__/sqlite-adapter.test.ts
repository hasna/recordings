import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAdapter } from "../db/sqlite-adapter.js";

const databases: string[] = [];

afterEach(() => {
  for (const path of databases.splice(0)) {
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});

describe("SqliteAdapter", () => {
  test("creates a WAL database with foreign keys enabled", () => {
    const path = join(tmpdir(), `recordings-adapter-${process.pid}-${Date.now()}.db`);
    databases.push(path);
    const adapter = new SqliteAdapter(path);
    try {
      expect(existsSync(path)).toBeTrue();
      expect(adapter.get("PRAGMA journal_mode")).toEqual({ journal_mode: "wal" });
      expect(adapter.get("PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 });
    } finally {
      adapter.close();
    }
  });

  test("executes statements and accepts both spread and array parameters", () => {
    const path = join(tmpdir(), `recordings-adapter-queries-${process.pid}-${Date.now()}.db`);
    databases.push(path);
    const adapter = new SqliteAdapter(path);
    try {
      adapter.exec("CREATE TABLE values_table (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");

      const first = adapter.run(
        "INSERT INTO values_table (label) VALUES (?)",
        "spread",
      );
      const second = adapter.run(
        "INSERT INTO values_table (label) VALUES (?)",
        ["array"],
      );

      expect(first.changes).toBe(1);
      expect(Number(first.lastInsertRowid)).toBe(1);
      expect(second.changes).toBe(1);
      expect(Number(second.lastInsertRowid)).toBe(2);
      expect(adapter.get("SELECT label FROM values_table WHERE id = ?", [1])).toEqual({
        label: "spread",
      });
      expect(adapter.all("SELECT label FROM values_table WHERE id > ? ORDER BY id", 0)).toEqual([
        { label: "spread" },
        { label: "array" },
      ]);
    } finally {
      adapter.close();
    }
  });
});
