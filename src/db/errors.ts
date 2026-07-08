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
