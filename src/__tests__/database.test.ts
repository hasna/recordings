import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import {
  getDatabase,
  closeDatabase,
  resetDatabase,
  shortUuid,
} from "../db/database.js";

let tempDir: string;

beforeEach(() => {
  resetDatabase();
  tempDir = join(tmpdir(), `open-recordings-test-db-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  closeDatabase();
  resetDatabase();
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("getDatabase", () => {
  test("creates database file and returns a database instance", () => {
    const dbPath = join(tempDir, "test.db");
    const db = getDatabase(dbPath);
    expect(db).toBeDefined();
    expect(existsSync(dbPath)).toBe(true);
  });

  test("creates parent directories if they don't exist", () => {
    const dbPath = join(tempDir, "nested", "deep", "test.db");
    const db = getDatabase(dbPath);
    expect(db).toBeDefined();
    expect(existsSync(dbPath)).toBe(true);
  });

  test("returns the same instance on subsequent calls (singleton)", () => {
    const dbPath = join(tempDir, "test.db");
    const db1 = getDatabase(dbPath);
    const db2 = getDatabase(dbPath);
    expect(db1).toBe(db2);
  });

  test("runs migrations on creation", () => {
    const dbPath = join(tempDir, "test.db");
    const db = getDatabase(dbPath);

    // Check that the tables exist
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("recordings");
    expect(tableNames).toContain("agents");
    expect(tableNames).toContain("projects");
    expect(tableNames).toContain("recording_tags");
    expect(tableNames).toContain("_migrations");
  });

  test("sets WAL journal mode", () => {
    const dbPath = join(tempDir, "test.db");
    const db = getDatabase(dbPath);
    const result = db.query("PRAGMA journal_mode").get() as { journal_mode: string } | null;
    expect(result?.journal_mode).toBe("wal");
  });

  test("enables foreign keys", () => {
    const dbPath = join(tempDir, "test.db");
    const db = getDatabase(dbPath);
    const result = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number } | null;
    expect(result?.foreign_keys).toBe(1);
  });

  test("records migration level", () => {
    const dbPath = join(tempDir, "test.db");
    const db = getDatabase(dbPath);
    const result = db
      .query("SELECT MAX(id) as max_id FROM _migrations")
      .get() as { max_id: number };
    expect(result.max_id).toBe(0);
  });

  test("does not re-run migrations on second open", () => {
    const dbPath = join(tempDir, "test.db");
    const db1 = getDatabase(dbPath);
    // Insert a test row
    db1.query("INSERT INTO agents (id, name, created_at, last_seen_at) VALUES (?, ?, ?, ?)").run(
      "test-id",
      "test-agent",
      new Date().toISOString(),
      new Date().toISOString()
    );
    closeDatabase();
    resetDatabase();

    // Re-open
    const db2 = getDatabase(dbPath);
    const agent = db2.query("SELECT * FROM agents WHERE id = ?").get("test-id") as Record<string, unknown> | undefined;
    expect(agent).toBeDefined();
    expect(agent!["name"]).toBe("test-agent");
  });
});

describe("closeDatabase", () => {
  test("closes the database and allows reset", () => {
    const dbPath = join(tempDir, "test.db");
    getDatabase(dbPath);
    closeDatabase();
    resetDatabase();

    // Should be able to open a new database
    const dbPath2 = join(tempDir, "test2.db");
    const db2 = getDatabase(dbPath2);
    expect(db2).toBeDefined();
  });

  test("is a no-op when no database is open", () => {
    // Should not throw
    closeDatabase();
  });
});

describe("resetDatabase", () => {
  test("clears the singleton so next getDatabase creates new instance", () => {
    const dbPath1 = join(tempDir, "test1.db");
    const db1 = getDatabase(dbPath1);
    closeDatabase();
    resetDatabase();

    const dbPath2 = join(tempDir, "test2.db");
    const db2 = getDatabase(dbPath2);
    expect(db2).not.toBe(db1);
  });
});

describe("getDbPath", () => {
  test("returns the db_path from config", async () => {
    const { getDbPath } = await import("../db/database.js");
    const path = getDbPath();
    expect(typeof path).toBe("string");
    expect(path).toContain("recordings.db");
  });
});

describe("shortUuid", () => {
  test("returns an 8-character string", () => {
    const id = shortUuid();
    expect(id).toHaveLength(8);
  });

  test("returns different values on each call", () => {
    const ids = new Set(Array.from({ length: 100 }, () => shortUuid()));
    expect(ids.size).toBe(100);
  });

  test("only contains valid UUID characters", () => {
    const id = shortUuid();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });
});
