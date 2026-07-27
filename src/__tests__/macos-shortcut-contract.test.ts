import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_TOGGLE_RECORDING_CHORD,
  SHORTCUT_USER_DEFAULTS_PREFIX,
  ShortcutParseError,
  TOGGLE_RECORDING_DEFAULTS_KEY,
  TOGGLE_RECORDING_SHORTCUT_NAME,
  TRIGGER_GRANT_REQUIREMENTS,
  USE_FN_KEY_DEFAULTS_KEY,
  formatShortcut,
  parseShortcutChord,
  parseStoredShortcut,
  runningAppBundlePaths,
} from "../cli/macos-shortcut.js";

const repoRoot = join(import.meta.dir, "..", "..");
const engineSource = readFileSync(
  join(repoRoot, "src/native/Recordings/RecordingsLib/RecordingEngine.swift"),
  "utf8",
);
const fnMonitorSource = readFileSync(
  join(repoRoot, "src/native/Recordings/RecordingsLib/FnKeyMonitor.swift"),
  "utf8",
);
const settingsSource = readFileSync(
  join(repoRoot, "src/native/Recordings/RecordingsLib/SettingsView.swift"),
  "utf8",
);
const packageSwift = readFileSync(join(repoRoot, "src/native/Recordings/Package.swift"), "utf8");

/**
 * The CLI writes the same UserDefaults the Swift app reads. If either side is renamed
 * without the other, the shortcut silently stops being settable from the CLI — the
 * exact "configured but inoperable" failure this surface exists to prevent.
 */
describe("native shortcut storage contract", () => {
  test("the Swift app still declares the shortcut name the CLI writes", () => {
    // Declared as: Self("toggleRecording", default: .init(.f5))
    expect(engineSource).toContain(`Self("${TOGGLE_RECORDING_SHORTCUT_NAME}"`);
  });

  test("the Swift app's default shortcut matches the CLI's --reset target", () => {
    // e.g. `default: .init(.f5)` for DEFAULT_TOGGLE_RECORDING_CHORD === "f5"
    expect(engineSource).toContain(`default: .init(.${DEFAULT_TOGGLE_RECORDING_CHORD})`);
  });

  test("the Swift app still reads the fn toggle key the CLI writes", () => {
    expect(engineSource).toContain(`forKey: "${USE_FN_KEY_DEFAULTS_KEY}"`);
  });

  test("the app still depends on KeyboardShortcuts, which owns the key prefix", () => {
    expect(packageSwift).toContain("sindresorhus/KeyboardShortcuts");
    // The prefix is KeyboardShortcuts' own; assert the composed key we hand to `defaults`.
    expect(TOGGLE_RECORDING_DEFAULTS_KEY).toBe(
      `${SHORTCUT_USER_DEFAULTS_PREFIX}${TOGGLE_RECORDING_SHORTCUT_NAME}`,
    );
    expect(TOGGLE_RECORDING_DEFAULTS_KEY).toBe("KeyboardShortcuts_toggleRecording");
  });
});

describe("chord parsing", () => {
  test("bare function keys carry no modifiers", () => {
    // kVK_F5 == 96 is corroborated by the live value on station03:
    // {"carbonKeyCode":96,"carbonModifiers":0}
    expect(parseShortcutChord("f5")).toEqual({ carbonKeyCode: 96, carbonModifiers: 0 });
    expect(parseShortcutChord("F13")).toEqual({ carbonKeyCode: 105, carbonModifiers: 0 });
  });

  test("modifiers OR together using Carbon constants", () => {
    // controlKey 4096 | optionKey 2048 == 6144; kVK_ANSI_R == 15
    expect(parseShortcutChord("ctrl+opt+r")).toEqual({ carbonKeyCode: 15, carbonModifiers: 6144 });
    // cmdKey 256 | shiftKey 512 == 768; kVK_Space == 49
    expect(parseShortcutChord("cmd+shift+space")).toEqual({ carbonKeyCode: 49, carbonModifiers: 768 });
  });

  test("glyph spellings parse the same as words", () => {
    expect(parseShortcutChord("⌃⌥R")).toEqual(parseShortcutChord("ctrl+opt+r"));
  });

  test("modifier aliases are accepted", () => {
    expect(parseShortcutChord("control+option+r")).toEqual(parseShortcutChord("ctrl+opt+r"));
    expect(parseShortcutChord("alt+r")).toEqual(parseShortcutChord("opt+r"));
  });

  test("a modifier-only chord is rejected rather than stored as a dead binding", () => {
    expect(() => parseShortcutChord("ctrl+opt")).toThrow(ShortcutParseError);
  });

  test("two real keys are rejected", () => {
    expect(() => parseShortcutChord("f5+f6")).toThrow(ShortcutParseError);
  });

  test("unknown keys are rejected rather than silently dropped", () => {
    expect(() => parseShortcutChord("nosuchkey")).toThrow(ShortcutParseError);
    expect(() => parseShortcutChord("")).toThrow(ShortcutParseError);
  });

  test("fn/Globe is rejected with the command that does work, not 'unknown key'", () => {
    // fn has no Carbon key code, so it can never be part of a chord. Telling someone it is
    // "unknown" sends them hunting for a spelling that does not exist.
    for (const spelling of ["fn", "Fn", "globe", "GLOBE", "function", "ctrl+fn", "🌐"]) {
      expect(() => parseShortcutChord(spelling)).toThrow(ShortcutParseError);
      try {
        parseShortcutChord(spelling);
        throw new Error(`expected ${spelling} to throw`);
      } catch (error) {
        expect((error as Error).message).toContain("recordings shortcut --fn on");
        expect((error as Error).message).not.toContain("Unknown key");
      }
    }
  });
});

