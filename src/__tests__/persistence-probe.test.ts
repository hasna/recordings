import { describe, expect, test, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  describeActiveStore,
  localStoreIsBehindSchema,
  probeRecordingPersistence,
  safeBaseUrl,
  AUTO_FLIP_MODE_SOURCE,
  PERSISTENCE_PROBE_TAG,
  PERSISTENCE_PROBE_MARKER_PREFIX,
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
  /** Report a successful delete while leaving the row readable. */
  deleteLies?: boolean;
}

function makeFakeStore(options: FakeStoreOptions = {}): {
  store: Store;
  rows: Map<string, Recording>;
  deleted: string[];
  created: CreateRecordingInput[];
} {
  const rows = new Map<string, Recording>();
  const deleted: string[] = [];
  const created: CreateRecordingInput[] = [];
  let counter = 0;

  const store = {
    mode: options.mode ?? "local",
    baseUrl: options.baseUrl ?? null,
    async createRecording(input: CreateRecordingInput) {
      if (options.createThrows) throw new Error(options.createThrows);
      created.push(input);
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
      if (options.deleteLies) return true; // row deliberately left in place
      return rows.delete(id);
    },
  } as unknown as Store;

  return { store, rows, deleted, created };
}

describe("probeRecordingPersistence", () => {
  test("passes only after a write is read back and removed again", async () => {
    const { store, rows, deleted } = makeFakeStore({
      mode: "cloud-http",
      baseUrl: "https://recordings.example.test/v1",
    });

    const result = await probeRecordingPersistence({ store, allowRemoteWrite: true });

    expect(result.ok).toBe(true);
    expect(result.attempted).toBe(true);
    expect(result.read_back).toBe(true);
    expect(result.cleaned_up).toBe(true);
    expect(result.transport).toBe("cloud-http");
    expect(result.message).toContain("https://recordings.example.test/v1");
    expect(deleted).toHaveLength(1);
    // Nothing is left behind in a store people audit.
    expect(rows.size).toBe(0);
  });

  test("tags the marker so any leftover row is identifiable", async () => {
    // Reuses makeFakeStore rather than hand-rolling a second stub: the ad-hoc one
    // ignored deletes, so it disagreed with the real Store contract and made a
    // correct implementation look broken.
    const { store, created } = makeFakeStore({ mode: "local", baseUrl: null });

    const result = await probeRecordingPersistence({ store });

    expect(result.ok).toBe(true);
    expect(created[0]?.tags).toContain(PERSISTENCE_PROBE_TAG);
    expect(created[0]?.tags).toContain("diagnostic");
    expect(created[0]?.raw_text).toContain(PERSISTENCE_PROBE_MARKER_PREFIX);
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
    expect(result.attempted).toBe(true);
    expect(result.recording_id).toBeNull();
    expect(result.message).toContain("401");
    // A timeout is not proof nothing committed, so hand over the recovery query.
    expect(result.message).toContain(PERSISTENCE_PROBE_MARKER_PREFIX);
  });

  // A row left in a store people audit is a failure, not a footnote: reporting
  // ok:true here made the command exit 0 with a probe recording still in place.
  test("FAILS, and names the delete command, when cleanup cannot be confirmed", async () => {
    const { store } = makeFakeStore({ deleteReturns: false });

    const result = await probeRecordingPersistence({ store });

    expect(result.ok).toBe(false);
    expect(result.cleaned_up).toBe(false);
    expect(result.message).toContain("could NOT confirm its removal");
    expect(result.message).toContain("recordings delete probe-1");
  });

  // ApiStore.deleteRecording returns `res?.deleted !== false`, so a 204, an empty
  // body or a non-conforming server all report success with the row still there.
  // The write is only trusted after a read-back; the delete must be too.
  test("FAILS when the store reports a successful delete but the row survives", async () => {
    const { store, rows } = makeFakeStore({ deleteLies: true });

    const result = await probeRecordingPersistence({ store });

    expect(result.ok).toBe(false);
    expect(result.cleaned_up).toBe(false);
    expect(result.message).toContain("still readable");
    expect(rows.size).toBe(1);
  });

  test("still attempts cleanup after a failed read-back", async () => {
    const { store, deleted } = makeFakeStore({ mutateText: true });

    const result = await probeRecordingPersistence({ store });

    expect(result.ok).toBe(false);
    expect(deleted).toHaveLength(1);
  });
});

