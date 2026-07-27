import { spawnSync } from "child_process";
import { statSync } from "fs";
import { join } from "path";
import { TCC_UNREADABLE_STATE } from "./capture-probe.js";

/**
 * Read a macOS TCC authorization state, distinguishing "no row" from "I was not
 * allowed to look".
 *
 * This lives in its own module because the defect it fixes lived in the READER,
 * not in the classifier that consumes it, and the reader was an unexported
 * function inside the CLI where no test could reach it. Deleting the entire
 * exit-status fix left the suite at 64 pass / 0 fail; mutation testing found all
 * four mutations on the reader surviving. A guard nothing can test is not a guard.
 *
 * Two separate refusals have to be caught, and only the first one was:
 *
 *   1. `open()` refused, `stat()` fine — sqlite3 exits non-zero with empty
 *      stdout. Caught by checking the exit status.
 *   2. `stat()` itself refused — `existsSync` returns false for ANY stat error,
 *      not just ENOENT, so the path was silently skipped as "absent" and the
 *      whole fix was bypassed: the function fell through to `not_determined`,
 *      the classifier mapped that to `never_requested`, and the CLI asserted
 *      "the app has never requested microphone access (no TCC entry exists)".
 *
 * So absence is now proven by an ENOENT specifically. Any other stat error means
 * unreadable. That holds whether or not macOS actually gates `stat` on TCC.db —
 * this must not depend on settling that question.
 */

export type TccStatResult = { kind: "absent" } | { kind: "present" } | { kind: "unreadable" };

/** Classify a path: genuinely missing, present, or present-but-unstattable. */
export function statTccPath(dbPath: string): TccStatResult {
  try {
    statSync(dbPath);
    return { kind: "present" };
  } catch (error) {
    const code = (error as { code?: string }).code;
    // ENOENT and ENOTDIR are the only errors that prove the file is not there.
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "unreadable" };
  }
}

export interface TccQueryResult {
  /** Process exit status; anything non-zero means the query did not answer. */
  status: number | null;
  stdout: string;
  failedToSpawn?: boolean;
}

export type TccQueryRunner = (dbPath: string, sql: string) => TccQueryResult;

const defaultQueryRunner: TccQueryRunner = (dbPath, sql) => {
  const result = spawnSync("/usr/bin/sqlite3", [dbPath, sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    failedToSpawn: Boolean(result.error),
  };
};

export function tccAuthValueLabel(value: string): string {
  switch (value) {
    case "0":
      return "denied";
    case "1":
      return "unknown";
    case "2":
      return "allowed";
    case "3":
      return "limited";
    default:
      return `unknown(${value})`;
  }
}

/** The databases consulted, user first: Microphone lives in the user database. */
export function tccDatabasePaths(home: string): string[] {
  return [
    join(home, "Library", "Application Support", "com.apple.TCC", "TCC.db"),
    join("/", "Library", "Application Support", "com.apple.TCC", "TCC.db"),
  ];
}

export function tccQuerySql(service: string, client: string): string {
  return (
    "select auth_value from access where service = '" +
    service.replace(/'/g, "''") +
    "' and client = '" +
    client.replace(/'/g, "''") +
    "' order by last_modified desc limit 1;"
  );
}

/**
 * Resolve the TCC state for one service and client.
 *
 * `not_determined` is returned ONLY when every database was reachable and none
 * held a row. If any database could not be stat'd or could not be queried, the
 * answer is `TCC_UNREADABLE_STATE` — unless a later database produced a real
 * value, which is a definite answer and wins.
 */
export function readTccPermission(options: {
  service: string;
  client: string;
  home: string;
  platform?: string;
  paths?: string[];
  stat?: (dbPath: string) => TccStatResult;
  runQuery?: TccQueryRunner;
}): string {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return "unsupported";

  const stat = options.stat ?? statTccPath;
  const runQuery = options.runQuery ?? defaultQueryRunner;
  const paths = options.paths ?? tccDatabasePaths(options.home);
  const sql = tccQuerySql(options.service, options.client);

  let refused = false;
  for (const dbPath of paths) {
    const presence = stat(dbPath);
    if (presence.kind === "absent") continue;
    if (presence.kind === "unreadable") {
      refused = true;
      continue;
    }

    const result = runQuery(dbPath, sql);
    if (result.failedToSpawn || result.status !== 0) {
      refused = true;
      continue;
    }

    const value = result.stdout.trim();
    if (!value) continue;
    return `${tccAuthValueLabel(value)}_identity_unverified`;
  }

  return refused ? TCC_UNREADABLE_STATE : "not_determined";
}
