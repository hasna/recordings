/**
 * Postgres-native repository for `recordings-serve` (A1 pure-remote).
 *
 * These functions mirror the local SQLite CRUD in `src/db/*.ts` but run against
 * the shared cloud Postgres DIRECTLY through the repo's own async adapter
 * (`PgAdapterAsync`) — there is NO local sync/cache in the service. The SQL uses
 * `?` placeholders (the adapter translates them to `$n`) and Postgres-native
 * upsert (`ON CONFLICT`) instead of SQLite's `INSERT OR IGNORE`.
 *
 * This is a real wrapper over the same relational schema the core lib uses
 * (`PG_MIGRATIONS`); it shares the domain types and the row-parsing shape. No
 * stubs — every operation executes real SQL.
 */
import type { PgAdapterAsync } from "../db/remote-storage.js";
import { ProjectNotFoundError, ValidationError } from "../db/errors.js";
import type {
  Recording,
  CreateRecordingInput,
  RecordingFilter,
  Agent,
  Project,
} from "../types/index.js";

// Re-exported so `/v1` route code can `import * as repo` and reference
// `repo.ProjectNotFoundError` when mapping a bad focus ref to a clean 400.
export { ProjectNotFoundError, ValidationError };

function shortUuid(): string {
  return crypto.randomUUID().slice(0, 8);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "object") return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function parseRecording(row: Record<string, unknown>): Recording {
  return {
    id: row["id"] as string,
    audio_path: (row["audio_path"] as string) || null,
    raw_text: row["raw_text"] as string,
    processed_text: (row["processed_text"] as string) || null,
    processing_mode: (row["processing_mode"] as Recording["processing_mode"]) || "raw",
    model_used: (row["model_used"] as string) || "gpt-4o-transcribe",
    enhancement_model: (row["enhancement_model"] as string) || null,
    duration_ms: Number(row["duration_ms"] ?? 0),
    language: (row["language"] as string) || null,
    tags: parseJson<string[]>(row["tags"], []),
    agent_id: (row["agent_id"] as string) || null,
    project_id: (row["project_id"] as string) || null,
    session_id: (row["session_id"] as string) || null,
    goal: (row["goal"] as string) || null,
    role: (row["role"] as string) || null,
    task_list_id: (row["task_list_id"] as string) || null,
    machine_id: (row["machine_id"] as string) || null,
    metadata: parseJson<Record<string, unknown>>(row["metadata"], {}),
    created_at: row["created_at"] as string,
  };
}

function parseAgent(row: Record<string, unknown>): Agent {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    description: (row["description"] as string) || null,
    role: (row["role"] as string) || "agent",
    metadata: parseJson<Record<string, unknown>>(row["metadata"], {}),
    created_at: row["created_at"] as string,
    last_seen_at: row["last_seen_at"] as string,
  };
}

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

// ── Recordings ────────────────────────────────────────────────────────────────

