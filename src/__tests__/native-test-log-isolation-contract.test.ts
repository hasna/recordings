import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

const ENGINE = "src/native/Recordings/RecordingsLib/RecordingEngine.swift";
const STORE = "src/native/Recordings/App/RecordingsStore.swift";
const SWIFT_TESTS = "src/native/Recordings/RecordingsTests";

describe("native test log isolation contract", () => {
  test("the engine's home is an injected init parameter, derived from the real home once", () => {
    const engine = readFileSync(ENGINE, "utf8");

    expect(engine).toContain("let home: String");
    expect(engine).toContain(
      "public init(homePath: String = FileManager.default.homeDirectoryForCurrentUser.path)",
    );

    // Exactly one derivation of the real home — the init default. A second one would be a
    // path that ignores the injected home and reaches the operator's files anyway.
    const derivations = engine.match(/homeDirectoryForCurrentUser/g) ?? [];
    expect(derivations).toHaveLength(1);
  });

  test("production still gets the real home", () => {
    const store = readFileSync(STORE, "utf8");
    expect(store).toContain("init(engine: RecordingEngine = RecordingEngine(),");
  });

  test("every engine built in the Swift test suite injects a home", () => {
    const files = readdirSync(SWIFT_TESTS).filter((name) => name.endsWith(".swift"));
    expect(files.length).toBeGreaterThan(0);

    const sites: string[] = [];
    for (const file of files) {
      const source = readFileSync(`${SWIFT_TESTS}/${file}`, "utf8");
      for (const line of source.split("\n")) {
        if (line.includes("RecordingEngine(")) {
          sites.push(`${file}: ${line.trim()}`);
        }
      }
    }

    // Guards against the scan silently matching nothing: the suite is known to build
    // engines in six places across four files, and this test is worthless if the glob or
    // the path ever stops resolving.
    expect(sites.length).toBeGreaterThanOrEqual(6);
    expect(sites.filter((site) => !site.includes("homePath:"))).toEqual([]);
  });
});
