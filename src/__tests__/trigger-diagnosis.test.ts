/**
 * The trigger diagnosis, and the exit contract that makes it matter.
 *
 * What these pin, and why each one exists:
 *
 *   - `recordings check` reports the trigger at all. It did not, which is why the owner's fn
 *     key was dead for days while every diagnostic reported green.
 *   - `check` exits non-zero when no trigger can fire, and 0 whenever that is not PROVED. A
 *     false failure on a working machine would be worse than the silence being fixed, so the
 *     undecidable cases are asserted to stay green just as hard as the failing case is
 *     asserted to go red.
 *   - `check`'s existing contract is unchanged: `--json` only gains a key, and the command is
 *     silent about the trigger on a machine that has no app UserDefaults to read.
 *   - the TS parser consumes exactly what the Swift log statement produces. That is asserted by
 *     rendering the Swift format string itself and parsing the result, not by grepping the
 *     Swift for a substring — a `toContain` over source text passes while the behaviour is
 *     broken, which is how two HIGH defects shipped through a green contract test in this repo.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runningAppBundlePaths, type TriggerState } from "../cli/macos-shortcut.js";
import {
  describeTriggerPickup,
  diagnoseTrigger,
  parseTriggerBindingsLog,
  readAppLogTail,
  resolveHotkeyBinding,
} from "../cli/trigger-probe.js";

const temporaryDirectories: string[] = [];
/** `check` must make no network call, and only strace can settle that; see the test below. */
const testWithStrace = Bun.spawnSync(["strace", "-V"]).exitCode === 0 ? test : test.skip;
const repoRoot = join(import.meta.dir, "..", "..");
const cliEntry = join("src", "cli", "index.ts");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  }
});

function scratchHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), `open-recordings-trigger-${label}-`));
  temporaryDirectories.push(home);
  return home;
}

/** The exact string KeyboardShortcuts stores for a bare F5, as read live from station03. */
const STORED_F5 = '{"carbonKeyCode":96,"carbonModifiers":0}';

function storedState(rawShortcut: string | null, useFnKey: boolean): TriggerState {
  return {
    rawShortcut,
    shortcut:
      rawShortcut && rawShortcut.startsWith("{")
        ? (JSON.parse(rawShortcut) as { carbonKeyCode: number; carbonModifiers: number })
        : null,
    useFnKey,
  };
}

describe("what the stored hotkey value means", () => {
  test("an absent key is the app's pending default, not an unbound trigger", () => {
    const hotkey = resolveHotkeyBinding(storedState(null, false));
    // KeyboardShortcuts applies `Name`'s default only when the key is absent
    // (Name.swift:39-45), so this machine gets F5 at the next launch.
    expect(hotkey.state).toBe("default_pending");
    expect(hotkey.chord).toBe("F5");
    expect(hotkey.can_fire).toBe("yes");
  });

  test("a Bool false is the cleared marker, and means nothing is registered", () => {
    // `setShortcut(nil, ...)` writes false rather than removing the key when the Name has a
    // default (KeyboardShortcuts.swift:279-289, 434-442), which suppresses the default.
    for (const raw of ["0", "false", "FALSE"]) {
      const hotkey = resolveHotkeyBinding(storedState(raw, false));
      expect(hotkey.state).toBe("cleared");
      expect(hotkey.chord).toBeNull();
      expect(hotkey.can_fire).toBe("no");
    }
  });

  test("a stored chord is that chord", () => {
    const hotkey = resolveHotkeyBinding(storedState(STORED_F5, false));
    expect(hotkey.state).toBe("bound");
    expect(hotkey.chord).toBe("F5");
    expect(hotkey.can_fire).toBe("yes");
  });

  test("an unreadable value is undecided, never a proved failure", () => {
    const hotkey = resolveHotkeyBinding(storedState("<gibberish>", false));
    expect(hotkey.state).toBe("unreadable");
    expect(hotkey.can_fire).toBe("unknown");
  });
});

