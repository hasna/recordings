/**
 * Read and write the native macOS app's global recording trigger.
 *
 * The app registers its global hotkey through sindresorhus/KeyboardShortcuts (pinned
 * 1.12.0 in src/native/Recordings/Package.swift), which persists the binding in the
 * app's own UserDefaults domain. This module is the CLI-side mirror of that storage
 * contract, so the trigger can be inspected and changed without opening the app's
 * Settings window — the only place it was previously reachable.
 *
 * Storage contract, as implemented by KeyboardShortcuts 1.12.0:
 *   key   = "KeyboardShortcuts_" + Name.rawValue        (KeyboardShortcuts.swift)
 *   value = a JSON *string* (not a dict) encoding        (Shortcut.swift)
 *           { "carbonKeyCode": Int, "carbonModifiers": Int }
 * `carbonModifiers` is the OR of the classic Carbon modifier constants, per
 * NSEvent.ModifierFlags.carbon in KeyboardShortcuts/Utilities.swift.
 *
 * The Swift side owns the shortcut *name* and its default; both are pinned against
 * the Swift source by src/__tests__/macos-shortcut-contract.test.ts so the two
 * languages cannot drift silently.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { RECORDINGS_BUNDLE_IDENTIFIER } from "./macos-permissions.js";

/**
 * The `defaults` binary every read and write below goes through, or null when this machine
 * has no app UserDefaults to reach at all.
 *
 * Pinned absolutely on macOS, so PATH cannot redirect the read that decides whether a
 * trigger is armed — the same rule `scripts/macos_artifact.ts` applies to codesign
 * (`CODESIGN_EXECUTABLE`, macos_artifact.ts:46-48, pinned by
 * src/__tests__/macos-artifact-command-pinning.test.ts). Production macOS never consults
 * the environment override.
 *
 * `null` off macOS is the load-bearing part. There is no `defaults` and no app there, and
 * the previous code spawned `/usr/bin/defaults` anyway: `spawnSync` set `error` with a null
 * status, `readDefault` mapped that to null, and the caller could not tell "this key is
 * not set" from "there is nothing here to ask". A null executable makes the difference
 * explicit, so a non-macOS `check` can say nothing about the trigger instead of reporting
 * a machine with no app as one whose fn key is switched off.
 *
 * The off-macOS override is what lets a Linux host exercise this module's real code paths —
 * including `recordings check`'s exit code — against a stand-in `defaults`, which is
 * otherwise untestable anywhere in this fleet: the only Mac is the owner's production
 * machine and it is observation-only.
 */
export const TRIGGER_DEFAULTS_EXECUTABLE: string | null =
  process.platform === "darwin"
    ? "/usr/bin/defaults"
    : process.env.RECORDINGS_TEST_DEFAULTS_EXECUTABLE ?? null;

/**
 * Blocker 3, discharged on rebase.
 *
 * This was `export const RECORDINGS_BUNDLE_ID = "com.hasna.recordings"` — a second definition of
 * the identifier `macos-permissions.ts` already owns. The duplication was not carelessness: the
 * canonical constant arrives with #24 and does not exist on this branch's base, so importing it
 * before the rebase would have left the branch uncompilable rather than merely duplicated. The
 * review ruling was recorded as a TODO(rebase) and is now honoured instead of carried forward.
 *
 * Kept as a re-export under the old name so the UserDefaults call sites below and the contract
 * test keep reading, while there is exactly one definition. The identifier is the same value TCC
 * keys grants to and the same domain the app writes its own preferences under — that is precisely
 * why one owner matters: a bundle that does not carry it is not this app, whatever it is named.
 *
 * The same TODO also required reconciling `showGrantTargets()` here with #24's
 * `describeTccAuthorizationSubject()`. They are NOT the same question and both are kept:
 * `describeTccAuthorizationSubject()` names the single bundle a TCC grant is being reported FOR
 * (one path, or a statement that no bundle is installed), while `showGrantTargets()` enumerates
 * every candidate an operator might have to grant — running instances first, falling back to
 * installed copies, labelling which case it is reporting. Collapsing them would lose the
 * multiple-candidate disclosure, which is the whole point of the readout. They now share the one
 * identifier definition, which is what the ruling was protecting against.
 */
