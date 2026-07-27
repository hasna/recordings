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

  /**
   * `updateStatus()` is the only function that honours `triggerBlockedReason`, so any other
   * writer of the idle status pair silently erases the warning. Three had already grown —
   * `updateStatus()` itself, `cancelRecording()`, and the warm-up abandon path — and patching
   * them one at a time is how a fourth lands. Pin the single-writer property instead.
   */
  test("only updateStatus writes the idle Ready status", () => {
    const writes = engineSource.match(/^\s*statusMessage = "Ready"/gm) ?? [];
    expect(writes.length).toBe(1);
    const updateStatus = engineSource.slice(
      engineSource.indexOf("public func updateStatus()"),
      engineSource.indexOf("// MARK: - Trigger release"),
    );
    expect(updateStatus).toContain('statusMessage = "Ready"');
    // Every other return-to-idle must route through it rather than assign directly.
    for (const caller of [
      "public func cancelRecording()",
      "private func abandonWarmingCapture(",
    ]) {
      const from = engineSource.indexOf(caller);
      expect(from, `missing caller: ${caller}`).toBeGreaterThan(-1);
      const body = engineSource.slice(from, engineSource.indexOf("\n    }\n", from));
      expect(body, `${caller} must not assign Ready directly`).not.toContain(
        'statusMessage = "Ready"',
      );
      expect(body, `${caller} must return to idle through updateStatus()`).toContain(
        "updateStatus()",
      );
    }
  });

  test("the fn monitor sets its own half of the reason and clears it on success", () => {
    const updateFnMonitor = engineSource.slice(
      engineSource.indexOf("private func updateFnMonitor("),
      engineSource.indexOf("public func updateStatus()"),
    );
    expect(updateFnMonitor).toContain("fnBlockedReason = nil");
    expect(updateFnMonitor).toContain("fnBlockedReason = Self.fnAccessibilityBlockedMessage");
  });

  /**
   * fn and the hotkey block for different reasons and can block simultaneously. A single
   * writer would let whichever ran last erase the other, which is the same class of bug as
   * `updateStatus()` erasing the warning outright.
   */
  test("only the compositor writes the published reason", () => {
    const writes = engineSource.match(/^\s*triggerBlockedReason = /gm) ?? [];
    expect(writes.length).toBe(1);
    const compositor = engineSource.slice(
      engineSource.indexOf("private func recomputeTriggerBlockedReason()"),
      engineSource.indexOf("static func systemReservedShortcuts()"),
    );
    expect(compositor).toContain("triggerBlockedReason = ");
    expect(compositor).toContain("hotkeyBlockedReason");
    expect(compositor).toContain("fnBlockedReason");
  });

  /**
   * The hotkey is the trigger that actually failed across 51 presses, and it had no blocked
   * path at all: `getShortcut` is a UserDefaults read, and KeyboardShortcuts 1.12.0 discards
   * `RegisterEventHotKey`'s OSStatus, so stored config read exactly like a live binding.
   */
  test("the hotkey has a blocked path of its own", () => {
    expect(engineSource).toContain("private func refreshHotkeyDiagnostics()");
    expect(engineSource).toContain("hotkeyBlockedReason =");
    // The one arming failure that IS observable: a collision with an enabled system shortcut.
    expect(engineSource).toContain("CopySymbolicHotKeys");
    expect(engineSource).toContain("kHISymbolicHotKeyEnabled");
  });

  test("the trigger log reports stored config as stored, and arming as unknown", () => {
    // It must not imply arming it cannot observe.
    expect(engineSource).toContain("shortcutStored=");
    expect(engineSource).toContain("shortcutArmed=unknown");
    expect(engineSource).not.toContain('"trigger bindings: shortcut=\\(bound)');
  });

  /**
   * A tap dies when Accessibility is revoked at runtime, which no creation-time check sees.
   * `eventTap != nil` reported a dead tap as running, so the status stayed "Ready" and the
   * `!isRunning` retry guard blocked recovery.
   */
  test("fn liveness is asked of the tap, not of the handle", () => {
    const isRunning = fnMonitorSource.slice(
      fnMonitorSource.indexOf("var isRunning: Bool"),
      fnMonitorSource.indexOf("private static let fnKeyCode"),
    );
    expect(isRunning).toContain("CGEvent.tapIsEnabled");
    expect(isRunning).not.toMatch(/var isRunning: Bool \{ eventTap != nil \}/);
    // A tap that will not re-enable is torn down so it can be rebuilt.
    expect(fnMonitorSource).toContain("Re-enable failed");
  });

  test("the retry path refreshes the visible status, not just the monitor", () => {
    const health = engineSource.slice(
      engineSource.indexOf("private func refreshFnMonitorHealth()"),
      engineSource.indexOf("private func updateFnMonitor("),
    );
    expect(health).toContain("updateStatus()");
    expect(health).toContain("AXIsProcessTrusted()");
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
  /**
   * Stands in for reading CFBundleIdentifier: only these paths are bundles of this app.
   * Anything else reads as null, exactly as a missing or foreign bundle would.
   */
  const appBundles = (...real: string[]) => (path: string) =>
    real.includes(path) ? "com.hasna.recordings" : null;

  test("reports the bundle root of a running instance", () => {
    expect(
      runningAppBundlePaths({
        listProcesses: () =>
          [
            "/sbin/launchd",
            psLine("/Users/hasna/.hasna/recordings/Recordings.app"),
            "/usr/libexec/cfprefsd",
          ].join("\n"),
        readBundleIdentifier: appBundles("/Users/hasna/.hasna/recordings/Recordings.app"),
      }),
    ).toEqual(["/Users/hasna/.hasna/recordings/Recordings.app"]);
  });

  test("reports every distinct bundle when more than one copy runs", () => {
    expect(
      runningAppBundlePaths({
        listProcesses: () =>
          [
            psLine("/Applications/Recordings.app"),
            psLine("/Users/hasna/Applications/Recordings.app"),
            psLine("/Applications/Recordings.app"),
          ].join("\n"),
        readBundleIdentifier: appBundles(
          "/Applications/Recordings.app",
          "/Users/hasna/Applications/Recordings.app",
        ),
      }),
    ).toEqual(["/Applications/Recordings.app", "/Users/hasna/Applications/Recordings.app"]);
  });

  test("keeps a bundle path that contains spaces", () => {
    const bundle = "/Users/first last/Applications/Recordings.app";
    expect(
      runningAppBundlePaths({
        listProcesses: () => psLine(bundle),
        readBundleIdentifier: appBundles(bundle),
      }),
    ).toEqual([bundle]);
  });

  test("resolves argument text by asking the bundle instead of guessing", () => {
    // "/bin/sh -c /Applications/Recordings.app" and "/Users/first last/Recordings.app" are
    // the same shape, so text alone cannot say where the path starts. The longest candidate
    // here is not a bundle, so the real one is what survives.
    expect(
      runningAppBundlePaths({
        listProcesses: () => `/bin/sh -c ${psLine("/Applications/Recordings.app")}`,
        readBundleIdentifier: appBundles("/Applications/Recordings.app"),
      }),
    ).toEqual(["/Applications/Recordings.app"]);
  });

  /**
   * The decoy is real: /Applications/Hasna Recordings.app exists on station03, is ad-hoc
   * signed, is a shell stub, and its id is com.hasna.recordings.launcher. It ends with
   * "Recordings.app" and it exists on disk, so a name- or existence-based check reports it —
   * and an owner told to grant Accessibility to it would enable the wrong row and see no
   * change. Only the identifier separates them.
   */
  test("rejects a differently-named sibling bundle that merely ends in Recordings.app", () => {
    const decoy = "/Applications/Hasna Recordings.app";
    expect(
      runningAppBundlePaths({
        listProcesses: () => `${decoy}/Contents/MacOS/stub`,
        // The decoy is a readable bundle — it just is not this app.
        readBundleIdentifier: (path) =>
          path === decoy ? "com.hasna.recordings.launcher" : null,
      }),
    ).toEqual([]);
  });

  /**
   * The name is not the invariant and must not be tested. A reviewer measured both of these
   * returning [] under an exact-name gate: the readout then said "not running" and pointed the
   * Accessibility grant at some other installed copy — the same wrong-bundle failure the decoy
   * case causes, just in the opposite direction.
   */
  test("accepts a renamed bundle that still carries this app's identifier", () => {
    const renamed = "/Applications/Dictation.app";
    expect(
      runningAppBundlePaths({
        listProcesses: () => `${renamed}/Contents/MacOS/Recordings`,
        readBundleIdentifier: appBundles(renamed),
      }),
    ).toEqual([renamed]);
  });

  test("accepts a case-variant bundle name, as case-insensitive APFS produces", () => {
    const variant = "/Applications/recordings.app";
    expect(
      runningAppBundlePaths({
        listProcesses: () => `${variant}/Contents/MacOS/Recordings`,
        readBundleIdentifier: appBundles(variant),
      }),
    ).toEqual([variant]);
  });

  test("rejects a bundle named Recordings.app whose identifier is not this app", () => {
    const impostor = "/Applications/Recordings.app";
    expect(
      runningAppBundlePaths({
        listProcesses: () => psLine(impostor),
        readBundleIdentifier: () => "com.example.recordings",
      }),
    ).toEqual([]);
  });

  test("reports nothing when no candidate is a readable bundle", () => {
    expect(
      runningAppBundlePaths({
        listProcesses: () => psLine("/bogus/Recordings.app"),
        readBundleIdentifier: () => null,
      }),
    ).toEqual([]);
  });

  test("does not match the CLI, another process, or an unavailable process list", () => {
    const anyBundle = () => "com.hasna.recordings";
    expect(
      runningAppBundlePaths({ listProcesses: () => "/Users/hasna/.bun/bin/recordings", readBundleIdentifier: anyBundle }),
    ).toEqual([]);
    expect(runningAppBundlePaths({ listProcesses: () => "/usr/bin/tail", readBundleIdentifier: anyBundle })).toEqual([]);
    expect(runningAppBundlePaths({ listProcesses: () => null, readBundleIdentifier: anyBundle })).toEqual([]);
    expect(runningAppBundlePaths({ listProcesses: () => "", readBundleIdentifier: anyBundle })).toEqual([]);
  });

  test("ignores paths that are not the executable inside the bundle", () => {
    const anyBundle = () => "com.hasna.recordings";
    expect(
      runningAppBundlePaths({ listProcesses: () => "/Applications/Recordings.app", readBundleIdentifier: anyBundle }),
    ).toEqual([]);
    expect(
      runningAppBundlePaths({
        listProcesses: () => "/Applications/Recordings.app/Contents/Helpers/recordings-update-client",
        readBundleIdentifier: anyBundle,
      }),
    ).toEqual([]);
    expect(
      runningAppBundlePaths({
        listProcesses: () => "/Applications/Recordings.app/Contents/MacOS/sub/thing",
        readBundleIdentifier: anyBundle,
      }),
    ).toEqual([]);
  });
});