describe("whether any trigger can fire", () => {
  const diagnose = (raw: string | null, useFnKey: boolean, accessibility: string | null) =>
    diagnoseTrigger({
      trigger: storedState(raw, useFnKey),
      accessibilityPermission: accessibility,
      observation: null,
    });

  test("fn off with the hotkey cleared is the one state that fails", () => {
    const diagnosis = diagnose("0", false, "allowed");
    expect(diagnosis.can_fire).toBe(false);
    expect(diagnosis.failures).not.toEqual([]);
    // The failure has to say what to do about it, or it is just a different silence.
    expect(diagnosis.failures.join(" ")).toContain("recordings shortcut --reset");
  });

  test("fn off with a bound hotkey is reported and does NOT fail", () => {
    // This is the owner's live state on station03: useFnKey=0 with bare F5 bound. The defect
    // was that nothing SAID so — F5 is a real trigger, so failing here would be a false alarm.
    const diagnosis = diagnose(STORED_F5, false, "allowed");
    expect(diagnosis.can_fire).toBe(true);
    expect(diagnosis.failures).toEqual([]);
    expect(diagnosis.summary).toContain("F5");
    expect(diagnosis.summary).toContain("fn/Globe off");
  });

  test("fn off with no stored hotkey does not fail: the app registers its default", () => {
    const diagnosis = diagnose(null, false, "allowed");
    expect(diagnosis.can_fire).toBe(true);
    expect(diagnosis.notes.join(" ")).toContain("F5");
  });

  test("fn as the only trigger fails when Accessibility is denied", () => {
    const diagnosis = diagnose("0", true, "denied");
    expect(diagnosis.can_fire).toBe(false);
    expect(diagnosis.failures.join(" ")).toContain("denied");
  });

  test("fn as the only trigger fails when the grant belongs to a previous build", () => {
    // #24's name for a row that reads allowed while codesign says its stored requirement no
    // longer validates: macOS denies at runtime, so the tap cannot be created.
    const diagnosis = diagnose("0", true, "stale_allowed_for_previous_app_build");
    expect(diagnosis.can_fire).toBe(false);
  });

  test("fn as the only trigger passes when Accessibility is allowed", () => {
    expect(diagnose("0", true, "allowed").can_fire).toBe(true);
    expect(diagnose("0", true, "allowed_identity_unverified").can_fire).toBe(true);
  });

  test("an unreadable TCC database is not a denial and must not fail", () => {
    // Reading the system TCC database needs Full Disk Access. A refusal is a fact about the
    // reader, not about the grant, and treating it as a denial is how a check tells someone to
    // enable a permission that is already enabled.
    const diagnosis = diagnose("0", true, "undetermined_tcc_database_unreadable");
    expect(diagnosis.can_fire).toBe(true);
    expect(diagnosis.failures).toEqual([]);
    expect(diagnosis.warnings).not.toEqual([]);
  });

  test("Accessibility that was never measured does not fail either", () => {
    expect(diagnose("0", true, null).can_fire).toBe(true);
    expect(diagnose("0", true, "not_determined").can_fire).toBe(true);
  });

  test("an unreadable hotkey with fn off warns loudly and still exits green", () => {
    const diagnosis = diagnose("<gibberish>", false, "allowed");
    expect(diagnosis.can_fire).toBe(true);
    expect(diagnosis.failures).toEqual([]);
    expect(diagnosis.warnings.join(" ")).toContain("<gibberish>");
  });
});

/**
 * The app's log line is the only observation of the fn event tap that exists outside the app:
 * `FnKeyMonitor.isRunning` asks `CGEvent.tapIsEnabled`, which no other process can do.
 */