export const RECORDINGS_BUNDLE_ID = RECORDINGS_BUNDLE_IDENTIFIER;

/** Matches `userDefaultsPrefix` in KeyboardShortcuts.swift. */
export const SHORTCUT_USER_DEFAULTS_PREFIX = "KeyboardShortcuts_";

/** Matches `Self("toggleRecording")` in RecordingsLib/RecordingEngine.swift. */
export const TOGGLE_RECORDING_SHORTCUT_NAME = "toggleRecording";

/** Matches the `useFnKey` UserDefaults key read in RecordingsLib/RecordingEngine.swift. */
export const USE_FN_KEY_DEFAULTS_KEY = "useFnKey";

/** Matches the Swift declaration `default: .init(.f5)` in RecordingEngine.swift. */
export const DEFAULT_TOGGLE_RECORDING_CHORD = "f5";

export const TOGGLE_RECORDING_DEFAULTS_KEY = `${SHORTCUT_USER_DEFAULTS_PREFIX}${TOGGLE_RECORDING_SHORTCUT_NAME}`;

/**
 * What each trigger costs in TCC grants, and why. Kept as data rather than prose baked
 * into the command so the CLI, the tests, and any future surface all state the same
 * thing — and so the claim can be pinned against the Swift source that implements it.
 *
 * Verified against the shipped bundle on 2026-07-27 with `nm -u` on
 * Recordings.app/Contents/MacOS/Recordings, which lists `_RegisterEventHotKey` (the
 * hotkey) and `_CGEventTapCreate` + `_AXIsProcessTrusted` (the fn monitor).
 */
export interface TriggerGrantRequirement {
  id: "hotkey" | "fn";
  label: string;
  /** How the trigger is implemented — this is what decides the grant. */
  mechanism: string;
  /** null when the trigger needs no TCC grant at all. */
  tccService: string | null;
  /** null when there is nothing for the owner to switch on. */
  settingsPath: string | null;
}

export const TRIGGER_GRANT_REQUIREMENTS: readonly TriggerGrantRequirement[] = [
  {
    id: "hotkey",
    label: "Hotkey",
    mechanism: "Carbon RegisterEventHotKey, via KeyboardShortcuts 1.12.0",
    // Carbon hot keys are dispatched by the window server to the registering process.
    // They are not an event tap and not a keyboard monitor, so no TCC grant applies —
    // neither Accessibility nor Input Monitoring.
    tccService: null,
    settingsPath: null,
  },
  {
    id: "fn",
    label: "fn/Globe",
    // FnKeyMonitor creates the tap with `options: .defaultTap` and returns nil to swallow
    // fn. An event-modifying tap requires Accessibility; only a listen-only tap would fall
    // under Input Monitoring instead. src/__tests__ pins that so this text cannot go stale.
    mechanism: "CGEventTap (.defaultTap — it swallows fn)",
    tccService: "kTCCServiceAccessibility",
    settingsPath: "System Settings > Privacy & Security > Accessibility",
  },
];

/**
 * Keys that exist on the keyboard but cannot be a hotkey chord, mapped to the thing the
 * owner should run instead. fn/Globe is handled by the macOS keyboard firmware and has no
 * Carbon key code, so `--set fn` can never work; saying "unknown key" would send someone
 * hunting for a spelling that does not exist.
 */
