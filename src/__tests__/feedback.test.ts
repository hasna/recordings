import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import { saveFeedback } from "../db/feedback.js";
import { VERSION } from "../version.js";

let directory: string;

beforeEach(() => {
  resetDatabase();
  directory = join(
    tmpdir(),
    `recordings-feedback-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(directory, { recursive: true });
  getDatabase(join(directory, "feedback.db"));
});

afterEach(() => {
  closeDatabase();
  resetDatabase();
  if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
});

describe("saveFeedback", () => {
  test("persists package defaults when optional fields are omitted", () => {
    saveFeedback({ message: "A useful note" });

    expect(getDatabase().query(
      "SELECT message, email, category, version FROM feedback",
    ).get()).toEqual({
      message: "A useful note",
      email: null,
      category: "general",
      version: VERSION,
    });
  });

  test("preserves explicit fields while nullish values use their documented defaults", () => {
    saveFeedback({
      message: "Contact me",
      email: "person@example.test",
      category: "bug",
      version: "9.8.7",
    });
    saveFeedback({
      message: "Anonymous",
      email: null,
      category: null,
      version: null,
    });

    expect(getDatabase().query(
      "SELECT message, email, category, version FROM feedback ORDER BY id",
    ).all()).toEqual([
      {
        message: "Contact me",
        email: "person@example.test",
        category: "bug",
        version: "9.8.7",
      },
      {
        message: "Anonymous",
        email: null,
        category: "general",
        version: VERSION,
      },
    ]);
  });
});
