/**
 * Whether a global recording trigger can actually fire, as a diagnosis rather than a dump.
 *
 * Why this exists: on 2026-07-27 the owner's fn key was dead for days with `useFnKey=0` in the
 * `com.hasna.recordings` defaults domain, and every diagnostic reported green throughout —
 * `recordings check` looked at sox and API keys, `app status` at the bundle, `app permissions`
 * at TCC grants, and not one of them looked at the trigger. The machinery to read the trigger
 * arrived with PR #26 (`readTriggerState`, `TRIGGER_GRANT_REQUIREMENTS` in
 * `./macos-shortcut.ts`) but was wired only into the new `recordings shortcut` command, which
 * is no use to the person who does not yet know what is wrong. This module turns those reads
 * into a verdict the commands an operator already runs can report and fail on.
 *
 * Two rules shape everything below.
 *
 * 1. Conservative about failure. A false "your trigger is dead" on a working machine is worse
 *    than the silence being fixed, so each trigger is three-valued — `yes`, `no`, `unknown` —
 *    and the command only fails when EVERY trigger is a definite `no`. Anything undecidable
 *    is reported loudly and counted as usable.
 * 2. Cheap. `runningAppBundlePaths()` in `./macos-shortcut.ts` walks `ps` and spawns a
 *    `defaults` read per path candidate; it was measured at ~11.6 s per call. Nothing here
 *    calls it. The storage read is two `defaults` reads of the app's own domain, and the
 *    runtime observation is a bounded tail of a log file. A `check` that takes 12 seconds is a
 *    `check` nobody runs, which would reintroduce the silence by another route.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

import {
  DEFAULT_TOGGLE_RECORDING_CHORD,
  RECORDINGS_BUNDLE_ID,
  TOGGLE_RECORDING_DEFAULTS_KEY,
  TRIGGER_DEFAULTS_EXECUTABLE,
  USE_FN_KEY_DEFAULTS_KEY,
  formatShortcut,
  parseShortcutChord,
  readTriggerState,
  type Shortcut,
  type TriggerState,
} from "./macos-shortcut.js";

/** Three-valued on purpose — see rule 1 in the module comment. */
export type TriggerCapability = "yes" | "no" | "unknown";

/**
 * What the stored hotkey value means, which is three things and not two.
 *
 * KeyboardShortcuts 1.12.0 (pinned in src/native/Recordings/Package.swift) decides this, and
 * the app inherits its decision:
 *
 *   - key ABSENT      -> `Name.init(_:default:)` applies the declared default, but only
 *                        `if !userDefaultsContains(name:)` (Name.swift:39-45). So an absent key
 *                        means the app registers F5 the next time it launches: a trigger
 *                        exists, it is just not written down yet.
 *   - key = JSON      -> that chord, decoded by `getShortcut` (KeyboardShortcuts.swift:293-301).
 *   - key = Bool false -> `setShortcut(nil, ...)` routes to `userDefaultsDisable`, which writes
 *                        `false` rather than removing the key (KeyboardShortcuts.swift:279-289,
 *                        434-442). `userDefaultsContains` is then true, so the default is NOT
 *                        applied and `getShortcut` returns nil: NOTHING is registered. This is
 *                        the state a user reaches by clearing the shortcut in Settings, and it
 *                        is the only state in which "no hotkey is bound" is literally true.
 *
 * `parseStoredShortcut` collapses the last two to null, and `recordings shortcut` renders the
 * cleared case as "unreadable (0)" — accurate about the bytes, silent about the consequence.
 */
export type HotkeyBindingState = "bound" | "default_pending" | "cleared" | "unreadable";

export interface HotkeyBinding {
  state: HotkeyBindingState;
  /** How the effective chord renders, or null when nothing will be registered. */
  chord: string | null;
  /** Only set for `bound` — a pending default is not a stored value and must not read as one. */
  shortcut: Shortcut | null;
  /** Kept verbatim: the raw value is the evidence when the state is `unreadable`. */
  stored_raw: string | null;
  can_fire: TriggerCapability;
  defaults_key: string;
}

export interface FnTriggerState {
  use_fn_key: boolean;
  /** The TCC state as `getMacOSAppStatus()` resolved it, or null when it was not measured. */
  accessibility_permission: string | null;
  can_fire: TriggerCapability;
  defaults_key: string;
}

