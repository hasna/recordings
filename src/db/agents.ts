import { type Database } from "bun:sqlite";
import { getDatabase, shortUuid } from "./database.js";
import type { Agent } from "../types/index.js";

function parseAgent(row: Record<string, unknown>): Agent {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    description: (row["description"] as string) || null,
    role: (row["role"] as string) || "agent",
    metadata: JSON.parse((row["metadata"] as string) || "{}") as Record<string, unknown>,
    created_at: row["created_at"] as string,
    last_seen_at: row["last_seen_at"] as string,
  };
}

export function registerAgent(
  name: string,
  description?: string,
  role?: string,
  db?: Database
): Agent {
  const d = db || getDatabase();
  const now = new Date().toISOString();

  // Check if agent exists by name
  const existing = d
    .query("SELECT * FROM agents WHERE name = ?")
    .get(name) as Record<string, unknown> | undefined;

  if (existing) {
    d.query("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(
      now,
      existing["id"] as string
    );
    return getAgent(existing["id"] as string, d)!;
  }

  const id = shortUuid();
  d.query(
    "INSERT INTO agents (id, name, description, role, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, name, description || null, role || "agent", now, now);

  return getAgent(id, d)!;
}

export function getAgent(
  idOrName: string,
  db?: Database
): Agent | null {
  const d = db || getDatabase();

  // Try by ID
  let row = d
    .query("SELECT * FROM agents WHERE id = ?")
    .get(idOrName) as Record<string, unknown> | undefined;

  // Try by name
  if (!row) {
    row = d
      .query("SELECT * FROM agents WHERE name = ?")
      .get(idOrName) as Record<string, unknown> | undefined;
  }

  // Try by partial ID prefix
  if (!row) {
    row = d
      .query("SELECT * FROM agents WHERE id LIKE ? || '%'")
      .get(idOrName) as Record<string, unknown> | undefined;
  }

  return row ? parseAgent(row) : null;
}

export function listAgents(db?: Database): Agent[] {
  const d = db || getDatabase();
  const rows = d
    .query("SELECT * FROM agents ORDER BY last_seen_at DESC")
    .all() as Record<string, unknown>[];
  return rows.map(parseAgent);
}
