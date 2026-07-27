import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

const ENGINE = "src/native/Recordings/RecordingsLib/RecordingEngine.swift";
const SHORTCUTS = "src/native/Recordings/RecordingsLib/VoiceShortcuts.swift";
const STORE = "src/native/Recordings/App/RecordingsStore.swift";
const SWIFT_TESTS = "src/native/Recordings/RecordingsTests";

/**
 * Types in `RecordingsLib` whose no-argument construction resolves the live user's home and
 * writes under `~/.hasna/recordings`. Constructing one bare inside the Swift suite writes to
 * the operator's real data, so each must be built with an explicit injected location.
 *
 * This rule is enforced here, in TypeScript, rather than in the Swift suite that it describes,
 * because no Swift toolchain is reachable from this runner — a Swift-resident version of this
 * guard would never execute and so would not be a guard at all. `bun test` runs it on every
 * platform.
 */
const HOME_RESOLVING_TYPES = [
  // `RecordingEngine` and `VoiceShortcuts` take the home itself; `ProjectStore` predates the
  // seam and takes the resolved file instead (`init(filePath:)`, ProjectStore.swift:148).
  { type: "RecordingEngine", injector: "homePath:" },
  { type: "VoiceShortcuts", injector: "homePath:" },
  { type: "ProjectStore", injector: "filePath:" },
] as const;

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

  test("voice shortcuts persist under an injected home, derived from the real home once", () => {
    const shortcuts = readFileSync(SHORTCUTS, "utf8");

    // The second live-data leak on this seam: before injection, any test touching voice
    // shortcuts rewrote the operator's real `voice-shortcuts.json`.
    expect(shortcuts).toContain(
      "public init(homePath: String = FileManager.default.homeDirectoryForCurrentUser.path)",
    );
    expect(shortcuts).toContain("private let storageURL: URL");
    expect(shortcuts.match(/homeDirectoryForCurrentUser/g) ?? []).toHaveLength(1);
  });

  test("no Swift test constructs a home-resolving type without injecting a location", () => {
    const files = readdirSync(SWIFT_TESTS).filter((name) => name.endsWith(".swift"));
    // A guard that silently scans nothing is the failure mode this package keeps hitting.
    expect(files.length).toBeGreaterThan(1);

    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(`${SWIFT_TESTS}/${file}`, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const { type, injector } of HOME_RESOLVING_TYPES) {
          if (!line.includes(`${type}(`)) continue;
          if (line.includes(injector)) continue;
          offenders.push(`${file}:${index + 1} ${type} built without ${injector} — ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