/**
 * The app's own last report of its trigger, parsed out of its diagnostic log.
 *
 * This is the only honest answer to "is the fn event tap actually running": the tap lives
 * inside the app, `FnKeyMonitor.isRunning` asks `CGEvent.tapIsEnabled` about it, and a CLI in
 * another process cannot observe it. `RecordingEngine.logResolvedTrigger()` writes exactly
 * that, so reading it costs a file read instead of a process scan — and it carries the
 * app-side blocked reason too, which the menu-bar status line can lose to an unrelated
 * erasure bug.
 *
 * It is an OBSERVATION, not live state: the app logs this at init and whenever the trigger
 * changes, so it can be arbitrarily old. Every consumer below says when it was made.
 */
export interface AppTriggerObservation {
  observed_at: string | null;
  /** As the app resolved it, e.g. "carbonKeyCode=96 carbonModifiers=0" or "none". */
  shortcut_stored: string | null;
  use_fn_key: boolean;
  fn_monitor_running: boolean;
  microphone: string | null;
  accessibility: string | null;
  /** The app's own blocked reason, or null when it reported `blocked=none`. */
  blocked: string | null;
}

export interface TriggerDiagnosis {
  /** false only when every trigger is a definite `no`. This is what gates the exit code. */
  can_fire: boolean;
  /** One line, built once so text output and `--json` cannot drift apart. */
  summary: string;
  defaults_domain: string;
  hotkey: HotkeyBinding;
  fn: FnTriggerState;
  app_observation: AppTriggerObservation | null;
  /** Reasons the trigger provably cannot fire. Non-empty exactly when `can_fire` is false. */
  failures: string[];
  /** Real problems that do not prove nothing can fire. */
  warnings: string[];
  /** Context that is not a problem. */
  notes: string[];
}

/**
 * Accessibility states in which the fn tap provably cannot be created.
 *
 * `denied` is macOS refusing outright. `stale_allowed_for_previous_app_build` is #24's name for
 * a row that says allowed while `codesign` shows its stored requirement no longer validates
 * against the installed bundle — the grant belongs to a previous build and macOS denies at
 * runtime, which is why #24 gave it a name that does not start with "allowed".
 *
 * Nothing else belongs here. `not_determined` means the app has not asked yet and will prompt;
 * `undetermined_tcc_database_unreadable` means the reader lacked Full Disk Access, which is a
 * fact about the reader and not about the grant. Treating either as a denial is how a check
 * tells someone to enable a permission that is already enabled.
 */
const FN_BLOCKING_ACCESSIBILITY_STATES: readonly string[] = [
  "denied",
  "stale_allowed_for_previous_app_build",
];

/** Bytes of the app log read from the end. */
const APP_LOG_TAIL_BYTES = 1024 * 1024;

/** The marker `RecordingEngine.logResolvedTrigger()` writes. */
const TRIGGER_LOG_MARKER = "trigger bindings:";

export function resolveHotkeyBinding(state: TriggerState): HotkeyBinding {
  const base = { defaults_key: TOGGLE_RECORDING_DEFAULTS_KEY };
  if (state.shortcut) {
    return {
      ...base,
      state: "bound",
      chord: formatShortcut(state.shortcut),
      shortcut: state.shortcut,
      stored_raw: state.rawShortcut,
      can_fire: "yes",
    };
  }
  if (state.rawShortcut === null) {
    return {
      ...base,
      state: "default_pending",
      // Rendered through the same table the chord parser owns rather than upper-casing the
      // constant, so this cannot disagree with what `--reset` would actually write.
      chord: formatShortcut(parseShortcutChord(DEFAULT_TOGGLE_RECORDING_CHORD)),
      shortcut: null,
      stored_raw: null,
      can_fire: "yes",
    };
  }
  const normalized = state.rawShortcut.trim().toLowerCase();
  // `defaults read` prints a Bool false as `0`; `false` is accepted for the same reason
  // `readTriggerState` accepts it for useFnKey — the value may have been written as a string.
  if (normalized === "0" || normalized === "false") {
    return {
      ...base,
      state: "cleared",
      chord: null,
      shortcut: null,
      stored_raw: state.rawShortcut,
      can_fire: "no",
    };
  }
  return {
    ...base,
    state: "unreadable",
    chord: null,
    shortcut: null,
    stored_raw: state.rawShortcut,
    // By KeyboardShortcuts' semantics this is almost certainly also "no hotkey": the key
    // exists, so no default is applied, and `getShortcut` decodes with the same required-Int
    // JSON shape this module does, so a value we cannot read the app cannot read either.
    // "Almost certainly" is not good enough to fail a working machine on, so it is `unknown`
    // and carries a loud warning instead. If the storage format ever changes, this degrades
    // to a warning rather than to a false failure.
    can_fire: "unknown",
  };
}

