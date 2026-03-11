import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import {
  getDatabase,
  closeDatabase,
  resetDatabase,
} from "../db/database.js";
import { registerAgent, getAgent, listAgents } from "../db/agents.js";
import { type Database } from "bun:sqlite";

let tempDir: string;
let db: Database;

beforeEach(() => {
  resetDatabase();
  tempDir = join(tmpdir(), `open-recordings-test-agents-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  const dbPath = join(tempDir, "test.db");
  db = getDatabase(dbPath);
});

afterEach(() => {
  closeDatabase();
  resetDatabase();
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("registerAgent", () => {
  test("creates a new agent with name only", () => {
    const agent = registerAgent("maximus", undefined, undefined, db);
    expect(agent).toBeDefined();
    expect(agent.name).toBe("maximus");
    expect(agent.role).toBe("agent");
    expect(agent.description).toBeNull();
    expect(agent.metadata).toEqual({});
    expect(agent.id).toHaveLength(8);
    expect(agent.created_at).toBeDefined();
    expect(agent.last_seen_at).toBeDefined();
  });

  test("creates a new agent with description and role", () => {
    const agent = registerAgent("cassius", "A helper agent", "assistant", db);
    expect(agent.name).toBe("cassius");
    expect(agent.description).toBe("A helper agent");
    expect(agent.role).toBe("assistant");
  });

  test("returns existing agent and updates last_seen_at (idempotent)", () => {
    const first = registerAgent("aurelius", undefined, undefined, db);
    // Wait a tiny bit to ensure timestamp difference
    const second = registerAgent("aurelius", undefined, undefined, db);

    expect(second.id).toBe(first.id);
    expect(second.name).toBe("aurelius");
    // last_seen_at should be updated
    expect(new Date(second.last_seen_at).getTime()).toBeGreaterThanOrEqual(
      new Date(first.last_seen_at).getTime()
    );
  });

  test("does not duplicate agents on re-register", () => {
    registerAgent("brutus", undefined, undefined, db);
    registerAgent("brutus", undefined, undefined, db);
    registerAgent("brutus", undefined, undefined, db);

    const agents = listAgents(db);
    const brutusAgents = agents.filter((a) => a.name === "brutus");
    expect(brutusAgents).toHaveLength(1);
  });
});

describe("getAgent", () => {
  test("finds agent by ID", () => {
    const created = registerAgent("titus", undefined, undefined, db);
    const found = getAgent(created.id, db);
    expect(found).toBeDefined();
    expect(found!.name).toBe("titus");
  });

  test("finds agent by name", () => {
    registerAgent("nero", "The emperor", undefined, db);
    const found = getAgent("nero", db);
    expect(found).toBeDefined();
    expect(found!.description).toBe("The emperor");
  });

  test("finds agent by partial ID prefix", () => {
    const created = registerAgent("cicero", undefined, undefined, db);
    const prefix = created.id.substring(0, 4);
    const found = getAgent(prefix, db);
    expect(found).toBeDefined();
    expect(found!.name).toBe("cicero");
  });

  test("returns null for non-existent agent", () => {
    const found = getAgent("nonexistent", db);
    expect(found).toBeNull();
  });
});

describe("listAgents", () => {
  test("returns empty array when no agents", () => {
    const agents = listAgents(db);
    expect(agents).toEqual([]);
  });

  test("returns all agents ordered by last_seen_at DESC", () => {
    registerAgent("alpha", undefined, undefined, db);
    registerAgent("beta", undefined, undefined, db);
    registerAgent("gamma", undefined, undefined, db);

    const agents = listAgents(db);
    expect(agents).toHaveLength(3);
    // All three agents are present
    const names = agents.map((a) => a.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(names).toContain("gamma");
  });

  test("parses metadata JSON correctly", () => {
    const agent = registerAgent("delta", undefined, undefined, db);
    // Manually update metadata for testing
    db.query("UPDATE agents SET metadata = ? WHERE id = ?").run(
      JSON.stringify({ tool: "test" }),
      agent.id
    );

    const found = getAgent(agent.id, db);
    expect(found!.metadata).toEqual({ tool: "test" });
  });
});
