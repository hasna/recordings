import { getDatabase } from "./database.js";
import { VERSION } from "../version.js";

export interface FeedbackInput {
  message: string;
  email?: string | null;
  category?: string | null;
  version?: string | null;
}

/**
 * Persist a feedback row into the local SQLite store. This is the LocalStore
 * implementation of the Store's `saveFeedback` — the only place feedback SQL
 * lives, so no CLI command or MCP tool touches the database directly.
 */
export function saveFeedback(input: FeedbackInput): void {
  const db = getDatabase();
  db.query(
    "INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)",
  ).run(
    input.message,
    input.email ?? null,
    input.category ?? "general",
    input.version ?? VERSION,
  );
}