export function resolveFnTrigger(
  useFnKey: boolean,
  accessibilityPermission: string | null,
): FnTriggerState {
  const base = {
    use_fn_key: useFnKey,
    accessibility_permission: accessibilityPermission,
    defaults_key: USE_FN_KEY_DEFAULTS_KEY,
  };
  // `RecordingEngine` guards both fn handlers on `useFnKey` and stops the tap when it is off
  // (`updateFnMonitor`), so this half is decidable from storage alone.
  if (!useFnKey) return { ...base, can_fire: "no" };
  if (accessibilityPermission !== null) {
    if (FN_BLOCKING_ACCESSIBILITY_STATES.includes(accessibilityPermission)) {
      return { ...base, can_fire: "no" };
    }
    if (accessibilityPermission.startsWith("allowed")) return { ...base, can_fire: "yes" };
  }
  return { ...base, can_fire: "unknown" };
}

/**
 * Parse the app's last resolved-trigger log line.
 *
 * Field extraction is anchored on the following field name rather than split on whitespace,
 * because two values legitimately contain spaces: `shortcutStored=carbonKeyCode=96
 * carbonModifiers=0` embeds both a space and a second `=`, and `blocked=` carries free prose.
 * Order is fixed by the single `log()` statement that produces the line
 * (`RecordingEngine.logResolvedTrigger()`), and
 * src/__tests__/trigger-diagnosis.test.ts renders that statement's own format string through
 * this parser so the two cannot drift apart silently.
 *
 * Returns null rather than a half-filled record when the two booleans that decide anything are
 * missing: an unparseable line means the runtime state is unknown, which is a different claim
 * from "the tap is not running".
 */
export function parseTriggerBindingsLog(logText: string | null): AppTriggerObservation | null {
  if (!logText) return null;
  const lines = logText.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const markerAt = line.indexOf(TRIGGER_LOG_MARKER);
    if (markerAt === -1) continue;
    const body = line.slice(markerAt + TRIGGER_LOG_MARKER.length);
    const useFnKey = matchBoolean(body, "useFnKey");
    const fnMonitorRunning = matchBoolean(body, "fnMonitorRunning");
    if (useFnKey === null || fnMonitorRunning === null) continue;
    const blocked = matchField(body, "blocked", null);
    return {
      // The log writer prefixes every line with "[<ISO8601>] " (NativeAppLog.write).
      observed_at: /^\[([^\]]+)\]/.exec(line)?.[1] ?? null,
      shortcut_stored: matchField(body, "shortcutStored", "shortcutArmed"),
      use_fn_key: useFnKey,
      fn_monitor_running: fnMonitorRunning,
      microphone: matchField(body, "microphone", "accessibility"),
      accessibility: matchField(body, "accessibility", "blocked"),
      blocked: blocked === null || blocked === "none" ? null : blocked,
    };
  }
  return null;
}

function matchField(body: string, field: string, nextField: string | null): string | null {
  const start = body.indexOf(`${field}=`);
  if (start === -1) return null;
  const valueAt = start + field.length + 1;
  if (nextField === null) return body.slice(valueAt).trim() || null;
  const end = body.indexOf(` ${nextField}=`, valueAt);
  if (end === -1) return body.slice(valueAt).trim() || null;
  return body.slice(valueAt, end).trim() || null;
}

function matchBoolean(body: string, field: string): boolean | null {
  const match = new RegExp(`(?:^|\\s)${field}=(true|false)(?:\\s|$)`).exec(body);
  if (!match) return null;
  return match[1] === "true";
}

