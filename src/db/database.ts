import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { loadConfig } from "../lib/config.js";

let _db: Database | null = null;

const MIGRATIONS = [
  // Migration 0: Initial schema
  `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT UNIQUE NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    role TEXT DEFAULT 'agent',
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    audio_path TEXT,
    raw_text TEXT NOT NULL,
    processed_text TEXT,
    processing_mode TEXT NOT NULL DEFAULT 'raw' CHECK(processing_mode IN ('raw', 'enhanced')),
    model_used TEXT NOT NULL DEFAULT 'gpt-4o-mini-transcribe',
    enhancement_model TEXT,
    duration_ms INTEGER DEFAULT 0,
    language TEXT,
    tags TEXT DEFAULT '[]',
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    session_id TEXT,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS recording_tags (
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (recording_id, tag)
  );

  CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_recordings_agent ON recordings(agent_id);
  CREATE INDEX IF NOT EXISTS idx_recordings_project ON recordings(project_id);
  CREATE INDEX IF NOT EXISTS idx_recordings_session ON recordings(session_id);
  CREATE INDEX IF NOT EXISTS idx_recordings_created ON recordings(created_at);
  CREATE INDEX IF NOT EXISTS idx_recordings_mode ON recordings(processing_mode);
  CREATE INDEX IF NOT EXISTS idx_recording_tags_tag ON recording_tags(tag);
  `,

  // Migration 2: session tagging attributes
  `
  ALTER TABLE recordings ADD COLUMN goal TEXT;
  ALTER TABLE recordings ADD COLUMN role TEXT;
  ALTER TABLE recordings ADD COLUMN task_list_id TEXT;
  INSERT OR IGNORE INTO _migrations (id) VALUES (2);
  `,
];

export function getDatabase(dbPath?: string): Database {
  if (_db) return _db;

  const path = dbPath || loadConfig().db_path;

  // Ensure directory exists
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  _db = new Database(path, { create: true });

  // Pragmas for production SQLite
  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA busy_timeout = 5000");
  _db.run("PRAGMA foreign_keys = ON");

  runMigrations(_db);
  return _db;
}

function runMigrations(db: Database): void {
  // Ensure _migrations table exists
  db.run(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const result = db
    .query("SELECT MAX(id) as max_id FROM _migrations")
    .get() as { max_id: number | null } | null;

  const currentLevel = result?.max_id ?? -1;

  for (let i = currentLevel + 1; i < MIGRATIONS.length; i++) {
    db.run(MIGRATIONS[i]!);
    db.query("INSERT INTO _migrations (id) VALUES (?)").run(i);
  }
}

export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function resetDatabase(): void {
  _db = null;
}

export function getDbPath(): string {
  return loadConfig().db_path;
}

export function shortUuid(): string {
  return crypto.randomUUID().slice(0, 8);
}