describe("reading the app's own trigger observation", () => {
  const logLine = (body: string, stamp = "2026-07-27T09:41:02Z") => `[${stamp}] ${body}`;

  test("parses the fields the diagnosis depends on", () => {
    const observation = parseTriggerBindingsLog(
      logLine(
        "trigger bindings: shortcutStored=carbonKeyCode=96 carbonModifiers=0 " +
          "shortcutArmed=unknown(carbon-registration-status-not-exposed) " +
          "shortcutSystemReserved=false useFnKey=false fnMonitorRunning=false " +
          "microphone=allowed accessibility=allowed blocked=none",
      ),
    );
    expect(observation).not.toBeNull();
    expect(observation!.observed_at).toBe("2026-07-27T09:41:02Z");
    // The value legitimately contains a space AND a second '=', which is why the parser
    // anchors on the next field name instead of splitting on whitespace.
    expect(observation!.shortcut_stored).toBe("carbonKeyCode=96 carbonModifiers=0");
    expect(observation!.use_fn_key).toBe(false);
    expect(observation!.fn_monitor_running).toBe(false);
    expect(observation!.blocked).toBeNull();
  });

  test("keeps a multi-word blocked reason whole", () => {
    const observation = parseTriggerBindingsLog(
      logLine(
        "trigger bindings: shortcutStored=none useFnKey=true fnMonitorRunning=false " +
          "microphone=allowed accessibility=denied " +
          "blocked=fn/Globe needs Accessibility to watch the key",
      ),
    );
    expect(observation!.blocked).toBe("fn/Globe needs Accessibility to watch the key");
    expect(observation!.accessibility).toBe("denied");
  });

  test("takes the LAST observation, since the app logs one per trigger change", () => {
    const observation = parseTriggerBindingsLog(
      [
        logLine("trigger bindings: shortcutStored=none useFnKey=false fnMonitorRunning=false blocked=none", "A"),
        logLine("some other line", "B"),
        logLine("trigger bindings: shortcutStored=none useFnKey=true fnMonitorRunning=true blocked=none", "C"),
      ].join("\n"),
    );
    expect(observation!.observed_at).toBe("C");
    expect(observation!.fn_monitor_running).toBe(true);
  });

  test("a line without the booleans is no observation rather than a false one", () => {
    expect(parseTriggerBindingsLog("[A] trigger bindings: shortcutStored=none")).toBeNull();
    expect(parseTriggerBindingsLog("[A] unrelated log line")).toBeNull();
    expect(parseTriggerBindingsLog(null)).toBeNull();
    expect(parseTriggerBindingsLog("")).toBeNull();
  });

  test("reads only the tail of the log, so cost does not grow with the log", () => {
    const home = scratchHome("logtail");
    const logPath = join(home, "Recordings.log");
    const filler = "[A] noise\n".repeat(4000);
    writeFileSync(
      logPath,
      `${filler}[2026-07-27T10:00:00Z] trigger bindings: shortcutStored=none useFnKey=true fnMonitorRunning=true blocked=none\n`,
    );
    const tail = readAppLogTail(logPath, 512);
    expect(tail!.length).toBeLessThanOrEqual(512);
    expect(parseTriggerBindingsLog(tail)!.fn_monitor_running).toBe(true);
    // A trigger line older than the window is an absent observation, never a failure.
    expect(parseTriggerBindingsLog(readAppLogTail(logPath, 16))).toBeNull();
    expect(readAppLogTail(join(home, "missing.log"))).toBeNull();
    expect(readAppLogTail(null)).toBeNull();
  });
});

/**
 * The parser reads a format string owned by Swift. Rather than assert the Swift source
 * *contains* something — which passes while the behaviour is broken — render the Swift
 * statement's own literal through the parser and check what comes out. If the log format
 * drifts, this goes red on the drift rather than on a spelling.
 */
describe("the parser consumes what the Swift log statement produces", () => {
  test("rendering RecordingEngine.logResolvedTrigger()'s format string parses as expected", () => {
    const engineSource = readFileSync(
      join(repoRoot, "src/native/Recordings/RecordingsLib/RecordingEngine.swift"),
      "utf8",
    );
    const functionStart = engineSource.indexOf("public func logResolvedTrigger()");
    expect(functionStart).toBeGreaterThan(-1);
    const functionEnd = engineSource.indexOf("private func logIgnoredTrigger(");
    expect(functionEnd).toBeGreaterThan(functionStart);
    const functionBody = engineSource.slice(functionStart, functionEnd);
    const logCallStart = functionBody.indexOf("log(");
    expect(logCallStart).toBeGreaterThan(-1);

    const rendered = renderSwiftInterpolatedString(functionBody.slice(logCallStart), [
      // Keyed on a distinctive part of each interpolated expression. An interpolation that
      // matches nothing throws rather than rendering as empty, so a new field forces this
      // test to be updated instead of quietly passing.
      ["bound", "carbonKeyCode=96 carbonModifiers=0"],
      ["systemReserved", "false"],
      ["useFnKey", "true"],
      ["fnMonitor.isRunning", "false"],
      ["microphonePermissionLabel", "allowed"],
      ["accessibilityPermissionLabel", "denied"],
      ["blockedReason", "fn/Globe needs Accessibility"],
    ]);

    const observation = parseTriggerBindingsLog(`[2026-07-27T12:00:00Z] ${rendered}`);
    expect(observation).not.toBeNull();
    expect(observation!.shortcut_stored).toBe("carbonKeyCode=96 carbonModifiers=0");
    expect(observation!.use_fn_key).toBe(true);
    expect(observation!.fn_monitor_running).toBe(false);
    expect(observation!.microphone).toBe("allowed");
    expect(observation!.accessibility).toBe("denied");
    expect(observation!.blocked).toBe("fn/Globe needs Accessibility");
  });
});

