import { describe, expect, test, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  describeActiveStore,
  probeRecordingPersistence,
  AUTO_FLIP_MODE_SOURCE,
  PERSISTENCE_PROBE_TAG,
} from "../lib/persistence-probe.js";
import type { Store } from "../store.js";
import type { CreateRecordingInput, Recording, RecordingsConfig } from "../types/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "recordings-persistence-probe-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeConfig(dbPath: string): RecordingsConfig {
  return { db_path: dbPath } as unknown as RecordingsConfig;
}

/** A legacy on-box SQLite file holding rows, as left behind by a local-mode period. */
function seedLocalDb(dbPath: string, rows: number): void {
  const db = new Database(dbPath);
  db.run("CREATE TABLE recordings (id TEXT PRIMARY KEY, raw_text TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO recordings (id, raw_text) VALUES (?, ?)");
  // One transaction: a per-row commit costs a disk sync each and made this
  // fixture take 14 seconds for a realistic row count.
  db.transaction(() => {
    for (let index = 0; index < rows; index++) {
      insert.run(`row-${index}`, `transcript ${index}`);
    }
  })();
  db.close();
}

// A distinctive value so a leak into the report is unmistakable in an assertion.
const FAKE_API_KEY = "not-a-real-key-4f2b9c8e-do-not-log";

describe("describeActiveStore", () => {
  test("reports the local SQLite path when no API env vars are set", () => {
    const dbPath = join(makeTempDir(), "recordings.db");
    seedLocalDb(dbPath, 3);

    const description = describeActiveStore(makeConfig(dbPath), {});

    expect(description.transport).toBe("local");
    expect(description.mode_source).toBe("default");
    expect(description.base_url).toBeNull();
    expect(description.local_db_path).toBe(dbPath);
    expect(description.local_db_recordings).toBe(3);
    // Rows in the local file are the live data in local mode, not a divergence.
    expect(description.divergent).toBe(false);
  });

  // The station03 shape: URL + key present, no mode variable anywhere, so
  // nothing in a config file or a login profile reveals that writes left the box.
  test("reports cloud-http and names the URL+key presence as the reason", () => {
    const dbPath = join(makeTempDir(), "recordings.db");

    const description = describeActiveStore(makeConfig(dbPath), {
      HASNA_RECORDINGS_API_URL: "https://recordings.example.test",
      HASNA_RECORDINGS_API_KEY: FAKE_API_KEY,
    });

    expect(description.transport).toBe("cloud-http");
    expect(description.mode_source).toBe(AUTO_FLIP_MODE_SOURCE);
    expect(description.base_url).toBe("https://recordings.example.test/v1");
    expect(description.warning).toContain("launchctl getenv");
  });

  test("never puts the API key value in the report", () => {
    const dbPath = join(makeTempDir(), "recordings.db");

    const description = describeActiveStore(makeConfig(dbPath), {
      HASNA_RECORDINGS_API_URL: "https://recordings.example.test",
      HASNA_RECORDINGS_API_KEY: FAKE_API_KEY,
    });

    expect(JSON.stringify(description)).not.toContain(FAKE_API_KEY);
  });

  // The failure that produced two wrong audits: writes go to the API while a
  // populated legacy SQLite file sits on disk looking authoritative.
  test("flags divergence when writes go to the API but a populated local DB remains", () => {
    const dbPath = join(makeTempDir(), "recordings.db");
    seedLocalDb(dbPath, 936);

    const description = describeActiveStore(makeConfig(dbPath), {
      HASNA_RECORDINGS_API_URL: "https://recordings.example.test",
      HASNA_RECORDINGS_API_KEY: FAKE_API_KEY,
    });

    expect(description.divergent).toBe(true);
    expect(description.local_db_recordings).toBe(936);
    expect(description.warning).toContain("NOT the live store");
  });

  test("does not flag divergence when the local DB is absent", () => {
    const dbPath = join(makeTempDir(), "recordings.db");

    const description = describeActiveStore(makeConfig(dbPath), {
      HASNA_RECORDINGS_API_URL: "https://recordings.example.test",
      HASNA_RECORDINGS_API_KEY: FAKE_API_KEY,
    });

    expect(description.local_db_present).toBe(false);
    expect(description.local_db_recordings).toBeNull();
    expect(description.divergent).toBe(false);
  });

  // A diagnostic that creates a store invents the divergence it looks for, and
  // running migrations over a legacy file is a write to something we only read.
  test("creates no database file while inspecting a missing one", () => {
    const dbPath = join(makeTempDir(), "recordings.db");

    describeActiveStore(makeConfig(dbPath), {});

    expect(existsSync(dbPath)).toBe(false);
  });

  test("reports an unreadable local DB as unknown rather than throwing", () => {
    const dbPath = join(makeTempDir(), "recordings.db");
    writeFileSync(dbPath, "this is not a sqlite database");

    const description = describeActiveStore(makeConfig(dbPath), {});

    expect(description.local_db_present).toBe(true);
    expect(description.local_db_recordings).toBeNull();
  });

  // An uncountable file must not read as "no second dataset". Reporting a silent
  // divergent:false there is the same failure as reporting the wrong count.
  test("says UNKNOWN, not none, when a present local DB cannot be counted", () => {
    const dbPath = join(makeTempDir(), "recordings.db");
    writeFileSync(dbPath, "this is not a sqlite database");

    const description = describeActiveStore(makeConfig(dbPath), {
      HASNA_RECORDINGS_API_URL: "https://recordings.example.test",
      HASNA_RECORDINGS_API_KEY: FAKE_API_KEY,
    });

    expect(description.local_db_recordings).toBeNull();
    expect(description.warning).toContain("UNKNOWN");
  });
});

