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
  createRecording,
  getRecording,
  listRecordings,
  deleteRecording,
  searchRecordings,
  getRecordingStats,
} from "../db/recordings.js";
import type { Recording } from "../types/index.js";
import { type Database } from "bun:sqlite";

let tempDir: string;
let db: Database;

beforeEach(() => {
  resetDatabase();
  tempDir = join(tmpdir(), `open-recordings-test-rec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("createRecording", () => {
  test("creates a recording with minimal input", () => {
    const rec = createRecording({ raw_text: "hello world" }, db);
    expect(rec).toBeDefined();
    expect(rec.id).toBeDefined();
    expect(rec.raw_text).toBe("hello world");
    expect(rec.processing_mode).toBe("raw");
    expect(rec.model_used).toBe("gpt-4o-mini-transcribe");
    expect(rec.tags).toEqual([]);
    expect(rec.metadata).toEqual({});
    expect(rec.audio_path).toBeNull();
    expect(rec.processed_text).toBeNull();
    expect(rec.enhancement_model).toBeNull();
    expect(rec.language).toBeNull();
    expect(rec.agent_id).toBeNull();
    expect(rec.project_id).toBeNull();
    expect(rec.session_id).toBeNull();
    expect(rec.duration_ms).toBe(0);
    expect(rec.created_at).toBeDefined();
  });

  test("creates a recording with all fields", () => {
    const rec = createRecording(
      {
        audio_path: "/tmp/test.wav",
        raw_text: "raw dictation",
        processed_text: "polished text",
        processing_mode: "enhanced",
        model_used: "whisper-1",
        enhancement_model: "gpt-4o",
        duration_ms: 5000,
        language: "en",
        tags: ["meeting", "important"],
        session_id: "sess-1",
        metadata: { source: "cli" },
      },
      db
    );

    expect(rec.audio_path).toBe("/tmp/test.wav");
    expect(rec.raw_text).toBe("raw dictation");
    expect(rec.processed_text).toBe("polished text");
    expect(rec.processing_mode).toBe("enhanced");
    expect(rec.model_used).toBe("whisper-1");
    expect(rec.enhancement_model).toBe("gpt-4o");
    expect(rec.duration_ms).toBe(5000);
    expect(rec.language).toBe("en");
    expect(rec.tags).toEqual(["meeting", "important"]);
    expect(rec.session_id).toBe("sess-1");
    expect(rec.metadata).toEqual({ source: "cli" });
  });

  test("inserts tags into recording_tags table", () => {
    const rec = createRecording(
      { raw_text: "test", tags: ["alpha", "beta"] },
      db
    );
    const tags = db
      .query("SELECT tag FROM recording_tags WHERE recording_id = ? ORDER BY tag")
      .all(rec.id) as { tag: string }[];
    expect(tags.map((t) => t.tag)).toEqual(["alpha", "beta"]);
  });

  test("handles empty tags array", () => {
    const rec = createRecording({ raw_text: "test", tags: [] }, db);
    const tags = db
      .query("SELECT tag FROM recording_tags WHERE recording_id = ?")
      .all(rec.id) as { tag: string }[];
    expect(tags).toHaveLength(0);
  });
});

describe("getRecording", () => {
  test("retrieves a recording by full ID", () => {
    const created = createRecording({ raw_text: "find me" }, db);
    const found = getRecording(created.id, db);
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
    expect(found!.raw_text).toBe("find me");
  });

  test("retrieves a recording by partial ID prefix", () => {
    const created = createRecording({ raw_text: "partial find" }, db);
    const prefix = created.id.substring(0, 8);
    const found = getRecording(prefix, db);
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
  });

  test("returns null for non-existent ID", () => {
    const found = getRecording("nonexistent-id", db);
    expect(found).toBeNull();
  });
});

describe("listRecordings", () => {
  test("returns all recordings ordered by created_at DESC", () => {
    createRecording({ raw_text: "first" }, db);
    createRecording({ raw_text: "second" }, db);
    createRecording({ raw_text: "third" }, db);

    const list = listRecordings(undefined, db);
    expect(list).toHaveLength(3);
    // Most recent first
    expect(list[0]!.raw_text).toBe("third");
    expect(list[2]!.raw_text).toBe("first");
  });

  test("returns empty array when no recordings", () => {
    const list = listRecordings(undefined, db);
    expect(list).toEqual([]);
  });

  test("filters by processing_mode", () => {
    createRecording({ raw_text: "raw one" }, db);
    createRecording({ raw_text: "enhanced one", processing_mode: "enhanced" }, db);

    const raw = listRecordings({ processing_mode: "raw" }, db);
    expect(raw).toHaveLength(1);
    expect(raw[0]!.raw_text).toBe("raw one");

    const enhanced = listRecordings({ processing_mode: "enhanced" }, db);
    expect(enhanced).toHaveLength(1);
    expect(enhanced[0]!.raw_text).toBe("enhanced one");
  });

  test("filters by session_id", () => {
    createRecording({ raw_text: "sess1", session_id: "s1" }, db);
    createRecording({ raw_text: "sess2", session_id: "s2" }, db);

    const results = listRecordings({ session_id: "s1" }, db);
    expect(results).toHaveLength(1);
    expect(results[0]!.raw_text).toBe("sess1");
  });

  test("filters by tags", () => {
    createRecording({ raw_text: "tagged", tags: ["important", "meeting"] }, db);
    createRecording({ raw_text: "other", tags: ["casual"] }, db);

    const results = listRecordings({ tags: ["important"] }, db);
    expect(results).toHaveLength(1);
    expect(results[0]!.raw_text).toBe("tagged");
  });

  test("filters by multiple tags (AND logic)", () => {
    createRecording({ raw_text: "both", tags: ["a", "b"] }, db);
    createRecording({ raw_text: "only-a", tags: ["a"] }, db);

    const results = listRecordings({ tags: ["a", "b"] }, db);
    expect(results).toHaveLength(1);
    expect(results[0]!.raw_text).toBe("both");
  });

  test("filters by search text", () => {
    createRecording({ raw_text: "the quick brown fox" }, db);
    createRecording({ raw_text: "lazy dog" }, db);

    const results = listRecordings({ search: "brown fox" }, db);
    expect(results).toHaveLength(1);
    expect(results[0]!.raw_text).toBe("the quick brown fox");
  });

  test("search matches processed_text", () => {
    createRecording({ raw_text: "raw", processed_text: "polished golden text" }, db);
    createRecording({ raw_text: "other" }, db);

    const results = listRecordings({ search: "golden" }, db);
    expect(results).toHaveLength(1);
    expect(results[0]!.processed_text).toBe("polished golden text");
  });

  test("filters by since date", () => {
    const rec = createRecording({ raw_text: "recent" }, db);
    const results = listRecordings({ since: "2000-01-01" }, db);
    expect(results).toHaveLength(1);

    const noResults = listRecordings({ since: "2099-01-01" }, db);
    expect(noResults).toHaveLength(0);
  });

  test("filters by until date", () => {
    createRecording({ raw_text: "old" }, db);
    const results = listRecordings({ until: "2099-01-01" }, db);
    expect(results).toHaveLength(1);

    const noResults = listRecordings({ until: "2000-01-01" }, db);
    expect(noResults).toHaveLength(0);
  });

  test("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      createRecording({ raw_text: `rec-${i}` }, db);
    }
    const results = listRecordings({ limit: 3 }, db);
    expect(results).toHaveLength(3);
  });

  test("respects offset", () => {
    for (let i = 0; i < 5; i++) {
      createRecording({ raw_text: `rec-${i}` }, db);
    }
    const results = listRecordings({ limit: 2, offset: 2 }, db);
    expect(results).toHaveLength(2);
  });

  test("filters by agent_id", () => {
    // Create an agent first
    db.query("INSERT INTO agents (id, name, created_at, last_seen_at) VALUES (?, ?, ?, ?)").run(
      "agent-1", "maximus", new Date().toISOString(), new Date().toISOString()
    );
    createRecording({ raw_text: "by agent", agent_id: "agent-1" }, db);
    createRecording({ raw_text: "no agent" }, db);

    const results = listRecordings({ agent_id: "agent-1" }, db);
    expect(results).toHaveLength(1);
    expect(results[0]!.raw_text).toBe("by agent");
  });

  test("filters by project_id", () => {
    db.query("INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      "proj-1", "my-project", "/tmp/proj", new Date().toISOString(), new Date().toISOString()
    );
    createRecording({ raw_text: "in project", project_id: "proj-1" }, db);
    createRecording({ raw_text: "no project" }, db);

    const results = listRecordings({ project_id: "proj-1" }, db);
    expect(results).toHaveLength(1);
    expect(results[0]!.raw_text).toBe("in project");
  });

  test("default limit is 50", () => {
    for (let i = 0; i < 60; i++) {
      createRecording({ raw_text: `rec-${i}` }, db);
    }
    const results = listRecordings(undefined, db);
    expect(results).toHaveLength(50);
  });
});

describe("deleteRecording", () => {
  test("deletes an existing recording and returns true", () => {
    const rec = createRecording({ raw_text: "delete me" }, db);
    const result = deleteRecording(rec.id, db);
    expect(result).toBe(true);
    expect(getRecording(rec.id, db)).toBeNull();
  });

  test("returns false for non-existent recording", () => {
    const result = deleteRecording("nonexistent", db);
    expect(result).toBe(false);
  });

  test("cascades tag deletion", () => {
    const rec = createRecording({ raw_text: "tagged", tags: ["a", "b"] }, db);
    deleteRecording(rec.id, db);
    const tags = db
      .query("SELECT * FROM recording_tags WHERE recording_id = ?")
      .all(rec.id) as unknown[];
    expect(tags).toHaveLength(0);
  });
});

describe("searchRecordings", () => {
  test("delegates to listRecordings with search filter", () => {
    createRecording({ raw_text: "searchable content here" }, db);
    createRecording({ raw_text: "nothing special" }, db);

    const results = searchRecordings("searchable", undefined, db);
    expect(results).toHaveLength(1);
    expect(results[0]!.raw_text).toBe("searchable content here");
  });

  test("combines search with other filters", () => {
    createRecording({ raw_text: "meeting notes alpha", session_id: "s1" }, db);
    createRecording({ raw_text: "meeting notes beta", session_id: "s2" }, db);

    const results = searchRecordings("meeting", { session_id: "s1" }, db);
    expect(results).toHaveLength(1);
    expect(results[0]!.raw_text).toBe("meeting notes alpha");
  });
});

describe("getRecordingStats", () => {
  test("returns zero stats when empty", () => {
    const stats = getRecordingStats(db);
    expect(stats.total).toBe(0);
    expect(stats.raw).toBe(0);
    expect(stats.enhanced).toBe(0);
    expect(stats.total_duration_ms).toBe(0);
    expect(stats.by_model).toEqual({});
  });

  test("counts totals correctly", () => {
    createRecording({ raw_text: "one", duration_ms: 1000 }, db);
    createRecording({ raw_text: "two", duration_ms: 2000, processing_mode: "enhanced" }, db);
    createRecording({ raw_text: "three", duration_ms: 3000 }, db);

    const stats = getRecordingStats(db);
    expect(stats.total).toBe(3);
    expect(stats.raw).toBe(2);
    expect(stats.enhanced).toBe(1);
    expect(stats.total_duration_ms).toBe(6000);
  });

  test("groups by model correctly", () => {
    createRecording({ raw_text: "a", model_used: "whisper-1" }, db);
    createRecording({ raw_text: "b", model_used: "whisper-1" }, db);
    createRecording({ raw_text: "c", model_used: "gpt-4o-mini-transcribe" }, db);

    const stats = getRecordingStats(db);
    expect(stats.by_model["whisper-1"]).toBe(2);
    expect(stats.by_model["gpt-4o-mini-transcribe"]).toBe(1);
  });
});