const NON_CHORD_KEYS: Record<string, string> = {
  fn: 'fn/Globe is not a Carbon key, so it cannot be part of a chord. Enable it with: recordings shortcut --fn on',
  function: 'fn/Globe is not a Carbon key, so it cannot be part of a chord. Enable it with: recordings shortcut --fn on',
  globe: 'fn/Globe is not a Carbon key, so it cannot be part of a chord. Enable it with: recordings shortcut --fn on',
  "🌐": 'fn/Globe is not a Carbon key, so it cannot be part of a chord. Enable it with: recordings shortcut --fn on',
};

/**
 * Carbon modifier bit values from <Carbon/Events.h>. These are a frozen platform ABI,
 * and KeyboardShortcuts stores exactly these values, so mirroring them is the contract
 * rather than a magic number.
 */
const CARBON_MODIFIERS = {
  cmd: 0x0100, // cmdKey     = 256
  shift: 0x0200, // shiftKey   = 512
  opt: 0x0800, // optionKey  = 2048
  ctrl: 0x1000, // controlKey = 4096
} as const;

type ModifierToken = keyof typeof CARBON_MODIFIERS;

/** Human spellings accepted on the command line for each Carbon modifier. */
const MODIFIER_ALIASES: Record<string, ModifierToken> = {
  cmd: "cmd",
  command: "cmd",
  meta: "cmd",
  super: "cmd",
  "⌘": "cmd",
  shift: "shift",
  "⇧": "shift",
  opt: "opt",
  option: "opt",
  alt: "opt",
  "⌥": "opt",
  ctrl: "ctrl",
  control: "ctrl",
  "⌃": "ctrl",
};

/** Display order for modifiers, matching how macOS renders them. */
const MODIFIER_GLYPHS: Array<[ModifierToken, string]> = [
  ["ctrl", "⌃"],
  ["opt", "⌥"],
  ["shift", "⇧"],
  ["cmd", "⌘"],
];

/**
 * Carbon virtual key codes (kVK_*) from <Carbon/HIToolbox/Events.h>. Also a frozen
 * platform ABI. Only keys that make sense as a push-to-talk trigger are listed; the
 * function keys matter most because they are the ones with no modifier to hold.
 */
const CARBON_KEY_CODES: Record<string, number> = {
  // Letters
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9,
  b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46,
  // Digits
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
  "9": 25, "7": 26, "8": 28, "0": 29,
  // Punctuation / whitespace
  equal: 24, minus: 27, rightbracket: 30, leftbracket: 33,
  quote: 39, semicolon: 41, backslash: 42, comma: 43, slash: 44, period: 47,
  grave: 50, tab: 48, space: 49, return: 36, enter: 36, delete: 51, escape: 53, esc: 53,
  // Function keys
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111,
  f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
  // Navigation
  home: 115, end: 119, pageup: 116, pagedown: 121,
  left: 123, right: 124, down: 125, up: 126,
};

/** Reverse lookup for rendering a stored keycode back to a label. */
const KEY_LABELS = new Map<number, string>();
for (const [name, code] of Object.entries(CARBON_KEY_CODES)) {
  // First spelling wins so aliases (enter/esc) do not shadow the canonical name.
  if (!KEY_LABELS.has(code)) KEY_LABELS.set(code, name);
}

export interface Shortcut {
  carbonKeyCode: number;
  carbonModifiers: number;
}

export interface TriggerState {
  /** null when no binding is stored — the app then writes its own default at launch. */
  shortcut: Shortcut | null;
  /** Raw stored string, kept for diagnostics when parsing fails. */
  rawShortcut: string | null;
  useFnKey: boolean;
}

export class ShortcutParseError extends Error {}

export function listBindableKeys(): string[] {
  return Object.keys(CARBON_KEY_CODES);
}

/**
 * Parse a chord such as "f13", "ctrl+opt+r" or "⌘⇧Space" into its Carbon encoding.
 * Modifier-only chords are rejected: Carbon's RegisterEventHotKey needs a real key.
 */