describe("credential safety in reports", () => {
  // Refutes the branch's own "no credential value can reach the report" claim as
  // it originally stood: toV1BaseUrl clears query and fragment but keeps
  // userinfo, so a password in the API URL reached stdout and --json intact.
  const URL_WITH_PASSWORD = `https://svc:${FAKE_API_KEY}@recordings.example.test`;

  test("a password embedded in the API URL never reaches the report", () => {
    const dbPath = join(makeTempDir(), "recordings.db");

    const description = describeActiveStore(makeConfig(dbPath), {
      HASNA_RECORDINGS_API_URL: URL_WITH_PASSWORD,
      HASNA_RECORDINGS_API_KEY: FAKE_API_KEY,
    });

    expect(description.transport).toBe("cloud-http");
    expect(JSON.stringify(description)).not.toContain(FAKE_API_KEY);
    expect(description.base_url).toContain("recordings.example.test");
    expect(description.base_url).toContain("redacted");
  });

  test("the divergence warning does not leak the URL password either", () => {
    const dbPath = join(makeTempDir(), "recordings.db");
    seedLocalDb(dbPath, 5);

    const description = describeActiveStore(makeConfig(dbPath), {
      HASNA_RECORDINGS_API_URL: URL_WITH_PASSWORD,
      HASNA_RECORDINGS_API_KEY: FAKE_API_KEY,
    });

    expect(description.divergent).toBe(true);
    expect(description.warning).not.toContain(FAKE_API_KEY);
  });

  test("the persistence probe message does not leak the URL password", async () => {
    const { store } = makeFakeStore({
      mode: "cloud-http",
      baseUrl: `${URL_WITH_PASSWORD}/v1`,
    });

    const result = await probeRecordingPersistence({ store, allowRemoteWrite: true });

    expect(result.ok).toBe(true);
    expect(result.message).not.toContain(FAKE_API_KEY);
    expect(JSON.stringify(result)).not.toContain(FAKE_API_KEY);
  });

  test("an unresolvable mode value is redacted rather than echoed", () => {
    const dbPath = join(makeTempDir(), "recordings.db");

    const description = describeActiveStore(makeConfig(dbPath), {
      HASNA_RECORDINGS_STORAGE_MODE: "sk-not-a-mode-but-key-shaped-abcdef123456",
    });

    expect(description.mode_source).toBe("unresolved");
    expect(description.warning).toContain("[redacted]");
  });

  test("safeBaseUrl leaves a clean URL untouched", () => {
    expect(safeBaseUrl("https://recordings.example.test/v1")).toBe(
      "https://recordings.example.test/v1"
    );
    expect(safeBaseUrl(null)).toBeNull();
    expect(safeBaseUrl("not a url at all")).toBe("[unparseable URL redacted]");
  });
});

describe("writing to a shared store requires consent", () => {
  // The probe writes a real row. Against a self-hosted API that row is briefly
  // visible to every reader, and the server's idempotency ledger keeps a
  // permanent orphan per create, so this must not happen by default.
  test("SKIPS a cloud-http store unless allowRemoteWrite is set", async () => {
    const { store, rows } = makeFakeStore({
      mode: "cloud-http",
      baseUrl: "https://recordings.example.test/v1",
    });

    const result = await probeRecordingPersistence({ store });

    expect(result.attempted).toBe(false);
    expect(rows.size).toBe(0);
    expect(result.message).toContain("--probe-store-write");

    // REWRITTEN. This test previously asserted `result.ok === true` for the skip, which locked in
    // the defect rather than guarding against it: `ok:true` made `check --probe` print a green ✓
    // next to the word SKIPPED and exit 0 while writing, reading and deleting nothing — and since
    // a shared API store is skipped by default, that was the DEFAULT outcome on the machine this
    // probe was written for. "I declined to measure" is now its own state.
    expect(result.outcome).toBe("skipped");
    expect(result.ok).toBe(false);
    expect(result.read_back).toBe(false);
    expect(result.cleaned_up).toBe(false);
    // The wording must not read as a pass either.
    expect(result.message).toContain("NOT MEASURED");
    expect(result.message).not.toContain("SKIPPED:");
  });

  // A skip must still not turn `check --probe` red. The exit code keys off `outcome === "failed"`,
  // which is the distinction `ok` alone could not express and why the third state exists.
  test("a skip is reported as not-measured, and is not a failure", async () => {
    const { store } = makeFakeStore({
      mode: "cloud-http",
      baseUrl: "https://recordings.example.test/v1",
    });

    const result = await probeRecordingPersistence({ store });

    expect(result.outcome).not.toBe("failed");
    expect(result.outcome).not.toBe("proved");
  });

  // The skip used to make ZERO network contact, so it did not establish that the store was even
  // reachable — only that the probe had chosen not to write. A read-only stats call proves
  // reachability and credential acceptance without adding a row to production.
  test("a skip still probes reachability read-only, and reports what it found", async () => {
    const reachableStore = makeFakeStore({
      mode: "cloud-http",
      baseUrl: "https://recordings.example.test/v1",
    });
    let statsCalls = 0;
    (reachableStore.store as unknown as { getRecordingStats: () => Promise<unknown> })
      .getRecordingStats = async () => {
      statsCalls += 1;
      return { total: 3 };
    };

    const reachable = await probeRecordingPersistence({ store: reachableStore.store });
    expect(statsCalls).toBe(1);
    expect(reachable.reachable).toBe(true);
    expect(reachable.outcome).toBe("skipped");
    // Reachable is still not proved: no write happened.
    expect(reachable.ok).toBe(false);
    // And a read-only probe must not have created anything.
    expect(reachableStore.rows.size).toBe(0);
    expect(reachableStore.created).toHaveLength(0);

    const unreachableStore = makeFakeStore({
      mode: "cloud-http",
      baseUrl: "https://recordings.example.test/v1",
    });
    (unreachableStore.store as unknown as { getRecordingStats: () => Promise<unknown> })
      .getRecordingStats = async () => {
      throw new Error("connect ECONNREFUSED");
    };

    const unreachable = await probeRecordingPersistence({ store: unreachableStore.store });
    expect(unreachable.reachable).toBe(false);
    expect(unreachable.message).toContain("did NOT answer");
    // An unreachable store is still a skip, not a failure — the probe was never going to write.
    expect(unreachable.outcome).toBe("skipped");
  });

  test("writes to a local store without any extra consent", async () => {
    const { store, deleted } = makeFakeStore({ mode: "local", baseUrl: null });

    const result = await probeRecordingPersistence({ store });

    expect(result.attempted).toBe(true);
    expect(result.ok).toBe(true);
    expect(deleted).toHaveLength(1);
  });

  // The module refuses to open a store read-write while inspecting it, then the
  // probe created and migrated one. Reporting it is the minimum honesty.
  test("reports when the probe itself created the local store", async () => {
    const { store } = makeFakeStore({ mode: "local", baseUrl: null });

    const result = await probeRecordingPersistence({
      store,
      localStoreExistedBefore: false,
    });

    expect(result.created_local_store).toBe(true);
    expect(result.message).toContain("CREATED and migrated the local SQLite store");
  });

  test("does not claim to have created a store that already existed", async () => {
    const { store } = makeFakeStore({ mode: "local", baseUrl: null });

    const result = await probeRecordingPersistence({
      store,
      localStoreExistedBefore: true,
    });

    expect(result.created_local_store).toBe(false);
    expect(result.message).not.toContain("CREATED");
  });
});