/**
 * Concatenate the Swift string literals in `source`, substituting each `\(...)` interpolation
 * with a supplied value. Interpolations may themselves contain string literals
 * (`blockedReason ?? "none"`), so this tracks paren depth and quoting instead of
 * pattern-matching, which a regex over quotes gets wrong on exactly that expression.
 */
function renderSwiftInterpolatedString(source: string, values: Array<[string, string]>): string {
  let rendered = "";
  let index = 0;
  let insideLiteral = false;
  while (index < source.length) {
    const character = source[index]!;
    if (!insideLiteral) {
      if (character === '"') insideLiteral = true;
      else if (character === ")" && rendered.length > 0) break; // end of the log( ... ) call
      index += 1;
      continue;
    }
    if (character === "\\" && source[index + 1] === "(") {
      let depth = 1;
      let cursor = index + 2;
      let quoted = false;
      while (cursor < source.length && depth > 0) {
        const inner = source[cursor]!;
        if (quoted) {
          if (inner === '"') quoted = false;
        } else if (inner === '"') quoted = true;
        else if (inner === "(") depth += 1;
        else if (inner === ")") depth -= 1;
        cursor += 1;
      }
      const expression = source.slice(index + 2, cursor - 1);
      const match = values.find(([key]) => expression.includes(key));
      if (!match) throw new Error(`no test value supplied for Swift interpolation: ${expression}`);
      rendered += match[1];
      index = cursor;
      continue;
    }
    if (character === '"') {
      insideLiteral = false;
      index += 1;
      continue;
    }
    rendered += character;
    index += 1;
  }
  return rendered;
}

describe("a stored trigger that the running app has not picked up", () => {
  test("says the stored fn setting is not armed", () => {
    const diagnosis = diagnoseTrigger({
      trigger: storedState(STORED_F5, true),
      accessibilityPermission: "allowed",
      observation: {
        observed_at: "2026-07-27T09:00:00Z",
        shortcut_stored: "carbonKeyCode=96 carbonModifiers=0",
        use_fn_key: false,
        fn_monitor_running: false,
        microphone: "allowed",
        accessibility: "allowed",
        blocked: null,
      },
    });
    expect(diagnosis.warnings.join(" ")).toContain("NOT armed");
    expect(diagnosis.warnings.join(" ")).toContain("2026-07-27T09:00:00Z");
    // A hotkey is bound, so something CAN fire — this is a warning, not a failure.
    expect(diagnosis.can_fire).toBe(true);
  });

  test("says the stored hotkey is not armed when the app registered a different one", () => {
    const diagnosis = diagnoseTrigger({
      trigger: storedState('{"carbonKeyCode":105,"carbonModifiers":0}', false),
      accessibilityPermission: "allowed",
      observation: {
        observed_at: "2026-07-27T09:00:00Z",
        shortcut_stored: "carbonKeyCode=96 carbonModifiers=0",
        use_fn_key: false,
        fn_monitor_running: false,
        microphone: "allowed",
        accessibility: "allowed",
        blocked: null,
      },
    });
    expect(diagnosis.warnings.join(" ")).toContain("NOT armed");
    expect(diagnosis.warnings.join(" ")).toContain("F13");
  });

  test("surfaces the app's own blocked reason, which its status line can lose", () => {
    const diagnosis = diagnoseTrigger({
      trigger: storedState(STORED_F5, true),
      accessibilityPermission: "allowed",
      observation: {
        observed_at: "2026-07-27T09:00:00Z",
        shortcut_stored: "carbonKeyCode=96 carbonModifiers=0",
        use_fn_key: true,
        fn_monitor_running: false,
        microphone: "allowed",
        accessibility: "allowed",
        blocked: "fn/Globe needs Accessibility",
      },
    });
    expect(diagnosis.warnings.join(" ")).toContain("fn/Globe needs Accessibility");
    expect(diagnosis.warnings.join(" ")).toContain("fn event tap NOT running");
  });
});

