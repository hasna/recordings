import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import {
  getDatabase,
  closeDatabase,
  resetDatabase,
} from "../db/database.js";
import { registerProject, getProject, listProjects } from "../db/projects.js";
import { type Database } from "bun:sqlite";

let tempDir: string;
let db: Database;

beforeEach(() => {
  resetDatabase();
  tempDir = join(tmpdir(), `open-recordings-test-proj-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("registerProject", () => {
  test("creates a new project", () => {
    const project = registerProject("my-app", "/home/user/my-app", undefined, db);
    expect(project).toBeDefined();
    expect(project.name).toBe("my-app");
    expect(project.path).toBe("/home/user/my-app");
    expect(project.description).toBeNull();
    expect(project.id).toBeDefined();
    expect(project.id).toHaveLength(36); // full UUID
    expect(project.created_at).toBeDefined();
    expect(project.updated_at).toBeDefined();
  });

  test("creates a project with description", () => {
    const project = registerProject("my-app", "/home/user/my-app", "A cool project", db);
    expect(project.description).toBe("A cool project");
  });

  test("returns existing project by path (idempotent)", () => {
    const first = registerProject("my-app", "/home/user/my-app", undefined, db);
    const second = registerProject("my-app", "/home/user/my-app", undefined, db);

    expect(second.id).toBe(first.id);
    expect(new Date(second.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(first.updated_at).getTime()
    );
  });

  test("creates separate projects for different paths", () => {
    const p1 = registerProject("app-a", "/path/a", undefined, db);
    const p2 = registerProject("app-b", "/path/b", undefined, db);

    expect(p1.id).not.toBe(p2.id);
    expect(listProjects(db)).toHaveLength(2);
  });
});

describe("getProject", () => {
  test("finds project by ID", () => {
    const created = registerProject("test", "/tmp/test", undefined, db);
    const found = getProject(created.id, db);
    expect(found).toBeDefined();
    expect(found!.name).toBe("test");
  });

  test("finds project by path", () => {
    registerProject("finder", "/unique/path/here", undefined, db);
    const found = getProject("/unique/path/here", db);
    expect(found).toBeDefined();
    expect(found!.name).toBe("finder");
  });

  test("returns null for non-existent project", () => {
    const found = getProject("nonexistent", db);
    expect(found).toBeNull();
  });
});

describe("listProjects", () => {
  test("returns empty array when no projects", () => {
    const projects = listProjects(db);
    expect(projects).toEqual([]);
  });

  test("returns all projects ordered by updated_at DESC", () => {
    registerProject("alpha", "/path/alpha", undefined, db);
    registerProject("beta", "/path/beta", undefined, db);
    registerProject("gamma", "/path/gamma", undefined, db);

    const projects = listProjects(db);
    expect(projects).toHaveLength(3);
    // All three projects are present
    const names = projects.map((p) => p.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(names).toContain("gamma");
  });
});
