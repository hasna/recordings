import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { resolveTransport } from "../http/client.js";
import { APP, getStore, type Store } from "../store.js";
import type { RecordingsConfig } from "../types/index.js";

/**
 * Why this module exists.
 *
 * A transcript is only "recorded" once it is durably stored, and this package
 * has TWO stores behind one interface (src/store.ts): on-box SQLite and the
 * self-hosted `/v1` HTTP API. Which one is active is decided entirely by the
 * environment — the presence of HASNA_RECORDINGS_API_URL +
 * HASNA_RECORDINGS_API_KEY is itself the self-hosted signal, with no mode
 * variable to make it visible.
 *
 * `check` never reported which store it had resolved. That blind spot is not
 * theoretical: on station03 those two variables are set in the LAUNCHD USER
 * SESSION, so every process in the session inherits them — the GUI app, its CLI
 * helper, and any ssh shell alike. Writes go to the API while
 * ~/.hasna/recordings/recordings.db sits frozen at 936 rows from 2026-07-24,
 * and the live store holds 1288. Two separate audits read the stale SQLite file
 * and concluded that recording had stopped persisting. It had not; they were
 * looking at the wrong store.
 *
 * So: naming the active store is part of proving persistence, and a persistence
 * probe must round-trip against the ACTIVE store, never against whichever one is
 * easier to open.
 */

/** The name we report when the transport came from URL+key presence alone. */
export const AUTO_FLIP_MODE_SOURCE = "auto:api-url+api-key";

export interface ActiveStoreDescription {
  transport: "local" | "cloud-http";
  /**
   * What decided the transport: an env var NAME, `auto:api-url+api-key`, or
   * `default`. Never a value — these variables hold credentials.
   */
  mode_source: string;
  /** `<url>/v1` when routed to the API, else null. Carries no credential. */
  base_url: string | null;
  /** Path the LocalStore would use, reported whether or not it is active. */
  local_db_path: string;
  local_db_present: boolean;
  /**
   * Rows in the local SQLite file, or null when it is absent or unreadable.
   * Only read when the file already exists: a diagnostic must not create a
   * store, or it would invent the very divergence it is looking for.
   */
  local_db_recordings: number | null;
  /**
   * True when writes are routed to the API while a NON-EMPTY local SQLite file
   * also exists. Both datasets then look plausible to a human, and only one is
   * live — the exact condition that produced two wrong audits.
   */
  divergent: boolean;
  warning: string | null;
}

/**
 * Count recordings in a SQLite file without opening it read-write.
 *
 * `getDatabase()` would run migrations, which is a write to a file we are only
 * inspecting — and on a legacy file that is a destructive surprise. Open
 * read-only and treat any failure as "unknown" rather than propagating.
 */