describe("a trigger write that the running app will not pick up", () => {
  test("is not armed while an instance is running, and armed when none is", () => {
    expect(describeTriggerPickup([]).armed).toBe(true);
    const pickup = describeTriggerPickup(["/Applications/Recordings.app"]);
    expect(pickup.armed).toBe(false);
    expect(pickup.runningBundlePaths).toEqual(["/Applications/Recordings.app"]);
  });

  /**
   * Through the real CLI, because the whole defect was in the exit code:
   * `recordings shortcut --fn on && echo armed` printed "armed" while the warning above it
   * said the trigger was not armed.
   */
  test("recordings shortcut exits non-zero when it writes while an instance runs", () => {
    const home = scratchHome("pickup");
    const bundle = join(home, "Applications", "Recordings.app");
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(bundle, "Contents", "Info.plist"), "<plist/>");

    const writesPath = join(home, "writes.txt");
    const defaultsPath = join(home, "fake-defaults");
    writeFileSync(
      defaultsPath,
      `#!/bin/sh
if [ "$1" = write ]; then
  printf '%s\\n' "$*" >> "${writesPath}"
  exit 0
fi
[ "$1" = read ] || exit 1
case "$2" in
  */Contents/Info) [ "$3" = CFBundleIdentifier ] && printf 'com.hasna.recordings\\n' && exit 0 ;;
esac
exit 1
`,
    );
    chmodSync(defaultsPath, 0o755);

    const psPath = join(home, "fake-ps");
    writeFileSync(psPath, `#!/bin/sh\nprintf '%s\\n' "${bundle}/Contents/MacOS/Recordings"\n`);
    chmodSync(psPath, 0o755);

    const result = Bun.spawnSync([process.execPath, cliEntry, "shortcut", "--fn", "on"], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        RECORDINGS_TEST_DEFAULTS_EXECUTABLE: defaultsPath,
        RECORDINGS_TEST_PS_EXECUTABLE: psPath,
      },
    });
    const stdout = result.stdout.toString();
    // The write itself must still have happened — this is not a refusal to write.
    expect(readFileSync(writesPath, "utf8")).toContain("useFnKey");
    expect(stdout).toContain("still holds the previous trigger");
    expect(stdout).toContain(bundle);
    expect(result.exitCode).toBe(1);
  });
});

/**
 * The scan behind `recordings shortcut` was measured at ~11.6 s per call: 271 matching `ps`
 * lines produced 1846 path candidates, each costing a `defaults` spawn. `check` must never pay
 * that, and `shortcut` should not pay it twice.
 */
describe("the running-bundle scan does not re-ask questions it has answered", () => {
  test("reads each distinct candidate path exactly once across the whole listing", () => {
    const reads: string[] = [];
    const listing = [
      "/Applications/Recordings.app/Contents/MacOS/Recordings",
      "/Applications/Safari.app/Contents/MacOS/Safari",
      "/Applications/Mail.app/Contents/MacOS/Mail",
      "/Applications/Recordings.app/Contents/MacOS/Recordings",
    ].join("\n");

    const found = runningAppBundlePaths({
      listProcesses: () => listing,
      readBundleIdentifier: (path) => {
        reads.push(path);
        return path === "/Applications/Recordings.app" ? "com.hasna.recordings" : null;
      },
    });

    expect(found).toEqual(["/Applications/Recordings.app"]);
    // Each line contributes its own "/..." prefixes; the shared ones must be asked once.
    expect(reads.length).toBe(new Set(reads).size);
    // Without the cache the two Recordings lines and the two decoys re-ask "/Applications"
    // and their own roots, which is strictly more than the distinct-candidate count.
    expect(reads.length).toBeLessThan(8);
  });
});

/**
 * End-to-end, through the real CLI process, because the exit code is the contract. The stand-in
 * `defaults` is honoured only off macOS (`TRIGGER_DEFAULTS_EXECUTABLE`), which is the same rule
 * `scripts/macos_artifact.ts` uses for codesign — and it is the only way to exercise this at
 * all, since the fleet's one Mac is the owner's production machine.
 */
