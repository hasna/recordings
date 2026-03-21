import { type Database } from "bun:sqlite";
import { getDatabase, shortUuid } from "./database.js";
import type {
  Recording,
  CreateRecordingInput,
  RecordingFilter,
} from "../types/index.js";
import { RecordingNotFoundError } from "../types/index.js";

function parseRow(row: Record<string, unknown>): Recording {
  return {
    id: row["id"] as string,
    audio_path: (row["audio_path"] as string) || null,
    raw_text: row["raw_text"] as string,
    processed_text: (row["processed_text"] as string) || null,
    processing_mode: (row["processing_mode"] as Recording["processing_mode"]) || "raw",
    model_used: (row["model_used"] as string) || "gpt-4o-mini-transcribe",
    enhancement_model: (row["enhancement_model"] as string) || null,
    duration_ms: (row["duration_ms"] as number) || 0,
    language: (row["language"] as string) || null,
    tags: JSON.parse((row["tags"] as string) || "[]") as string[],
    agent_id: (row["agent_id"] as string) || null,
    project_id: (row["project_id"] as string) || null,
    session_id: (row["session_id"] as string) || null,
    goal: (row["goal"] as string) || null,
    role: (row["role"] as string) || null,
    task_list_id: (row["task_list_id"] as string) || null,
    metadata: JSON.parse((row["metadata"] as string) || "{}") as Record<string, unknown>,
    created_at: row["created_at"] as string,
  };
}

export function createRecording(
  input: CreateRecordingInput,
  db?: Database
): Recording {
  const d = db || getDatabase();
  const id = crypto.randomUUID();
  const tagsJson = JSON.stringify(input.tags || []);
  const metadataJson = JSON.stringify(input.metadata || {});

  d.query(
    `INSERT INTO recordings (id, audio_path, raw_text, processed_text, processing_mode, model_used, enhancement_model, duration_ms, language, tags, agent_id, project_id, session_id, goal, role, task_list_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.audio_path || null,
    input.raw_text,
    input.processed_text || null,
    input.processing_mode || "raw",
    input.model_used || "gpt-4o-mini-transcribe",
    input.enhancement_model || null,
    input.duration_ms || 0,
    input.language || null,
    tagsJson,
    input.agent_id || null,
    input.project_id || null,
    input.session_id || null,
    input.goal || null,
    input.role || null,
    input.task_list_id || null,
    metadataJson
  );

  // Insert tags into normalized table
  if (input.tags && input.tags.length > 0) {
    const insertTag = d.query(
      "INSERT OR IGNORE INTO recording_tags (recording_id, tag) VALUES (?, ?)"
    );
    for (const tag of input.tags) {
      insertTag.run(id, tag);
    }
  }

  return getRecording(id, d)!;
}

export function getRecording(
  id: string,
  db?: Database
): Recording | null {
  const d = db || getDatabase();

  // Try by ID first
  let row = d
    .query("SELECT * FROM recordings WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;

  // Try by partial ID prefix
  if (!row) {
    row = d
      .query("SELECT * FROM recordings WHERE id LIKE ? || '%'")
      .get(id) as Record<string, unknown> | undefined;
  }

  return row ? parseRow(row) : null;
}

export function listRecordings(
  filter?: RecordingFilter,
  db?: Database
): Recording[] {
  const d = db || getDatabase();
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
      conditions.push(
        "id IN (SELECT recording_id FROM recording_tags WHERE tag = ?)"
      );
      params.push(tag);
    }
  }
  if (filter?.search) {
    conditions.push(
      "(raw_text LIKE ? OR processed_text LIKE ? OR tags LIKE ?)"
    );
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

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filter?.limit || 50;
  const offset = filter?.offset || 0;

  const sql = `SELECT * FROM recordings ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = d.query(sql).all(...params) as Record<string, unknown>[];
  return rows.map(parseRow);
}

export function deleteRecording(
  id: string,
  db?: Database
): boolean {
  const d = db || getDatabase();
  const result = d.query("DELETE FROM recordings WHERE id = ?").run(id);
  return result.changes > 0;
}

export function searchRecordings(
  query: string,
  filter?: RecordingFilter,
  db?: Database
): Recording[] {
  return listRecordings({ ...filter, search: query }, db);
}

export function getRecordingStats(db?: Database): {
  total: number;
  raw: number;
  enhanced: number;
  total_duration_ms: number;
  by_model: Record<string, number>;
} {
  const d = db || getDatabase();

  const total = (
    d.query("SELECT COUNT(*) as c FROM recordings").get() as { c: number }
  ).c;
  const raw = (
    d
      .query(
        "SELECT COUNT(*) as c FROM recordings WHERE processing_mode = 'raw'"
      )
      .get() as { c: number }
  ).c;
  const enhanced = (
    d
      .query(
        "SELECT COUNT(*) as c FROM recordings WHERE processing_mode = 'enhanced'"
      )
      .get() as { c: number }
  ).c;
  const totalDuration = (
    d
      .query("SELECT COALESCE(SUM(duration_ms), 0) as d FROM recordings")
      .get() as { d: number }
  ).d;

  const modelRows = d
    .query(
      "SELECT model_used, COUNT(*) as c FROM recordings GROUP BY model_used"
    )
    .all() as { model_used: string; c: number }[];
  const byModel: Record<string, number> = {};
  for (const row of modelRows) {
    byModel[row.model_used] = row.c;
  }

  return {
    total,
    raw,
    enhanced,
    total_duration_ms: totalDuration,
    by_model: byModel,
  };
}