describe("rendering and reading stored values", () => {
  test("round-trips through the stored JSON shape", () => {
    const parsed = parseShortcutChord("ctrl+opt+r");
    const stored = JSON.stringify(parsed);
    expect(parseStoredShortcut(stored)).toEqual(parsed);
  });

  test("reads the exact string shape KeyboardShortcuts writes", () => {
    expect(parseStoredShortcut('{"carbonKeyCode":96,"carbonModifiers":0}')).toEqual({
      carbonKeyCode: 96,
      carbonModifiers: 0,
    });
  });

  test("malformed or absent values read as no binding instead of throwing", () => {
    expect(parseStoredShortcut(null)).toBeNull();
    expect(parseStoredShortcut("not json")).toBeNull();
    expect(parseStoredShortcut('{"carbonKeyCode":"96"}')).toBeNull();
  });

  test("formats modifiers in macOS display order", () => {
    expect(formatShortcut({ carbonKeyCode: 96, carbonModifiers: 0 })).toBe("F5");
    expect(formatShortcut({ carbonKeyCode: 15, carbonModifiers: 6144 })).toBe("⌃⌥R");
    expect(formatShortcut({ carbonKeyCode: 49, carbonModifiers: 768 })).toBe("⇧⌘SPACE");
  });

  test("an unmapped keycode still renders instead of showing undefined", () => {
    expect(formatShortcut({ carbonKeyCode: 999, carbonModifiers: 0 })).toBe("keycode 999");
  });
});

/**
 * The permission split is the thing users get wrong, and it is decided by *how* each
 * trigger is implemented. Pin the claim to the Swift that implements it: if the fn tap is
 * ever changed to listen-only it would need Input Monitoring instead of Accessibility, and
 * the CLI would start naming the wrong System Settings pane.
 */
describe("trigger permission requirements", () => {
  test("the hotkey claims no TCC grant, and nothing gates its registration on trust", () => {
    const hotkey = TRIGGER_GRANT_REQUIREMENTS.find((entry) => entry.id === "hotkey");
    expect(hotkey).toBeDefined();
    expect(hotkey!.tccService).toBeNull();
    expect(hotkey!.settingsPath).toBeNull();
    // Carbon hot keys are dispatched by the window server; verified on the shipped bundle
    // with `nm -u`, which lists _RegisterEventHotKey.
    expect(hotkey!.mechanism).toContain("RegisterEventHotKey");
    // The registration must stay unconditional — wrapping it in a trust check would make a
    // permission-free trigger fail closed.
    expect(engineSource).toContain("KeyboardShortcuts.onKeyDown(for: .toggleRecording)");
  });

  test("fn claims Accessibility, and the tap is still the event-modifying kind", () => {
    const fn = TRIGGER_GRANT_REQUIREMENTS.find((entry) => entry.id === "fn");
    expect(fn).toBeDefined();
    expect(fn!.tccService).toBe("kTCCServiceAccessibility");
    expect(fn!.settingsPath).toContain("Privacy & Security > Accessibility");
    // `.defaultTap` plus a nil return is an active tap => Accessibility, not Input Monitoring.
    expect(fnMonitorSource).toContain("CGEvent.tapCreate");
    expect(fnMonitorSource).toContain("options: .defaultTap");
    // The engine's own retry gate agrees with that reading.
    expect(engineSource).toContain("AXIsProcessTrusted()");
  });
});

/**
 * `updateStatus()` rewrites `statusMessage` on every return to idle, so a warning written
 * straight into it during `init` was erased before anyone could read it. These pin the
 * separate holder that survives that, because the failure it prevents is invisible.
 */