export function parseShortcutChord(input: string): Shortcut {
  const trimmed = input.trim();
  if (!trimmed) throw new ShortcutParseError("Shortcut is empty");

  // Accept both "ctrl+opt+r" and glyph runs like "⌃⌥R".
  const normalized = trimmed
    .replace(/[⌃⌥⇧⌘]/g, (glyph) => `${glyph}+`)
    .toLowerCase();

  const tokens = normalized
    .split("+")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) throw new ShortcutParseError(`Could not parse shortcut "${input}"`);

  let carbonModifiers = 0;
  const keyTokens: string[] = [];

  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES[token];
    if (modifier) {
      carbonModifiers |= CARBON_MODIFIERS[modifier];
      continue;
    }
    keyTokens.push(token);
  }

  if (keyTokens.length === 0) {
    throw new ShortcutParseError(
      `"${input}" is only modifiers — a shortcut needs a real key, e.g. "f13" or "ctrl+opt+r"`,
    );
  }
  if (keyTokens.length > 1) {
    throw new ShortcutParseError(
      `"${input}" names more than one key (${keyTokens.join(", ")}) — bind exactly one`,
    );
  }

  const [keyToken] = keyTokens;
  if (keyToken === undefined) {
    throw new ShortcutParseError(`Could not parse shortcut "${input}"`);
  }
  const nonChordReason = NON_CHORD_KEYS[keyToken];
  if (nonChordReason) throw new ShortcutParseError(nonChordReason);

  const carbonKeyCode = CARBON_KEY_CODES[keyToken];
  if (carbonKeyCode === undefined) {
    throw new ShortcutParseError(`Unknown key "${keyToken}" — see 'recordings shortcut --keys'`);
  }

  return { carbonKeyCode, carbonModifiers };
}

/** Render a stored shortcut the way macOS would show it, e.g. "⌃⌥R" or "F13". */
export function formatShortcut(shortcut: Shortcut): string {
  let prefix = "";
  for (const [token, glyph] of MODIFIER_GLYPHS) {
    if ((shortcut.carbonModifiers & CARBON_MODIFIERS[token]) === CARBON_MODIFIERS[token]) {
      prefix += glyph;
    }
  }
  const label = KEY_LABELS.get(shortcut.carbonKeyCode);
  return `${prefix}${label ? label.toUpperCase() : `keycode ${shortcut.carbonKeyCode}`}`;
}

/** Injectable so the process scan can be tested without a running app. */
export type ProcessLister = () => string | null;

/** Reads a bundle's CFBundleIdentifier, or null when it is not a readable bundle. */
export type BundleIdentifierReader = (bundlePath: string) => string | null;