interface FakeStoreOptions {
  mode?: "local" | "cloud-http";
  baseUrl?: string | null;
  /** Simulate a write that is accepted but not durable. */
  dropOnWrite?: boolean;
  /** Simulate storage that mangles the transcript. */
  mutateText?: boolean;
  createThrows?: string;
  deleteReturns?: boolean;
}

function makeFakeStore(options: FakeStoreOptions = {}): {
  store: Store;
  rows: Map<string, Recording>;
  deleted: string[];
} {
  const rows = new Map<string, Recording>();
  const deleted: string[] = [];
  let counter = 0;

  const store = {
    mode: options.mode ?? "local",
    baseUrl: options.baseUrl ?? null,
    async createRecording(input: CreateRecordingInput) {
      if (options.createThrows) throw new Error(options.createThrows);
      counter += 1;
      const recording = {
        id: `probe-${counter}`,
        raw_text: options.mutateText ? `${input.raw_text} (mangled)` : input.raw_text,
        tags: input.tags ?? [],
      } as unknown as Recording;
      if (!options.dropOnWrite) rows.set(recording.id, recording);
      return recording;
    },
    async getRecording(id: string) {
      return rows.get(id) ?? null;
    },
    async deleteRecording(id: string) {
      if (options.deleteReturns === false) return false;
      deleted.push(id);
      return rows.delete(id);
    },
  } as unknown as Store;

  return { store, rows, deleted };
}

describe("probeRecordingPersistence", () => {
  test("passes only after a write is read back and removed again", async () => {
    const { store, rows, deleted } = makeFakeStore({
      mode: "cloud-http",
      baseUrl: "https://recordings.example.test/v1",
    });

    const result = await probeRecordingPersistence({ store });

    expect(result.ok).toBe(true);
    expect(result.read_back).toBe(true);
    expect(result.cleaned_up).toBe(true);
    expect(result.transport).toBe("cloud-http");
    expect(result.message).toContain("https://recordings.example.test/v1");
    expect(deleted).toHaveLength(1);
    // Nothing is left behind in a store people audit.
    expect(rows.size).toBe(0);
  });

  test("tags the marker so any leftover row is identifiable", async () => {
    const captured: CreateRecordingInput[] = [];
    const store = {
      mode: "local",
      baseUrl: null,
      async createRecording(input: CreateRecordingInput) {
        captured.push(input);
        return { id: "probe-1", raw_text: input.raw_text } as unknown as Recording;
      },
      async getRecording() {
        return { id: "probe-1", raw_text: captured[0]!.raw_text } as unknown as Recording;
      },
      async deleteRecording() {
        return true;
      },
    } as unknown as Store;

    const result = await probeRecordingPersistence({ store });

    expect(result.ok).toBe(true);
    expect(captured[0]?.tags).toContain(PERSISTENCE_PROBE_TAG);
  });

  // The trap: the API returns 201 with a recording body, so the caller logs
  // success, but nothing is durable. Only a read-back catches it.
  test("FAILS when the write is accepted but cannot be read back", async () => {
    const { store } = makeFakeStore({ dropOnWrite: true });

    const result = await probeRecordingPersistence({ store });

    expect(result.ok).toBe(false);
    expect(result.read_back).toBe(false);
    expect(result.message).toContain("could not be read back");
  });

  test("FAILS when the stored transcript does not match what was written", async () => {
    const { store } = makeFakeStore({ mutateText: true });

    const result = await probeRecordingPersistence({ store });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("did not match");
  });

  test("reports the store's rejection instead of a generic failure", async () => {
    const { store } = makeFakeStore({ createThrows: "request failed -> 401" });

    const result = await probeRecordingPersistence({ store });

    expect(result.ok).toBe(false);
    expect(result.recording_id).toBeNull();
    expect(result.message).toContain("401");
  });

  test("names the leftover row and the delete command when cleanup fails", async () => {
    const { store } = makeFakeStore({ deleteReturns: false });

    const result = await probeRecordingPersistence({ store });

    expect(result.ok).toBe(true);
    expect(result.cleaned_up).toBe(false);
    expect(result.message).toContain("was left in place");
    expect(result.message).toContain("recordings delete probe-1");
  });

  test("still attempts cleanup after a failed read-back", async () => {
    const { store, deleted } = makeFakeStore({ mutateText: true });

    const result = await probeRecordingPersistence({ store });

    expect(result.ok).toBe(false);
    expect(deleted).toHaveLength(1);
  });
});
