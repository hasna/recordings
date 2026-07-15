-- @hasna/recordings cloud (RDS) schema — canonical DDL.
-- Applied idempotently by `recordings-serve migrate` (src/server/cloud.ts ensureCloudSchema).
-- Migrations are idempotent and retain table data. Migration 18 replaces the
-- idempotency foreign key in place. The api_keys table is created by the
-- @hasna/contracts ApiKeyStore.ensureSchema() at migrate time.

CREATE TABLE IF NOT EXISTS _pg_migrations (id SERIAL PRIMARY KEY, version INT UNIQUE NOT NULL, applied_at TIMESTAMPTZ DEFAULT NOW());

-- migration 0
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT UNIQUE NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    updated_at TEXT NOT NULL DEFAULT NOW()::text
  );

-- migration 1
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    role TEXT DEFAULT 'agent',
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    last_seen_at TEXT NOT NULL DEFAULT NOW()::text
  );

-- migration 2
CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    audio_path TEXT,
    raw_text TEXT NOT NULL,
    processed_text TEXT,
    processing_mode TEXT NOT NULL DEFAULT 'raw' CHECK(processing_mode IN ('raw', 'enhanced')),
    model_used TEXT NOT NULL DEFAULT 'gpt-4o-transcribe',
    enhancement_model TEXT,
    duration_ms INTEGER DEFAULT 0,
    language TEXT,
    tags TEXT DEFAULT '[]',
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    session_id TEXT,
    machine_id TEXT,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT NOW()::text
  );

-- migration 3
CREATE TABLE IF NOT EXISTS recording_tags (
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (recording_id, tag)
  );

-- migration 4
CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT NOW()::text
  );

-- migration 5
CREATE INDEX IF NOT EXISTS idx_recordings_agent ON recordings(agent_id);

-- migration 6
CREATE INDEX IF NOT EXISTS idx_recordings_project ON recordings(project_id);

-- migration 7
CREATE INDEX IF NOT EXISTS idx_recordings_session ON recordings(session_id);

-- migration 8
CREATE INDEX IF NOT EXISTS idx_recordings_created ON recordings(created_at);

-- migration 9
CREATE INDEX IF NOT EXISTS idx_recordings_mode ON recordings(processing_mode);

-- migration 10
CREATE INDEX IF NOT EXISTS idx_recording_tags_tag ON recording_tags(tag);

-- migration 11
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS goal TEXT;

-- migration 12
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS role TEXT;

-- migration 13
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS task_list_id TEXT;

-- migration 14
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS machine_id TEXT;

-- migration 15
CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    message TEXT NOT NULL,
    email TEXT,
    category TEXT DEFAULT 'general',
    version TEXT,
    machine_id TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  );

-- migration 16
ALTER TABLE agents ADD COLUMN IF NOT EXISTS active_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;

-- migration 17
CREATE TABLE IF NOT EXISTS recording_idempotency (
    principal TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    recording_id TEXT NOT NULL UNIQUE REFERENCES recordings(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    PRIMARY KEY (principal, idempotency_key)
  );

-- migration 18
ALTER TABLE recording_idempotency
  DROP CONSTRAINT IF EXISTS recording_idempotency_recording_id_fkey;
ALTER TABLE recording_idempotency
  ALTER COLUMN recording_id DROP NOT NULL;
ALTER TABLE recording_idempotency
  ADD CONSTRAINT recording_idempotency_recording_id_fkey
  FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE SET NULL;