const defaultBundleIdentifierReader: BundleIdentifierReader = (bundlePath) => {
  if (TRIGGER_DEFAULTS_EXECUTABLE === null) return null;
  // Measured cost, and the whole reason this guard exists: `runningAppBundlePaths` asks about
  // every `/` position of every candidate line, which on station03 was 1846 candidates for 271
  // matching `ps` lines. At 6.3 ms per `defaults` spawn that is 11.6 s per call — and
  // `shortcut --fn on` called it twice, so one command cost ~23 s.
  //
  // A `stat` answers the same question for the overwhelming majority of those candidates for
  // free. `defaults read <path>/Contents/Info KEY` reads `<path>/Contents/Info.plist`, so a
  // candidate with no such file cannot possibly identify as this app; skipping the spawn for
  // those is not a heuristic, it is the same answer arrived at cheaply. Both spellings are
  // tested because `defaults` appends `.plist` itself: if a bundle ever carried a literal
  // extensionless `Info`, dropping it here would change the answer rather than just its cost.
  if (
    !existsSync(`${bundlePath}/Contents/Info.plist`) &&
    !existsSync(`${bundlePath}/Contents/Info`)
  ) {
    return null;
  }
  const result = spawnSync(
    TRIGGER_DEFAULTS_EXECUTABLE,
    ["read", `${bundlePath}/Contents/Info`, "CFBundleIdentifier"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
};

export interface BundleScanProbes {
  listProcesses?: ProcessLister;
  readBundleIdentifier?: BundleIdentifierReader;
}

/**
 * Same rule as `TRIGGER_DEFAULTS_EXECUTABLE`: pinned on macOS so PATH cannot substitute the
 * process listing that decides which bundle holds the live trigger, and overridable only off
 * macOS, where it is the one way to exercise the "an instance is running, so your write is not
 * armed" exit path — a path that by definition needs a running Recordings.app to reach.
 */
const PROCESS_LISTER_EXECUTABLE =
  process.platform === "darwin"
    ? "/bin/ps"
    : process.env.RECORDINGS_TEST_PS_EXECUTABLE ?? "/bin/ps";

const defaultProcessLister: ProcessLister = () => {
  // `comm=` prints the executable path and nothing else. `args=` would include arguments,
  // and a wrapper such as `/bin/sh -c /path/Recordings.app/...` would then make the start
  // of the path ambiguous — the pattern below cannot tell an argument boundary from a
  // directory name once spaces are legal in the path. `-ww` stops ps truncating to the
  // terminal width, which would silently cut long bundle paths short.
  const result = spawnSync(PROCESS_LISTER_EXECUTABLE, ["-Awwo", "comm="], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout;
};

/**
 * Bundle paths of the Recordings.app instances currently running.
 *
 * TCC grants key to a specific bundle (and, for an unstably-signed build, to its cdhash),
 * so "which bundle is running" is the only honest answer to "where does the Accessibility
 * grant have to go". Reporting a nominal install path instead is how a permission readout
 * ends up naming a bundle that is not the one being denied.
 */
export function runningAppBundlePaths(probes: BundleScanProbes = {}): string[] {
  const listProcesses = probes.listProcesses ?? defaultProcessLister;
  const readBundleIdentifier = probes.readBundleIdentifier ?? defaultBundleIdentifierReader;

  const listing = listProcesses();
  if (!listing) return [];
  const suffixPattern = /\/Contents\/MacOS\/[^/]+$/;
  const paths = new Set<string>();

  // One identifier read per DISTINCT candidate path, not one per (line, candidate) pair. A
  // real `ps` listing repeats the same directory prefixes across hundreds of lines — every
  // `/Applications/...` process contributes the candidates `/Applications/...` and so on up
  // the tree — and the previous code paid a `defaults` spawn for each repetition. The reader
  // is a question about a path, so asking it twice in one scan can only return the same
  // answer, more slowly.
  const identifierCache = new Map<string, string | null>();
  const readCached = (candidate: string): string | null => {
    const cached = identifierCache.get(candidate);
    if (cached !== undefined) return cached;
    const identifier = readBundleIdentifier(candidate);
    identifierCache.set(candidate, identifier);
    return identifier;
  };

  for (const raw of listing.split("\n")) {
    const line = raw.trim();
    const suffix = suffixPattern.exec(line);
    if (!suffix) continue;
    const bundle = line.slice(0, suffix.index);

    // Spaces are legal in a bundle path, so text alone cannot say where the path begins:
    // "/bin/sh -c /Applications/Recordings.app" and "/Users/first last/Recordings.app" are
    // the same shape. Resolve it by asking the bundle instead of guessing — try the longest
    // candidate first and accept the first one that identifies as this app.
    for (let index = bundle.indexOf("/"); index !== -1; index = bundle.indexOf("/", index + 1)) {
      const candidate = bundle.slice(index);
      if (!isThisApp(candidate, readCached)) continue;
      paths.add(candidate);
      break;
    }
  }
  return [...paths].sort();
}

/**
 * Whether a path is a bundle of *this* app.
 *
 * The identifier is the *only* invariant. TCC grants and the UserDefaults domain both key on
 * CFBundleIdentifier, so that is what decides it — and nothing else may, because every
 * name-shaped test produces a wrong answer in one direction or the other:
 *
 *   - `/Applications/Hasna Recordings.app` (id `com.hasna.recordings.launcher`) ends with
 *     "Recordings.app" and exists on disk, so a suffix test accepts a bundle a grant would
 *     do nothing for.
 *   - a renamed bundle (`/Applications/Dictation.app` carrying `com.hasna.recordings`) and a
 *     case variant (`recordings.app` on case-insensitive APFS) are genuinely this app, and
 *     an exact-name test rejects both — the readout then claims "not running" and points the
 *     grant somewhere else entirely.
 *
 * `scripts/install_macos_app.sh` resolves installed copies the same way, by identifier
 * (`mdfind kMDItemCFBundleIdentifier == 'com.hasna.recordings'`).
 *
 * Nothing is lost by dropping the name test: reading the identifier only succeeds for a real
 * bundle, so a wrapper's argument text or a non-bundle path fails on its own.
 */
function isThisApp(candidate: string, readBundleIdentifier: BundleIdentifierReader): boolean {
  return readBundleIdentifier(candidate) === RECORDINGS_BUNDLE_ID;
}

function readDefault(key: string): string | null {
  if (TRIGGER_DEFAULTS_EXECUTABLE === null) return null;
  const result = spawnSync(TRIGGER_DEFAULTS_EXECUTABLE, ["read", RECORDINGS_BUNDLE_ID, key], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function writeDefault(key: string, value: string): void {
  if (TRIGGER_DEFAULTS_EXECUTABLE === null) {
    throw new Error(`cannot write ${key}: this machine has no readable app UserDefaults domain`);
  }
  const result = spawnSync(TRIGGER_DEFAULTS_EXECUTABLE, ["write", RECORDINGS_BUNDLE_ID, key, "-string", value], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`defaults write ${key} failed: ${result.stderr?.trim() || `exit ${result.status}`}`);
  }
}

export function parseStoredShortcut(raw: string | null): Shortcut | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Shortcut>;
    if (typeof parsed.carbonKeyCode !== "number" || typeof parsed.carbonModifiers !== "number") {
      return null;
    }
    return { carbonKeyCode: parsed.carbonKeyCode, carbonModifiers: parsed.carbonModifiers };
  } catch {
    return null;
  }
}

export function readTriggerState(): TriggerState {
  const rawShortcut = readDefault(TOGGLE_RECORDING_DEFAULTS_KEY);
  const rawFn = readDefault(USE_FN_KEY_DEFAULTS_KEY);
  return {
    shortcut: parseStoredShortcut(rawShortcut),
    rawShortcut,
    // `defaults` prints 1/0 for booleans; absent means the Swift default (false).
    useFnKey: rawFn === "1" || rawFn?.toLowerCase() === "true",
  };
}

export function writeShortcut(shortcut: Shortcut): void {
  // Key order matters only for readability; KeyboardShortcuts decodes by name.
  writeDefault(
    TOGGLE_RECORDING_DEFAULTS_KEY,
    JSON.stringify({ carbonKeyCode: shortcut.carbonKeyCode, carbonModifiers: shortcut.carbonModifiers }),
  );
}

export function writeUseFnKey(enabled: boolean): void {
  if (TRIGGER_DEFAULTS_EXECUTABLE === null) {
    throw new Error(
      `cannot write ${USE_FN_KEY_DEFAULTS_KEY}: this machine has no readable app UserDefaults domain`,
    );
  }
  const result = spawnSync(
    TRIGGER_DEFAULTS_EXECUTABLE,
    ["write", RECORDINGS_BUNDLE_ID, USE_FN_KEY_DEFAULTS_KEY, "-bool", enabled ? "true" : "false"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `defaults write ${USE_FN_KEY_DEFAULTS_KEY} failed: ${result.stderr?.trim() || `exit ${result.status}`}`,
    );
  }
}
