/**
 * Shared domain errors for the storage layer.
 *
 * `ProjectNotFoundError` is thrown when a focus request references a project
 * that cannot be resolved to a real row. It exists so both backends (LocalStore
 * SQLite and the server Postgres repo) fail focus the SAME clean way — and so
 * the `/v1` route can translate it into a 400 instead of leaking the raw
 * foreign-key error (`agents_active_project_id_fkey` / "FOREIGN KEY constraint
 * failed").
 */
export class ProjectNotFoundError extends Error {
  readonly ref: string;
  constructor(ref: string) {
    super(`project not found: ${ref}`);
    this.name = "ProjectNotFoundError";
    this.ref = ref;
  }
}

/**
 * Thrown for invalid client input (missing/blank required fields). Its message
 * is safe to surface to the caller as a clean 400. This is distinct from an
 * unexpected internal/DB error, whose raw text (e.g. a Postgres constraint name)
 * must NEVER be returned to the client.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