/**
 * The tail of the app's diagnostic log, or null when there is nothing to read.
 *
 * Bounded because the log is append-only with no rotation. Reading all of it would make the
 * cost of `check` a function of how long the app has been running, and the whole point of
 * putting this in `check` is that it stays fast enough to be run. A trigger line older than
 * the window reads as "no observation", which is reported as unknown — never as a failure.
 */
export function readAppLogTail(logPath: string | null, maxBytes = APP_LOG_TAIL_BYTES): string | null {
  if (!logPath) return null;
  let handle: number | null = null;
  try {
    const size = statSync(logPath).size;
    if (size === 0) return null;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    handle = openSync(logPath, "r");
    const read = readSync(handle, buffer, 0, length, size - length);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    // A missing, unreadable or vanished log is an absent observation, not a failure. Saying
    // otherwise would make `check` red on a machine whose app has simply never launched.
    return null;
  } finally {
    if (handle !== null) {
      try {
        closeSync(handle);
      } catch {
        // Nothing actionable: the read already happened or never started.
      }
    }
  }
}

export interface DiagnoseTriggerInput {
  trigger: TriggerState;
  accessibilityPermission: string | null;
  observation: AppTriggerObservation | null;
}

export function diagnoseTrigger(input: DiagnoseTriggerInput): TriggerDiagnosis {
  const hotkey = resolveHotkeyBinding(input.trigger);
  const fn = resolveFnTrigger(input.trigger.useFnKey, input.accessibilityPermission);
  const failures: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  const canFire = hotkey.can_fire !== "no" || fn.can_fire !== "no";
  if (!canFire) {
    failures.push(
      `No recording trigger can fire: ${describeHotkey(hotkey)}, and ${describeFn(fn)}. ` +
        "Nothing will start a recording from the keyboard. Fix it with one of:\n" +
        "    recordings shortcut --reset        (bind the app's default hotkey again)\n" +
        '    recordings shortcut --set "f13"    (bind a hotkey of your choosing)\n' +
        "    recordings shortcut --fn on        (use fn/Globe as push-to-talk)",
    );
  }

  if (hotkey.state === "unreadable") {
    warnings.push(
      `The stored hotkey value is not a shortcut this CLI can read (${hotkey.stored_raw}). ` +
        "The app decodes it with the same JSON shape, so it most likely registers no hotkey " +
        "either — but that is not proved here, so it is not counted as a failure. Re-bind it " +
        "with 'recordings shortcut --reset' to be certain.",
    );
  }
  if (hotkey.state === "default_pending") {
    notes.push(
      `No hotkey is stored, so the app registers its own default ${hotkey.chord} the next ` +
        "time it launches. Nothing is wrong; it is just not written down yet.",
    );
  }
  if (hotkey.state === "cleared" && fn.can_fire !== "no") {
    notes.push(
      "The hotkey was explicitly cleared (the app stores a disabled marker rather than " +
        "removing the key), so fn/Globe is the only trigger.",
    );
  }
  if (fn.use_fn_key && fn.can_fire === "no") {
    warnings.push(
      `fn/Globe is enabled but its Accessibility grant is ${fn.accessibility_permission}, and ` +
        "the fn trigger is a CGEventTap that macOS will not create without it. Grant it in " +
        "System Settings > Privacy & Security > Accessibility, then quit and reopen the app.",
    );
  }
  if (fn.use_fn_key && fn.can_fire === "unknown") {
    warnings.push(
      `fn/Globe is enabled and its Accessibility grant reads ${fn.accessibility_permission ?? "unmeasured"}` +
        " — that is not a denial and not a pass, so whether the fn tap can be created is " +
        "undecided here. 'recordings app permissions' reports the grant in full.",
    );
  }

  const observation = input.observation;
  if (!observation) {
    notes.push(
      "The app has not logged a resolved trigger, so whether its fn event tap is running is " +
        "unknown. The app writes that line at launch and on every trigger change; if it is " +
        "absent the app has not run since the log was last truncated.",
    );
  } else {
    const when = observation.observed_at ? ` at ${observation.observed_at}` : "";
    notes.push(
      `The app last reported${when}: fn tap ${observation.fn_monitor_running ? "running" : "NOT running"}` +
        `, useFnKey=${observation.use_fn_key}, hotkey ${observation.shortcut_stored ?? "unreported"}.`,
    );
    if (observation.use_fn_key !== input.trigger.useFnKey) {
      warnings.push(
        `The app is running with useFnKey=${observation.use_fn_key} while storage now says ` +
          `${input.trigger.useFnKey}${when ? ` (last reported${when})` : ""}. A running instance keeps ` +
          "the trigger it registered with, so the current setting is NOT armed — quit and " +
          "reopen the app.",
      );
    } else if (
      hotkey.state === "bound" &&
      observation.shortcut_stored !== null &&
      observation.shortcut_stored !==
        `carbonKeyCode=${hotkey.shortcut!.carbonKeyCode} carbonModifiers=${hotkey.shortcut!.carbonModifiers}`
    ) {
      warnings.push(
        `The app registered hotkey ${observation.shortcut_stored}${when} while storage now holds ` +
          `${hotkey.chord}. The running instance keeps what it registered with, so the stored ` +
          "hotkey is NOT armed — quit and reopen the app.",
      );
    }
    if (observation.use_fn_key && !observation.fn_monitor_running) {
      warnings.push(
        `The app itself reported its fn event tap NOT running${when}. It retries while ` +
          "Accessibility is trusted, so this may since have recovered — it is reported, not " +
          "counted as a failure. 'recordings app log' shows what happened next.",
      );
    }
    if (observation.blocked) {
      warnings.push(
        `The app reported its trigger blocked${when}: ${observation.blocked}`,
      );
    }
  }

  return {
    can_fire: canFire,
    summary: `hotkey ${describeHotkey(hotkey)}, ${describeFn(fn)}`,
    defaults_domain: RECORDINGS_BUNDLE_ID,
    hotkey,
    fn,
    app_observation: observation,
    failures,
    warnings,
    notes,
  };
}

