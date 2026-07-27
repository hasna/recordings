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
    expect(engineSource).toContain("@Published public private(set) var blockedReason: String?");
    // The collapse: `triggerBlockedReason` and the delivery-side `blockedReason` were two
    // published fields describing "the app cannot do what you asked". Two fields is two places
    // for a view to forget to read, and the menu bar forgot to read either. One field only.
    expect(engineSource).not.toContain("triggerBlockedReason: String?");
    expect(engineSource).not.toContain("@Published public private(set) var triggerBlockedReason");
  });

  test("updateStatus consults the blocked reason before falling back to Ready", () => {
    const updateStatus = engineSource.slice(
      engineSource.indexOf("public func updateStatus()"),
      engineSource.indexOf("// MARK: - Toggle"),
    );
    expect(updateStatus).toContain("if let blockedReason");
    // The blocked branch must come before the "Ready" write, or Ready wins again.
    expect(updateStatus.indexOf("if let blockedReason")).toBeLessThan(
      updateStatus.indexOf('statusMessage = "Ready"'),
    );
  });

  test("the fn monitor sets its own half of the reason and clears it on success", () => {
    const updateFnMonitor = engineSource.slice(
      engineSource.indexOf("private func updateFnMonitor("),
      engineSource.indexOf("public func updateStatus()"),
    );
    // Decided into a local and handed to the single writer once, keyed by source.
    expect(updateFnMonitor).toContain("reason = Self.fnAccessibilityBlockedMessage");
    expect(updateFnMonitor).toContain("setBlockedReason(reason, for: .fnKey)");
  });

  /**
   * fn and the hotkey block for different reasons and can block simultaneously. A single
   * writer would let whichever ran last erase the other, which is the same class of bug as
   * `updateStatus()` erasing the warning outright.
   */
  test("only the source-keyed writer assigns the published reason", () => {
    const writes = engineSource.match(/^\s*blockedReason = /gm) ?? [];
    expect(writes.length).toBe(1);
    const compositor = engineSource.slice(
      engineSource.indexOf("private func setBlockedReason("),
      engineSource.indexOf("static func systemReservedShortcuts()"),
    );
    expect(compositor).toContain("blockedReason = ");
    expect(compositor).toContain("blockedReasons[source]");
    // Composition order comes from the enum's declaration order, so the same set of blockers
    // renders the same string no matter which source was written last.
    expect(compositor).toContain("sorted { $0.key < $1.key }");
  });

  /**
   * Four sources can hold at once. Every one of them must go through the single writer, or the
   * last one to run erases the others — the erasure bug this mechanism exists to prevent.
   */
  test("every blocked-reason source is declared and written through one function", () => {
    const sources = engineSource.slice(
      engineSource.indexOf("enum BlockedReasonSource"),
      engineSource.indexOf("@Published public private(set) var blockedReason"),
    );
    for (const source of ["case hotkey", "case fnKey", "case pressConsumed", "case delivery"]) {
      expect(sources).toContain(source);
    }
    // Comparable, so the composed order is the declaration order rather than dictionary order.
    expect(sources).toContain("Comparable");

    // No source may assign the published property directly.
    for (const source of ["hotkey", "fnKey", "pressConsumed", "delivery"]) {
      expect(engineSource).toContain(`for: .${source})`);
    }
  });

  /**
   * The hotkey is the trigger that actually failed across 51 presses, and it had no blocked
   * path at all: `getShortcut` is a UserDefaults read, and KeyboardShortcuts 1.12.0 discards
   * `RegisterEventHotKey`'s OSStatus, so stored config read exactly like a live binding.
   */
  test("the hotkey has a blocked path of its own", () => {
    expect(engineSource).toContain("private func refreshHotkeyDiagnostics()");
    expect(engineSource).toContain("setBlockedReason(reason, for: .hotkey)");
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
    expect(settingsSource).toContain("engine.blockedReason");
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
 * A reason nothing renders is not a disclosure. `git grep blockedReason` over the pre-collapse
 * tree returned four hits, all inside `RecordingEngine.swift`, and zero view consumers — while
 * `git grep -lE "UNUserNotificationCenter|NSAlert|NSSound"` returned zero files, so no toast
 * surface existed either. These assertions fail on that shape.
 */
describe("blocked state is visible in the always-on surface", () => {
  const presentationSource = readFileSync(
    "src/native/Recordings/RecordingsLib/MenuBarPresentation.swift",
    "utf8",
  );
  const menuBarViewSource = readFileSync(
    "src/native/Recordings/App/MenuBarStatusView.swift",
    "utf8",
  );

  test("the presentation takes the blocked reason instead of discarding statusMessage", () => {
    expect(presentationSource).toContain("blockedReason: String? = nil");
    expect(presentationSource).toContain("} else if let blockedReason, !blockedReason.isEmpty {");
    expect(presentationSource).toContain("public let isBlocked: Bool");
  });

  test("blocked changes BOTH the icon and the accessibility label", () => {
    const blockedBranch = presentationSource.slice(
      presentationSource.indexOf("} else if let blockedReason"),
      presentationSource.indexOf("iconName = Self.idleIconName"),
    );
    // The menu-bar item renders only these two, so fixing one leaves half the users blind.
    expect(blockedBranch).toContain("iconName = Self.blockedIconName");
    expect(blockedBranch).toContain("accessibilityLabel = \"Recordings, blocked: \\(blockedReason)\"");
    // Distinct from the idle icon, or the sighted signal is unchanged.
    expect(presentationSource).toMatch(
      /blockedIconName = "exclamationmark\.triangle\.fill"/,
    );
    expect(presentationSource).toMatch(/idleIconName = "mic\.fill"/);
  });

  test("both menu-bar surfaces actually pass the reason in", () => {
    // Two call sites: the always-visible label and the popover. Missing either one recreates
    // exactly the invisibility this fixes.
    const passes = menuBarViewSource.match(/blockedReason: store\.engine\.blockedReason/g) ?? [];
    expect(passes.length).toBe(2);
    expect(menuBarViewSource).toContain("presentation.isBlocked ? .orange : .accentColor");
  });
});

/**
 * Two paste-path rulings that are easy to "simplify" wrongly, so they are asserted rather than
 * only commented.
 */
describe("secure-input delivery contract", () => {
  /**
   * `updateDeliveryStatus` clears the persisted reason, because two statuses that reach the
   * screen produce no `PasteDeliveryOutcome` at all — the "Finish the previous paste" rejection
   * and the conversation route's "Answered" — so clearing on `startRecording()` cannot reach
   * them. That makes the secure-input caller order-dependent: set BEFORE the status write and
   * the reason is wiped, silently reinstating the invisible-blocked bug with every test green.
   */
  test("the secure-input reason is re-set AFTER the status write that clears it", () => {
    const completion = engineSource.slice(
      engineSource.indexOf("Self.isSecureInputOutcome(outcome) ? message : nil") - 3000,
      engineSource.indexOf("Self.isSecureInputOutcome(outcome) ? message : nil") + 200,
    );
    expect(completion.lastIndexOf("self.updateDeliveryStatus(")).toBeLessThan(
      completion.indexOf("self.setBlockedReason("),
    );

    const deliveryStatus = engineSource.slice(
      engineSource.indexOf("private func updateDeliveryStatus("),
      engineSource.indexOf("private func selectedRunningPasteTarget("),
    );
    expect(deliveryStatus).toContain("setBlockedReason(nil, for: .delivery)");
    expect(deliveryStatus).toContain("setBlockedReason(nil, for: .pressConsumed)");
  });

  /**
   * A `==` comparison against one outcome answers `false` for every case added later, with
   * nobody having considered it — and these two predicates decide whether the engine still
   * believes it owns the transcript.
   */
  test("the payload-ownership predicates switch exhaustively instead of comparing", () => {
    expect(engineSource).not.toContain("outcome == .targetUnavailable");
    for (const name of [
      "outcomeLeavesTranscriptOnClipboard",
      "clipboardOwnershipWasLostAfterPasteFailure",
      "shouldCopyAfterPasteFailure",
    ]) {
      const body = engineSource.slice(
        engineSource.indexOf(`static func ${name}(`),
        engineSource.indexOf("nonisolated static func", engineSource.indexOf(`static func ${name}(`) + 10),
      );
      expect(body).toContain("switch outcome {");
      expect(body).toContain("case .targetUnavailable:");
      expect(body).toContain(".secureInputActive:");
    }
  });

  test("the secure-input reason outlives the delivery status, and only that one does", () => {
    expect(engineSource).toContain("Self.isSecureInputOutcome(outcome) ? message : nil");
    expect(engineSource).toContain("for: .delivery");
    const classifier = engineSource.slice(
      engineSource.indexOf("static func isSecureInputOutcome("),
      engineSource.indexOf("nonisolated static func deliveryStatusKind("),
    );
    expect(classifier).toContain("case .secureInputActive: true");
    // Exhaustive, so a new outcome forces a decision instead of defaulting to invisible.
    expect(classifier).toContain(".deliveryNotObserved, .deliveredUnverified");
    expect(classifier).toContain("false");
  });

  /**
   * By the time `.secureInputActive` is reachable the payload writer has already run, so the
   * transcript IS the clipboard and the status line has just told the owner to press Cmd-V.
   * Restoring would delete the exact text the app told them to paste — even though
   * `restoreClipboard` is an explicit opt-in.
   */
  test("secure input never restores the clipboard, and the message says so", () => {
    const settlement = engineSource.slice(
      engineSource.indexOf("let shouldRestore = switch outcome {"),
      engineSource.indexOf("if shouldRestore {"),
    );
    expect(settlement).toContain("case .secureInputActive:\n                false");
    // The other outcomes still honour the opt-in.
    expect(settlement).toContain("stillOwnsPayload");

    // Both branches of the message must promise the clipboard, because both keep it.
    expect(engineSource).toContain("transcript kept on the clipboard ");
    expect(engineSource).toContain("transcript copied, press Cmd-V");
  });

  test("a press consumed by a permission prompt says so instead of writing Ready", () => {
    expect(engineSource).toContain("static let pressConsumedByPermissionPromptMessage");
    // Both released-before-start paths — fn and the hotkey — have the identical defect.
    const consumedWrites =
      engineSource.match(/Self\.pressConsumedByPermissionPromptMessage,\n\s+for: \.pressConsumed/g) ??
      [];
    expect(consumedWrites.length).toBe(2);
    // Read BEFORE resetRecordingIntent(), which cancels the gate this is asking about.
    for (const released of ["fn released before recording started", "shortcut released before recording started"]) {
      const branch = engineSource.slice(
        engineSource.indexOf(released),
        engineSource.indexOf("self.updateStatus()", engineSource.indexOf(released)),
      );
      // `self.` prefix on purpose: the surrounding comment names `resetRecordingIntent()` too,
      // and matching prose instead of the call would make this assertion meaningless.
      expect(branch.indexOf("microphonePermissionStartGate.isAwaitingResponse")).toBeLessThan(
        branch.indexOf("self.resetRecordingIntent()"),
      );
    }
  });

  /**
   * `blockedReason` was cleared only by the NEXT delivery's completion, so a recording that
   * produced no delivery left "press Cmd-V" asserted indefinitely — pointing, by then, at a
   * clipboard that may hold something else entirely.
   */
  test("a new recording clears both transient reasons", () => {
    const startRecording = engineSource.slice(
      engineSource.indexOf("public func startRecording("),
      engineSource.indexOf("let myPID = ProcessInfo.processInfo.processIdentifier"),
    );
    expect(startRecording).toContain("setBlockedReason(nil, for: .pressConsumed)");
    expect(startRecording).toContain("setBlockedReason(nil, for: .delivery)");
  });

  /**
   * #28's `SecureInputProbe` is canonical. #29 shipped a second detector on
   * `IsSecureEventInputEnabled()`, which is a Bool that reads as "not blocked" when the state
   * cannot be determined; the session dictionary distinguishes "no session" from "secure input
   * off", so the degrade-to-false is avoidable and the boolean detector is gone.
   */
  test("there is exactly one secure-input detector, and it is the three-state one", () => {
    expect(engineSource).not.toContain("IsSecureEventInputEnabled");
    expect(engineSource).toContain("SecureInputProbe.current()");
    const verification = readFileSync(
      "src/native/Recordings/RecordingsLib/PasteDeliveryVerification.swift",
      "utf8",
    );
    expect(verification).not.toContain("IsSecureEventInputEnabled");
    expect(verification).toContain("CGSessionCopyCurrentDictionary()");
    expect(verification).toContain("case unknown");
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