describe("recordings check exit contract", () => {
  const runCheck = (home: string, fake: Record<string, string> | null) => {
    const result = Bun.spawnSync([process.execPath, cliEntry, "--json", "check"], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        HASNA_RECORDINGS_STORAGE_MODE: "local",
        HASNA_RECORDINGS_DB_PATH: join(home, "recordings.db"),
        RECORDINGS_AUDIO_DIR: join(home, "audio"),
        OPENAI_API_KEY: "test-openai-key",
        ...(fake ?? {}),
      },
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  };

  /**
   * Stands in for `defaults read <domain> <key>`: prints the value for the two keys the trigger
   * lives in, and exits 1 for anything unset — which is what real `defaults` does for a key
   * that does not exist, and the distinction the diagnosis is built on.
   */
  function fakeDefaults(home: string, shortcut: string | null, useFnKey: string | null): Record<string, string> {
    const path = join(home, "fake-defaults");
    writeFileSync(
      path,
      `#!/bin/sh
[ "$1" = read ] || exit 1
case "$3" in
  KeyboardShortcuts_toggleRecording) value="$FAKE_STORED_SHORTCUT" ;;
  useFnKey) value="$FAKE_USE_FN_KEY" ;;
  *) exit 1 ;;
esac
[ -n "$value" ] || exit 1
printf '%s\\n' "$value"
`,
    );
    chmodSync(path, 0o755);
    return {
      RECORDINGS_TEST_DEFAULTS_EXECUTABLE: path,
      FAKE_STORED_SHORTCUT: shortcut ?? "",
      FAKE_USE_FN_KEY: useFnKey ?? "",
    };
  }

  test("exits non-zero and says so when no trigger can fire", () => {
    const home = scratchHome("dead");
    // The cleared marker plus fn off: nothing is registered and nothing will be.
    const { exitCode, stdout } = runCheck(home, fakeDefaults(home, "0", "0"));
    expect(exitCode).toBe(1);
    const report = JSON.parse(stdout) as { trigger: { can_fire: boolean; hotkey: { state: string }; failures: string[] } };
    expect(report.trigger.can_fire).toBe(false);
    expect(report.trigger.hotkey.state).toBe("cleared");
    expect(report.trigger.failures.join(" ")).toContain("No recording trigger can fire");
  });

  test("reports the trigger and exits 0 on the owner's actual configuration", () => {
    const home = scratchHome("f5");
    // useFnKey=0 with bare F5 bound — the state station03 was in. Reported, not failed.
    const { exitCode, stdout } = runCheck(home, fakeDefaults(home, STORED_F5, "0"));
    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout) as {
      trigger: { can_fire: boolean; hotkey: { chord: string }; fn: { use_fn_key: boolean } };
    };
    expect(report.trigger.can_fire).toBe(true);
    expect(report.trigger.hotkey.chord).toBe("F5");
    expect(report.trigger.fn.use_fn_key).toBe(false);
  });

  test("the human readout names the trigger too, not only --json", () => {
    const home = scratchHome("text");
    const result = Bun.spawnSync([process.execPath, cliEntry, "check"], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        HASNA_RECORDINGS_STORAGE_MODE: "local",
        HASNA_RECORDINGS_DB_PATH: join(home, "recordings.db"),
        OPENAI_API_KEY: "test-openai-key",
        ...fakeDefaults(home, "0", "0"),
      },
    });
    expect(result.exitCode).toBe(1);
    const stdout = result.stdout.toString();
    expect(stdout).toContain("Recording trigger");
    expect(stdout).toContain("No recording trigger can fire");
    expect(stdout).toContain("fn/Globe off");
    // A failure that does not say what to do about it is just a different silence.
    expect(stdout).toContain("recordings shortcut --reset");
  });

  test("says nothing about the trigger, and stays green, where there is no app to ask", () => {
    // No stand-in `defaults`: this is a plain Linux host, which has no app UserDefaults domain.
    // Reporting "fn is off" here would describe a machine that has no trigger at all.
    const home = scratchHome("unsupported");
    const { exitCode, stdout } = runCheck(home, null);
    expect(exitCode).toBe(0);
    expect((JSON.parse(stdout) as { trigger: unknown }).trigger).toBeNull();
    expect(stdout).not.toContain("Recording trigger");
  });

  /**
   * `--json` consumers break on a removed or renamed key, not on a new one. This is the key set
   * `check --json` emitted on main at 4ab7ced, captured by running it there; the assertion is
   * that all of them survive and that `trigger` is the only addition.
   */
  const CHECK_JSON_KEYS_ON_MAIN = [
    "recording",
    "openai_api_key_configured",
    "enhancement_api_key_configured",
    "enhancement_model",
    "transcriber_model",
    "realtime_session_model",
    "realtime_transcription_model",
    "post_processing_mode",
    "transcription_prompt_configured",
    "transcriber_prompt_configured",
    "config_warnings",
    "microphone_permission",
    "accessibility_permission",
    "active_store",
    "capture_probe",
    "capture_probe_subject",
    "microphone_grant_instruction",
    "credential_probe",
    "enhancement_credential_probe",
    "persistence_probe",
  ] as const;

  test("--json only gained a key", () => {
    const home = scratchHome("jsonkeys");
    const { stdout } = runCheck(home, fakeDefaults(home, STORED_F5, "1"));
    const keys = Object.keys(JSON.parse(stdout) as Record<string, unknown>);
    for (const key of CHECK_JSON_KEYS_ON_MAIN) expect(keys).toContain(key);
    expect(keys.filter((key) => !CHECK_JSON_KEYS_ON_MAIN.includes(key as never))).toEqual([
      "trigger",
    ]);
  });

  /**
   * The app-log observation, driven through the real CLI rather than only through the parser.
   * `app status` is the surface that can be exercised this way off macOS, because it resolves
   * the log path unconditionally; the parse, the cross-check and the rendering are the same
   * code `check` runs.
   */
  test("app status reads the app's own log and says the stored trigger is not armed", () => {
    const home = scratchHome("appstatus");
    mkdirSync(join(home, ".hasna", "recordings"), { recursive: true });
    writeFileSync(
      join(home, ".hasna", "recordings", "Recordings.log"),
      "[2026-07-27T08:00:00Z] app launched\n" +
        "[2026-07-27T08:00:01Z] trigger bindings: shortcutStored=carbonKeyCode=96 " +
        "carbonModifiers=0 shortcutArmed=unknown(carbon-registration-status-not-exposed) " +
        "shortcutSystemReserved=false useFnKey=false fnMonitorRunning=false " +
        "microphone=allowed accessibility=allowed blocked=none\n",
    );
    // Storage now says fn is ON; the running app registered with it OFF.
    const result = Bun.spawnSync([process.execPath, cliEntry, "--json", "app", "status"], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        ...fakeDefaults(home, STORED_F5, "1"),
      },
    });
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout.toString()) as {
      log_path: string;
      trigger: {
        can_fire: boolean;
        warnings: string[];
        app_observation: { fn_monitor_running: boolean; observed_at: string; use_fn_key: boolean };
      };
    };
    // Existing keys are untouched.
    expect(report.log_path).toContain(".hasna/recordings/Recordings.log");
    expect(report.trigger.app_observation.observed_at).toBe("2026-07-27T08:00:01Z");
    expect(report.trigger.app_observation.use_fn_key).toBe(false);
    expect(report.trigger.app_observation.fn_monitor_running).toBe(false);
    expect(report.trigger.warnings.join(" ")).toContain("NOT armed");
    // A hotkey is bound, so `app status` is not claiming the machine is dead.
    expect(report.trigger.can_fire).toBe(true);
  });

  testWithStrace("bare check opens no network connection", () => {
    // Proved rather than asserted: the same claim was made for a previous change in this repo
    // and had to be established by watching the syscalls. `strace` is filtered to connect(2)
    // and the assertion is that no AF_INET or AF_INET6 connect appears. Gated on strace being
    // present rather than made a hard requirement: macOS has no strace and needs root for
    // dtruss, and a suite that cannot run on the target platform is its own kind of gap. This
    // ran, and is recorded as having run, on station01.
    const home = scratchHome("offline");
    mkdirSync(home, { recursive: true });
    const tracePath = join(home, "connects.txt");
    const result = Bun.spawnSync(
      [
        "strace",
        "-f",
        "-qq",
        "-e",
        "trace=connect",
        "-o",
        tracePath,
        process.execPath,
        cliEntry,
        "--json",
        "check",
      ],
      {
        cwd: repoRoot,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: home,
          HASNA_RECORDINGS_STORAGE_MODE: "local",
          HASNA_RECORDINGS_DB_PATH: join(home, "recordings.db"),
          OPENAI_API_KEY: "test-openai-key",
          ...fakeDefaults(home, STORED_F5, "1"),
        },
      },
    );
    expect(result.exitCode).toBe(0);
    const trace = readFileSync(tracePath, "utf8");
    expect(trace).not.toContain("AF_INET");
  });
});