function describeHotkey(hotkey: HotkeyBinding): string {
  switch (hotkey.state) {
    case "bound":
      return hotkey.chord!;
    case "default_pending":
      return `${hotkey.chord} (the app's default, registered at next launch)`;
    case "cleared":
      return "cleared — no hotkey is registered";
    case "unreadable":
      return `unreadable (${hotkey.stored_raw})`;
  }
}

function describeFn(fn: FnTriggerState): string {
  if (!fn.use_fn_key) return "fn/Globe off";
  if (fn.can_fire === "no") return `fn/Globe on but Accessibility is ${fn.accessibility_permission}`;
  if (fn.can_fire === "unknown") return "fn/Globe on, Accessibility undecided";
  return "fn/Globe on";
}

export interface ProbeTriggerInput {
  /** As `getMacOSAppStatus()` resolved it, or null when it was not measured on this platform. */
  accessibilityPermission: string | null;
  /** `MacOSAppStatus.log_path`, which mirrors where the Swift `NativeAppLog` writes. */
  appLogPath: string | null;
}

/**
 * Read the trigger and diagnose it, or return null when this machine has no app UserDefaults
 * to ask.
 *
 * Gated on the capability rather than on `process.platform`: what the diagnosis needs is a
 * readable `defaults` domain, and off macOS `TRIGGER_DEFAULTS_EXECUTABLE` is null, so callers
 * get null and report nothing rather than describing a machine with no app as one whose fn key
 * is switched off.
 */
export function probeTriggerDiagnostics(input: ProbeTriggerInput): TriggerDiagnosis | null {
  if (TRIGGER_DEFAULTS_EXECUTABLE === null) return null;
  return diagnoseTrigger({
    trigger: readTriggerState(),
    accessibilityPermission: input.accessibilityPermission,
    observation: parseTriggerBindingsLog(readAppLogTail(input.appLogPath)),
  });
}

export interface TriggerPickup {
  /** Whether the value just written is the value that will actually fire. */
  armed: boolean;
  runningBundlePaths: string[];
}

/**
 * Whether a trigger write took effect.
 *
 * A write lands in UserDefaults, which decides what the NEXT launch registers; a running
 * instance keeps the binding it registered with. `recordings shortcut --fn on` printed that
 * truthfully and then exited 0, so `recordings shortcut --fn on && echo armed` printed
 * "armed" while the trigger was not armed — the same class of false green this whole surface
 * exists to remove, just in an exit code instead of a status line.
 */
export function describeTriggerPickup(runningBundlePaths: string[]): TriggerPickup {
  return { armed: runningBundlePaths.length === 0, runningBundlePaths };
}