function readLocalRecordingCount(dbPath: string): number | null {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query("SELECT COUNT(*) AS count FROM recordings").get() as
        | { count?: number }
        | null;
      return typeof row?.count === "number" ? row.count : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Report which store this process would read and write, and whether a second,
 * stale dataset is sitting next to it.
 */
export function describeActiveStore(
  config: RecordingsConfig,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): ActiveStoreDescription {
  const localDbPath = config.db_path;
  const localDbPresent = existsSync(localDbPath);
  const localDbRecordings = localDbPresent ? readLocalRecordingCount(localDbPath) : null;

  let resolution: ReturnType<typeof resolveTransport>;
  try {
    resolution = resolveTransport(APP, env);
  } catch (error) {
    return {
      transport: "local",
      mode_source: "unresolved",
      base_url: null,
      local_db_path: localDbPath,
      local_db_present: localDbPresent,
      local_db_recordings: localDbRecordings,
      divergent: false,
      warning: `could not resolve the active store: ${(error as Error).message}`,
    };
  }

  const divergent =
    resolution.transport === "cloud-http" && (localDbRecordings ?? 0) > 0;

  const warnings: string[] = [];
  if (resolution.warning) warnings.push(resolution.warning);
  // An uncountable local file must not read as "no second dataset". A read-only
  // open fails on, among other things, a WAL database whose -shm cannot be
  // created, and silently reporting 0 there would hide the divergence.
  if (
    resolution.transport === "cloud-http" &&
    localDbPresent &&
    localDbRecordings === null
  ) {
    warnings.push(
      `writes go to ${resolution.baseUrl}, and ${localDbPath} exists but could not be counted, ` +
        "so whether a second dataset is sitting there is UNKNOWN — not 'none'."
    );
  }
  if (divergent) {
    warnings.push(
      `writes go to ${resolution.baseUrl}, but ${localDbPath} still holds ` +
        `${localDbRecordings} recordings from an earlier local-mode period. ` +
        "That file is NOT the live store — auditing it undercounts and looks like data loss."
    );
  }
  if (resolution.transport === "cloud-http" && resolution.modeSource === AUTO_FLIP_MODE_SOURCE) {
    warnings.push(
      "the API transport was selected by the mere PRESENCE of " +
        "HASNA_RECORDINGS_API_URL + HASNA_RECORDINGS_API_KEY, with no mode variable. " +
        "Check `launchctl getenv HASNA_RECORDINGS_API_URL` too: a launchd session variable " +
        "is inherited by the GUI app as well as by shells, and is invisible in a login profile."
    );
  }

  return {
    transport: resolution.transport,
    mode_source: resolution.modeSource,
    base_url: resolution.baseUrl,
    local_db_path: localDbPath,
    local_db_present: localDbPresent,
    local_db_recordings: localDbRecordings,
    divergent,
    warning: warnings.length > 0 ? warnings.join(" ") : null,
  };
}

export interface PersistenceProbeResult {
  ok: boolean;
  transport: "local" | "cloud-http";
  base_url: string | null;
  /** Id of the marker recording, kept for cleanup follow-up when needed. */
  recording_id: string | null;
  /** The written transcript was read back byte-identical. */
  read_back: boolean;
  /** The marker was removed again. False means a row was left behind. */
  cleaned_up: boolean;
  message: string;
}

/** Tag carried by probe rows so a leftover marker is identifiable at a glance. */
export const PERSISTENCE_PROBE_TAG = "check-probe";

/**
 * Prove the active store accepts a write, returns it, and lets it be deleted.
 *
 * Presence of a database file, a green `stats` call, or a row count all prove
 * only that SOMETHING is readable. This writes a tagged marker, reads it back,
 * compares the text, and deletes it — the same write-probe shape the native app
 * already uses to validate its helper (RecordingsCLI.probePackagedCompanion).
 *
 * Scope note: this proves the store this process resolves is writable. It does
 * not prove the macOS app resolves the same store; when the two disagree, the
 * cause is env inheritance, which `describeActiveStore` reports on.
 */
export async function probeRecordingPersistence(
  options: { store?: Store; now?: () => Date } = {}
): Promise<PersistenceProbeResult> {
  const store = options.store ?? getStore();
  const stamp = (options.now?.() ?? new Date()).toISOString();
  const marker = `recordings check --probe persistence round-trip ${stamp}`;
  const base: Omit<PersistenceProbeResult, "ok" | "message"> = {
    transport: store.mode === "cloud-http" ? "cloud-http" : "local",
    base_url: store.baseUrl,
    recording_id: null,
    read_back: false,
    cleaned_up: false,
  };

  let created: { id: string } | null = null;
  try {
    created = await store.createRecording({
      raw_text: marker,
      processing_mode: "raw",
      model_used: "check-probe",
      duration_ms: 0,
      tags: ["diagnostic", PERSISTENCE_PROBE_TAG],
      metadata: { persistence_probe: true, probed_at: stamp },
    });
  } catch (error) {
    return {
      ...base,
      ok: false,
      message: `store rejected the write: ${(error as Error).message}`,
    };
  }

  if (!created?.id) {
    return { ...base, ok: false, message: "store accepted the write but returned no id" };
  }

  let readBack = false;
  let readError: string | null = null;
  try {
    const fetched = await store.getRecording(created.id);
    readBack = fetched?.raw_text === marker;
    if (fetched && !readBack) {
      readError = "the stored transcript did not match what was written";
    } else if (!fetched) {
      readError = "the write was accepted but the recording could not be read back";
    }
  } catch (error) {
    readError = `read-back failed: ${(error as Error).message}`;
  }

  // Always attempt cleanup, including after a failed read-back — a probe must
  // not leave rows behind in a store people audit.
  let cleanedUp = false;
  let cleanupError: string | null = null;
  try {
    cleanedUp = await store.deleteRecording(created.id);
    if (!cleanedUp) cleanupError = "the store reported nothing to delete";
  } catch (error) {
    cleanupError = (error as Error).message;
  }

  const where = store.baseUrl ? `the API store at ${store.baseUrl}` : "the local SQLite store";
  if (readError) {
    return {
      ...base,
      recording_id: created.id,
      cleaned_up: cleanedUp,
      ok: false,
      message: `${readError} (${where}, id ${created.id.slice(0, 8)})`,
    };
  }

  const leftover = cleanedUp
    ? ""
    : ` — WARNING: the probe recording ${created.id} was left in place (${cleanupError ?? "cleanup failed"}); ` +
      `remove it with 'recordings delete ${created.id}'`;

  return {
    ...base,
    recording_id: created.id,
    read_back: true,
    cleaned_up: cleanedUp,
    ok: true,
    message: `wrote, read back and removed a marker recording in ${where}${leftover}`,
  };
}