describe("blocked-trigger reporting contract", () => {
  test("the engine keeps the blocked reason outside statusMessage", () => {
    expect(engineSource).toContain("triggerBlockedReason");
    expect(engineSource).toContain("@Published public private(set) var triggerBlockedReason: String?");
  });

  test("updateStatus consults the blocked reason before falling back to Ready", () => {
    const updateStatus = engineSource.slice(
      engineSource.indexOf("public func updateStatus()"),
      engineSource.indexOf("// MARK: - Toggle"),
    );
    expect(updateStatus).toContain("if let triggerBlockedReason");
    // The blocked branch must come before the "Ready" write, or Ready wins again.
    expect(updateStatus.indexOf("if let triggerBlockedReason")).toBeLessThan(
      updateStatus.indexOf('statusMessage = "Ready"'),
    );
  });

  test("the fn monitor sets the reason on failure and clears it on success", () => {
    const updateFnMonitor = engineSource.slice(
      engineSource.indexOf("private func updateFnMonitor("),
      engineSource.indexOf("public func updateStatus()"),
    );
    expect(updateFnMonitor).toContain("triggerBlockedReason = nil");
    expect(updateFnMonitor).toContain("triggerBlockedReason = Self.fnAccessibilityBlockedMessage");
  });

  test("Settings shows the blocked reason next to the toggle that is blocked", () => {
    expect(settingsSource).toContain("engine.triggerBlockedReason");
    expect(settingsSource).toContain("openAccessibilitySettings()");
  });

  test("a trigger that fires and is dropped is logged rather than swallowed", () => {
    expect(engineSource).toContain("logIgnoredTrigger(.fnKey)");
    expect(engineSource).toContain("logIgnoredTrigger(.keyboardShortcut)");
    // Assert the log key only. Matching the surrounding indentation would make this fail on
    // any reformatting, which is churn rather than a broken contract.
    expect(engineSource).toContain('"trigger ignored trigger=');
  });
});

/**
 * TCC grants key to a bundle, so a permission readout that names a nominal install path
 * instead of the bundle that is running can point at the wrong app entirely.
 */
describe("running bundle detection", () => {
  const psLine = (path: string) => `${path}/Contents/MacOS/Recordings`;
  /** Stands in for the filesystem: only these bundles are real. */
  const onDisk = (...real: string[]) => (path: string) => real.includes(path);

  test("reports the bundle root of a running instance", () => {
    expect(
      runningAppBundlePaths(
        () =>
          [
            "/sbin/launchd",
            psLine("/Users/hasna/.hasna/recordings/Recordings.app"),
            "/usr/libexec/cfprefsd",
          ].join("\n"),
        onDisk("/Users/hasna/.hasna/recordings/Recordings.app"),
      ),
    ).toEqual(["/Users/hasna/.hasna/recordings/Recordings.app"]);
  });

  test("reports every distinct bundle when more than one copy runs", () => {
    expect(
      runningAppBundlePaths(
        () =>
          [
            psLine("/Applications/Recordings.app"),
            psLine("/Users/hasna/Applications/Recordings.app"),
            psLine("/Applications/Recordings.app"),
          ].join("\n"),
        onDisk("/Applications/Recordings.app", "/Users/hasna/Applications/Recordings.app"),
      ),
    ).toEqual(["/Applications/Recordings.app", "/Users/hasna/Applications/Recordings.app"]);
  });

  test("keeps a bundle path that contains spaces", () => {
    const bundle = "/Users/first last/Applications/Recordings.app";
    expect(runningAppBundlePaths(() => psLine(bundle), onDisk(bundle))).toEqual([bundle]);
  });

  test("resolves argument text by asking the filesystem instead of guessing", () => {
    // "/bin/sh -c /Applications/Recordings.app" and "/Users/first last/Recordings.app" are
    // the same shape, so text alone cannot say where the path starts. The longest candidate
    // here does not exist, so the real bundle is the one that survives.
    expect(
      runningAppBundlePaths(
        () => `/bin/sh -c ${psLine("/Applications/Recordings.app")}`,
        onDisk("/Applications/Recordings.app"),
      ),
    ).toEqual(["/Applications/Recordings.app"]);
  });

  test("reports nothing when no candidate is a real bundle", () => {
    expect(
      runningAppBundlePaths(() => psLine("/bogus/Recordings.app"), onDisk()),
    ).toEqual([]);
  });

  test("does not match the CLI, another process, or an unavailable process list", () => {
    const anything = () => true;
    expect(runningAppBundlePaths(() => "/Users/hasna/.bun/bin/recordings", anything)).toEqual([]);
    expect(runningAppBundlePaths(() => "/usr/bin/tail", anything)).toEqual([]);
    expect(runningAppBundlePaths(() => null, anything)).toEqual([]);
    expect(runningAppBundlePaths(() => "", anything)).toEqual([]);
  });

  test("ignores paths that are not the executable inside the bundle", () => {
    const anything = () => true;
    expect(runningAppBundlePaths(() => "/Applications/Recordings.app", anything)).toEqual([]);
    expect(
      runningAppBundlePaths(
        () => "/Applications/Recordings.app/Contents/Helpers/recordings-update-client",
        anything,
      ),
    ).toEqual([]);
    // A nested path below MacOS/ is not the executable either.
    expect(
      runningAppBundlePaths(() => "/Applications/Recordings.app/Contents/MacOS/sub/thing", anything),
    ).toEqual([]);
  });
});
