/**
 * PostgreSQL migrations for open-recordings cloud sync.
 *
 * Equivalent to the SQLite schema in database.ts, translated for PostgreSQL.
 */

export const PG_MIGRATIONS: string[] = [
  // Migration 0: Initial schema — projects, agents, recordings, recording_tags
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT UNIQUE NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    updated_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    role TEXT DEFAULT 'agent',
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    last_seen_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS recordings (
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
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS recording_tags (
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (recording_id, tag)
  )`,

  `CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE INDEX IF NOT EXISTS idx_recordings_agent ON recordings(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recordings_project ON recordings(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recordings_session ON recordings(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recordings_created ON recordings(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_recordings_mode ON recordings(processing_mode)`,
  `CREATE INDEX IF NOT EXISTS idx_recording_tags_tag ON recording_tags(tag)`,

  // Migration 2: session tagging attributes
  `ALTER TABLE recordings ADD COLUMN IF NOT EXISTS goal TEXT`,
  `ALTER TABLE recordings ADD COLUMN IF NOT EXISTS role TEXT`,
  `ALTER TABLE recordings ADD COLUMN IF NOT EXISTS task_list_id TEXT`,

  // Migration 3: feedback table
  `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    message TEXT NOT NULL,
    email TEXT,
    category TEXT DEFAULT 'general',
    version TEXT,
    machine_id TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  // Migration 4: agent focus
  `ALTER TABLE agents ADD COLUMN IF NOT EXISTS active_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`,
];
