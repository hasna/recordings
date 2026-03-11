import { type Database } from "bun:sqlite";
import { getDatabase } from "./database.js";
import type { Project } from "../types/index.js";

function parseProject(row: Record<string, unknown>): Project {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    path: row["path"] as string,
    description: (row["description"] as string) || null,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
  };
}

export function registerProject(
  name: string,
  path: string,
  description?: string,
  db?: Database
): Project {
  const d = db || getDatabase();
  const now = new Date().toISOString();

  // Check if project exists by path (idempotent)
  const existing = d
    .query("SELECT * FROM projects WHERE path = ?")
    .get(path) as Record<string, unknown> | undefined;

  if (existing) {
    d.query("UPDATE projects SET updated_at = ? WHERE id = ?").run(
      now,
      existing["id"] as string
    );
    return getProject(existing["id"] as string, d)!;
  }

  const id = crypto.randomUUID();
  d.query(
    "INSERT INTO projects (id, name, path, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, name, path, description || null, now, now);

  return getProject(id, d)!;
}

export function getProject(
  idOrPath: string,
  db?: Database
): Project | null {
  const d = db || getDatabase();

  let row = d
    .query("SELECT * FROM projects WHERE id = ?")
    .get(idOrPath) as Record<string, unknown> | undefined;

  if (!row) {
    row = d
      .query("SELECT * FROM projects WHERE path = ?")
      .get(idOrPath) as Record<string, unknown> | undefined;
  }

  return row ? parseProject(row) : null;
}

export function listProjects(db?: Database): Project[] {
  const d = db || getDatabase();
  const rows = d
    .query("SELECT * FROM projects ORDER BY updated_at DESC")
    .all() as Record<string, unknown>[];
  return rows.map(parseProject);
}