export async function createRecording(
  pg: PgAdapterAsync,
  input: CreateRecordingInput,
): Promise<Recording> {
  if (typeof input.raw_text !== "string" || !input.raw_text) {
    throw new ValidationError("raw_text is required");
  }

  // Resolve the agent_id/project_id references BEFORE inserting so an unresolved
  // name (or a truncated id-prefix) never trips the recordings.agent_id /
  // recordings.project_id foreign keys and 500s. On local SQLite the FK is not
  // enforced so a dangling ref just stores; on the cloud Postgres it must be a
  // real PK. Postgres enforces FKs, so we normalize the client-supplied ref to
  // an existing row here (mirroring the id/name/prefix widening the lookups use).
  let resolvedAgentId: string | null = null;
  if (input.agent_id) {
    const agent = await getAgent(pg, input.agent_id);
    // A first-time agent name/id that isn't registered yet is self-registered
    // (idempotent, same semantics as register_agent) so `--agent <name> save`
    // just works instead of erroring on a missing agent.
    resolvedAgentId = agent ? agent.id : (await registerAgent(pg, input.agent_id)).id;
  }
  let resolvedProjectId: string | null = null;
  if (input.project_id) {
    const project = await getProject(pg, input.project_id);
    // A project can't be materialized from a bare ref (it needs a path), so an
    // unknown project ref fails cleanly as a 400 instead of leaking the raw FK.
    if (!project) throw new ProjectNotFoundError(input.project_id);
    resolvedProjectId = project.id;
  }

  const id = shortUuid();
  await pg.run(
    `INSERT INTO recordings (id, audio_path, raw_text, processed_text, processing_mode, model_used, enhancement_model, duration_ms, language, tags, agent_id, project_id, session_id, goal, role, task_list_id, machine_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.audio_path || null,
    input.raw_text,
    input.processed_text || null,
    input.processing_mode || "raw",
    input.model_used || "gpt-4o-transcribe",
    input.enhancement_model || null,
    input.duration_ms || 0,
    input.language || null,
    JSON.stringify(input.tags || []),
    resolvedAgentId,
    resolvedProjectId,
    input.session_id || null,
    input.goal || null,
    input.role || null,
    input.task_list_id || null,
    input.machine_id || null,
    JSON.stringify(input.metadata || {}),
  );

  if (input.tags && input.tags.length > 0) {
    for (const tag of input.tags) {
      await pg.run(
        "INSERT INTO recording_tags (recording_id, tag) VALUES (?, ?) ON CONFLICT DO NOTHING",
        id,
        tag,
      );
    }
  }

  const created = await getRecording(pg, id);
  if (!created) throw new Error("failed to read back created recording");
  return created;
}

export async function getRecording(
  pg: PgAdapterAsync,
  id: string,
): Promise<Recording | null> {
  let row = (await pg.get("SELECT * FROM recordings WHERE id = ?", id)) as
    | Record<string, unknown>
    | null;
  if (!row) {
    row = (await pg.get("SELECT * FROM recordings WHERE id LIKE ? || '%'", id)) as
      | Record<string, unknown>
      | null;
  }
  return row ? parseRecording(row) : null;
}

export async function listRecordings(
  pg: PgAdapterAsync,
  filter?: RecordingFilter,
): Promise<Recording[]> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filter?.agent_id) {
    conditions.push("agent_id = ?");
    params.push(filter.agent_id);
  }
  if (filter?.project_id) {
    conditions.push("project_id = ?");
    params.push(filter.project_id);
  }
  if (filter?.session_id) {
    conditions.push("session_id = ?");
    params.push(filter.session_id);
  }
  if (filter?.processing_mode) {
    conditions.push("processing_mode = ?");
    params.push(filter.processing_mode);
  }
  if (filter?.tags && filter.tags.length > 0) {
    for (const tag of filter.tags) {
      conditions.push("id IN (SELECT recording_id FROM recording_tags WHERE tag = ?)");
      params.push(tag);
    }
  }
  if (filter?.search) {
    conditions.push("(raw_text ILIKE ? OR processed_text ILIKE ? OR tags ILIKE ?)");
    const q = `%${filter.search}%`;
    params.push(q, q, q);
  }
  if (filter?.since) {
    conditions.push("created_at >= ?");
    params.push(filter.since);
  }
  if (filter?.until) {
    conditions.push("created_at <= ?");
    params.push(filter.until);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(Math.max(Number(filter?.limit) || 50, 1), 500);
  const offset = Math.max(Number(filter?.offset) || 0, 0);
  params.push(limit, offset);

  const sql = `SELECT * FROM recordings ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  const rows = (await pg.all(sql, ...params)) as Record<string, unknown>[];
  return rows.map(parseRecording);
}

export async function deleteRecording(
  pg: PgAdapterAsync,
  id: string,
): Promise<boolean> {
  // Resolve prefix ids the same way getRecording does, so DELETE matches GET.
  const existing = await getRecording(pg, id);
  if (!existing) return false;
  const result = await pg.run("DELETE FROM recordings WHERE id = ?", existing.id);
  return result.changes > 0;
}

export async function searchRecordings(
  pg: PgAdapterAsync,
  query: string,
  filter?: RecordingFilter,
): Promise<Recording[]> {
  return listRecordings(pg, { ...filter, search: query });
}

export async function getRecordingStats(pg: PgAdapterAsync): Promise<{
  total: number;
  raw: number;
  enhanced: number;
  total_duration_ms: number;
  by_model: Record<string, number>;
}> {
  const total = Number(
    ((await pg.get("SELECT COUNT(*) as c FROM recordings")) as { c: number }).c,
  );
  const raw = Number(
    ((await pg.get("SELECT COUNT(*) as c FROM recordings WHERE processing_mode = 'raw'")) as {
      c: number;
    }).c,
  );
  const enhanced = Number(
    ((await pg.get("SELECT COUNT(*) as c FROM recordings WHERE processing_mode = 'enhanced'")) as {
      c: number;
    }).c,
  );
  const totalDuration = Number(
    ((await pg.get("SELECT COALESCE(SUM(duration_ms), 0) as d FROM recordings")) as {
      d: number;
    }).d,
  );
  const modelRows = (await pg.all(
    "SELECT model_used, COUNT(*) as c FROM recordings GROUP BY model_used",
  )) as { model_used: string; c: number }[];
  const byModel: Record<string, number> = {};
  for (const row of modelRows) byModel[row.model_used] = Number(row.c);

  return { total, raw, enhanced, total_duration_ms: totalDuration, by_model: byModel };
}

// ── Agents ────────────────────────────────────────────────────────────────────

export async function registerAgent(
  pg: PgAdapterAsync,
  name: string,
  description?: string | null,
  role?: string | null,
): Promise<Agent> {
  if (!name) throw new ValidationError("name is required");
  const now = new Date().toISOString();
  const existing = (await pg.get("SELECT * FROM agents WHERE name = ?", name)) as
    | Record<string, unknown>
    | null;
  if (existing) {
    await pg.run("UPDATE agents SET last_seen_at = ? WHERE id = ?", now, existing["id"]);
    return (await getAgent(pg, existing["id"] as string))!;
  }
  const id = shortUuid();
  await pg.run(
    "INSERT INTO agents (id, name, description, role, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    name,
    description || null,
    role || "agent",
    now,
    now,
  );
  return (await getAgent(pg, id))!;
}

export async function getAgent(
  pg: PgAdapterAsync,
  idOrName: string,
): Promise<Agent | null> {
  let row = (await pg.get("SELECT * FROM agents WHERE id = ?", idOrName)) as
    | Record<string, unknown>
    | null;
  if (!row) {
    row = (await pg.get("SELECT * FROM agents WHERE name = ?", idOrName)) as
      | Record<string, unknown>
      | null;
  }
  if (!row) {
    row = (await pg.get("SELECT * FROM agents WHERE id LIKE ? || '%'", idOrName)) as
      | Record<string, unknown>
      | null;
  }
  return row ? parseAgent(row) : null;
}

export async function listAgents(pg: PgAdapterAsync): Promise<Agent[]> {
  const rows = (await pg.all(
    "SELECT * FROM agents ORDER BY last_seen_at DESC",
  )) as Record<string, unknown>[];
  return rows.map(parseAgent);
}

export async function heartbeatAgent(
  pg: PgAdapterAsync,
  idOrName: string,
): Promise<Agent | null> {
  const agent = await getAgent(pg, idOrName);
  if (!agent) return null;
  await pg.run(
    "UPDATE agents SET last_seen_at = ? WHERE id = ?",
    new Date().toISOString(),
    agent.id,
  );
  return getAgent(pg, agent.id);
}

export async function setAgentFocus(
  pg: PgAdapterAsync,
  idOrName: string,
  projectId: string | null,
): Promise<Agent | null> {
  const agent = await getAgent(pg, idOrName);
  if (!agent) return null;
  // Resolve the project reference (full UUID, truncated prefix, path, or name)
  // to the real primary key BEFORE writing, so the truncated id the tools
  // surface works and an unknown ref fails cleanly instead of tripping the
  // active_project_id foreign key and leaking the raw DB error.
  let resolvedProjectId: string | null = null;
  if (projectId) {
    const project = await getProject(pg, projectId);
    if (!project) throw new ProjectNotFoundError(projectId);
    resolvedProjectId = project.id;
  }
  await pg.run(
    "UPDATE agents SET active_project_id = ?, last_seen_at = ? WHERE id = ?",
    resolvedProjectId,
    new Date().toISOString(),
    agent.id,
  );
  return getAgent(pg, agent.id);
}

// ── Projects ────────────────────────────────────────────────────────────────

export async function registerProject(
  pg: PgAdapterAsync,
  name: string,
  path: string,
  description?: string | null,
): Promise<Project> {
  if (!name || !path) throw new ValidationError("name and path are required");
  const now = new Date().toISOString();
  const existing = (await pg.get("SELECT * FROM projects WHERE path = ?", path)) as
    | Record<string, unknown>
    | null;
  if (existing) {
    await pg.run("UPDATE projects SET updated_at = ? WHERE id = ?", now, existing["id"]);
    return (await getProject(pg, existing["id"] as string))!;
  }
  const id = crypto.randomUUID();
  await pg.run(
    "INSERT INTO projects (id, name, path, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    name,
    path,
    description || null,
    now,
    now,
  );
  return (await getProject(pg, id))!;
}

export async function getProject(
  pg: PgAdapterAsync,
  idOrPath: string,
): Promise<Project | null> {
  // Resolve in the same widening order the recordings/agents lookups use so a
  // full id, path, name, or truncated id-prefix (what list/register surface)
  // all resolve to the same row.
  let row = (await pg.get("SELECT * FROM projects WHERE id = ?", idOrPath)) as
    | Record<string, unknown>
    | null;
  if (!row) {
    row = (await pg.get("SELECT * FROM projects WHERE path = ?", idOrPath)) as
      | Record<string, unknown>
      | null;
  }
  if (!row) {
    row = (await pg.get("SELECT * FROM projects WHERE name = ?", idOrPath)) as
      | Record<string, unknown>
      | null;
  }
  if (!row && idOrPath) {
    row = (await pg.get("SELECT * FROM projects WHERE id LIKE ? || '%'", idOrPath)) as
      | Record<string, unknown>
      | null;
  }
  return row ? parseProject(row) : null;
}

export async function listProjects(pg: PgAdapterAsync): Promise<Project[]> {
  const rows = (await pg.all(
    "SELECT * FROM projects ORDER BY updated_at DESC",
  )) as Record<string, unknown>[];
  return rows.map(parseProject);
}

// ── Feedback ──────────────────────────────────────────────────────────────────

export async function saveFeedback(
  pg: PgAdapterAsync,
  input: { message: string; email?: string | null; category?: string | null; version?: string | null },
): Promise<{ saved: true }> {
  if (typeof input.message !== "string" || !input.message.trim()) {
    throw new ValidationError("message is required");
  }
  await pg.run(
    "INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)",
    input.message,
    input.email || null,
    input.category || "general",
    input.version || null,
  );
  return { saved: true };
}
