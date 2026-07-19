import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("native persistence refresh contract", () => {
  test("confirmed persistence refreshes the library outside the record view", () => {
    const engine = readFileSync(
      "src/native/Recordings/RecordingsLib/RecordingEngine.swift",
      "utf8",
    );
    const store = readFileSync(
      "src/native/Recordings/App/RecordingsStore.swift",
      "utf8",
    );

    expect(engine).toContain(
      "@Published public private(set) var persistedRecordingRevision",
    );
    expect(engine).toContain(
      "self.recordPersistenceCompletion(savedText: result.text)",
    );
    expect(engine).toContain(
      "self.recordPersistenceCompletion(savedText: saveResult.text)",
    );
    expect(engine).toContain(
      "self.recordPersistenceCompletion(savedText: cliError == nil ? cliText : nil)",
    );
    expect(store).toContain("engine.$persistedRecordingRevision");
    expect(store).toContain(".dropFirst()");
    expect(store).toMatch(
      /engine\.\$persistedRecordingRevision[\s\S]*?\.sink\s*\{[\s\S]*?loadLibrary\(\)/,
    );
  });
});
