import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import {
  getDatabase,
  closeDatabase,
  resetDatabase,
} from "../db/database.js";
import {
  registerAgent,
  getAgent,
  listAgents,
  setAgentFocus,
} from "../db/agents.js";
import { registerProject } from "../db/projects.js";
import { ProjectNotFoundError } from "../db/errors.js";
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

describe("setAgentFocus (project ref resolution)", () => {
  // Regression: register_project/list_projects surface a TRUNCATED 8-char id,
  // but the stored PK is a 36-char UUID. Feeding the short id (or name) back
  // into set_focus used to trip the active_project_id FK and leak a raw
  // "FOREIGN KEY constraint failed". Focus must resolve the ref first.
  test("resolves the full project UUID", () => {
    const agent = registerAgent("focus-full", undefined, undefined, db);
    const project = registerProject("proj-full", "/tmp/proj-full", undefined, db);
    expect(project.id).toHaveLength(36);
    const updated = setAgentFocus(agent.id, project.id, db);
    expect(updated).not.toBeNull();
    const row = db.query("SELECT active_project_id FROM agents WHERE id = ?").get(agent.id) as { active_project_id: string };
    expect(row.active_project_id).toBe(project.id);
  });

  test("resolves the TRUNCATED 8-char project id that the tools surface", () => {
    const agent = registerAgent("focus-short", undefined, undefined, db);
    const project = registerProject("proj-short", "/tmp/proj-short", undefined, db);
    const shortId = project.id.slice(0, 8);
    expect(shortId).not.toBe(project.id);
    const updated = setAgentFocus(agent.id, shortId, db);
    expect(updated).not.toBeNull();
    const row = db.query("SELECT active_project_id FROM agents WHERE id = ?").get(agent.id) as { active_project_id: string };
    // Stored value is the RESOLVED full UUID, never the truncated ref.
    expect(row.active_project_id).toBe(project.id);
  });

  test("resolves a project by name", () => {
    const agent = registerAgent("focus-name", undefined, undefined, db);
    const project = registerProject("proj-named", "/tmp/proj-named", undefined, db);
    const updated = setAgentFocus(agent.id, "proj-named", db);
    expect(updated).not.toBeNull();
    const row = db.query("SELECT active_project_id FROM agents WHERE id = ?").get(agent.id) as { active_project_id: string };
    expect(row.active_project_id).toBe(project.id);
  });

  test("throws a clean ProjectNotFoundError for an unknown ref (no raw FK leak)", () => {
    const agent = registerAgent("focus-bad", undefined, undefined, db);
    let caught: unknown;
    try {
      setAgentFocus(agent.id, "does-not-exist", db);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProjectNotFoundError);
    expect((caught as Error).message).toBe("project not found: does-not-exist");
    expect((caught as Error).message).not.toMatch(/FOREIGN KEY/i);
    // Focus was NOT mutated by the failed call.
    const row = db.query("SELECT active_project_id FROM agents WHERE id = ?").get(agent.id) as { active_project_id: string | null };
    expect(row.active_project_id).toBeNull();
  });

  test("clears focus when project id is null", () => {
    const agent = registerAgent("focus-clear", undefined, undefined, db);
    const project = registerProject("proj-clear", "/tmp/proj-clear", undefined, db);
    setAgentFocus(agent.id, project.id, db);
    const cleared = setAgentFocus(agent.id, null, db);
    expect(cleared).not.toBeNull();
    const row = db.query("SELECT active_project_id FROM agents WHERE id = ?").get(agent.id) as { active_project_id: string | null };
    expect(row.active_project_id).toBeNull();
  });

  test("returns null for a non-existent agent", () => {
    expect(setAgentFocus("no-such-agent", null, db)).toBeNull();
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