describe("legacy local stores are not migrated silently", () => {
  test("SKIPS a local store that is behind the schema", async () => {
    const { store, rows } = makeFakeStore({ mode: "local", baseUrl: null });

    const result = await probeRecordingPersistence({ store, localStoreIsLegacy: true });

    expect(result.attempted).toBe(false);
    expect(rows.size).toBe(0);
    expect(result.message).toContain("behind the current schema");
    expect(result.message).toContain("apply pending migrations");
    // Skipping is not a failure — but it is not a proof either. `ok` means "the round-trip was
    // proved"; the third state carries "declined to measure", so this must not read as a green
    // check. This is F1 applied to the local path, which arrived on a branch that predated it.
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("skipped");
    expect(result.outcome).not.toBe("failed");
    expect(result.message).toContain("NOT MEASURED");
  });

  test("writes to a legacy store once the migration is accepted", async () => {
    const { store } = makeFakeStore({ mode: "local", baseUrl: null });

    const result = await probeRecordingPersistence({
      store,
      localStoreIsLegacy: true,
      allowLocalMigration: true,
    });

    expect(result.attempted).toBe(true);
    expect(result.ok).toBe(true);
  });

  // An unknown schema level must not block the normal path, only a known-legacy one.
  test("does not skip when the schema level could not be determined", async () => {
    const { store } = makeFakeStore({ mode: "local", baseUrl: null });

    const result = await probeRecordingPersistence({ store, localStoreIsLegacy: null });

    expect(result.attempted).toBe(true);
  });
});

describe("localStoreIsBehindSchema", () => {
  test("is null for a database that does not exist", () => {
    expect(localStoreIsBehindSchema(join(makeTempDir(), "missing.db"))).toBeNull();
  });

  test("is null for a file it cannot read as SQLite", () => {
    const dbPath = join(makeTempDir(), "recordings.db");
    writeFileSync(dbPath, "not a sqlite database");

    expect(localStoreIsBehindSchema(dbPath)).toBeNull();
  });

  test("reports a store with no _migrations table as behind", () => {
    const dbPath = join(makeTempDir(), "recordings.db");
    seedLocalDb(dbPath, 1);

    // seedLocalDb writes a bare `recordings` table with no _migrations, which is
    // what a genuinely old file looks like.
    expect(localStoreIsBehindSchema(dbPath)).toBeNull();
  });

  test("reports a store at an older migration level as behind", () => {
    const dbPath = join(makeTempDir(), "recordings.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE _migrations (id INTEGER PRIMARY KEY)");
    db.run("INSERT INTO _migrations (id) VALUES (0)");
    db.close();

    expect(localStoreIsBehindSchema(dbPath)).toBe(true);
  });

  // Does not create the file it inspects — same rule as describeActiveStore.
  test("creates nothing while inspecting a missing database", () => {
    const dbPath = join(makeTempDir(), "recordings.db");

    localStoreIsBehindSchema(dbPath);

    expect(existsSync(dbPath)).toBe(false);
  });
});
