// Deployment modes are REMOVED. This module is the single place that knows the
// retired words, so no reader has to guess and no writer can re-introduce one.
//
// `local | self_hosted | cloud` — plus the surviving aliases `remote` and
// `hybrid` — described WHERE something ran. Where something runs is an
// operational fact, not a product variant, so it never belonged in a switch.
// Two independent, role-named choices replace all five words:
//
//   • the SERVER's internal storage:  sqlite | postgresql   (src/server/cloud-config.ts)
//   • the CLIENT's store:             sqlite | http         (src/http/client.ts)
//
// The client never opens Postgres. It reads an on-box SQLite file or it calls the
// server's `/v1` HTTP API with a bearer key; the shared Postgres dataset is
// reachable only through that API.
//
// WHY A RETIRED WORD MUST THROW
//
// The defect being removed was never the vocabulary — it was SILENT
// NORMALIZATION. On the client, `self_hosted | remote | hybrid` were quietly
// rewritten to `cloud`. On the server, `remote | hybrid` meant Postgres and
// EVERY OTHER VALUE — including `self_hosted`, including a typo — fell through
// to "is a DATABASE_URL set?", so an unrecognized value selected a backend
// nobody asked for and nothing said so. Deleting the words while keeping the
// fallback would keep the hole. So a retired word is now a hard error that names
// the variable to set and the value to set it to.
//
// SPELLING: manifests spell it `self-hosted`, code enums spell it `self_hosted`.
// Both are the same retired word; `normalizeModeToken` folds the hyphen so a
// single check catches both.

export const RETIRED_DEPLOYMENT_MODES = [
  "local",
  "self_hosted",
  "cloud",
  "remote",
  "hybrid",
] as const;

export type RetiredDeploymentMode = (typeof RETIRED_DEPLOYMENT_MODES)[number];

/** Fold case, surrounding space, and the `self-hosted`/`self_hosted` spelling split. */
export function normalizeModeToken(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, "_");
}

/** The retired mode this value names, or null if it names something else. */
export function asRetiredDeploymentMode(value: string): RetiredDeploymentMode | null {
  const token = normalizeModeToken(value);
  return (RETIRED_DEPLOYMENT_MODES as readonly string[]).includes(token)
    ? (token as RetiredDeploymentMode)
    : null;
}

export interface RetiredModeReplacement {
  /** The variable the caller should set instead. */
  envKey: string;
  /** Value that replaces `local` — the on-this-box arm. */
  onBox: string;
  /** Value that replaces `self_hosted` / `cloud` / `remote` / `hybrid`. */
  offBox: string;
}

/**
 * The error a retired mode word must produce.
 *
 * It names three things a bare "unknown value" error does not: the variable that
 * carried the retired word, the variable to set instead, and the exact value —
 * because the operator reading this cannot be assumed to know the collapse
 * happened.
 */
export function retiredDeploymentModeError(
  rawValue: string,
  sourceEnvKey: string,
  replacement: RetiredModeReplacement,
): Error {
  const mode = asRetiredDeploymentMode(rawValue);
  const value = mode === "local" ? replacement.onBox : replacement.offBox;
  return new Error(
    `${sourceEnvKey}=${rawValue} names a deployment mode, and deployment modes are removed: ` +
      `${RETIRED_DEPLOYMENT_MODES.join(" | ")} no longer select anything. ` +
      `Set ${replacement.envKey}=${value} instead ` +
      `(${replacement.envKey} takes ${replacement.onBox} or ${replacement.offBox}).`,
  );
}
