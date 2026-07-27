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

export const RECORDINGS_BUNDLE_ID = "com.hasna.recordings";

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

  const keyToken = keyTokens[0]!;
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
  const result = spawnSync(
    "/usr/bin/defaults",
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

const defaultProcessLister: ProcessLister = () => {
  // `comm=` prints the executable path and nothing else. `args=` would include arguments,
  // and a wrapper such as `/bin/sh -c /path/Recordings.app/...` would then make the start
  // of the path ambiguous — the pattern below cannot tell an argument boundary from a
  // directory name once spaces are legal in the path. `-ww` stops ps truncating to the
  // terminal width, which would silently cut long bundle paths short.
  const result = spawnSync("/bin/ps", ["-Awwo", "comm="], { encoding: "utf8" });
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
      if (!isThisApp(candidate, readBundleIdentifier)) continue;
      paths.add(candidate);
      break;
    }
  }
  return [...paths].sort();
}

/**
 * Whether a path is a bundle of *this* app.
 *
 * The identifier is the invariant, not the name: TCC grants and the UserDefaults domain
 * both key on CFBundleIdentifier. A sibling bundle called "Hasna Recordings.app" whose id
 * is `com.hasna.recordings.launcher` ends with "Recordings.app" and exists on disk, but a
 * grant given to it does nothing for this app — naming it would send the owner to enable
 * the wrong row in the Accessibility list. Check the last path component exactly, then
 * confirm the identifier.
 */
function isThisApp(candidate: string, readBundleIdentifier: BundleIdentifierReader): boolean {
  if (candidate.slice(candidate.lastIndexOf("/") + 1) !== "Recordings.app") return false;
  return readBundleIdentifier(candidate) === RECORDINGS_BUNDLE_ID;
}

function readDefault(key: string): string | null {
  const result = spawnSync("/usr/bin/defaults", ["read", RECORDINGS_BUNDLE_ID, key], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function writeDefault(key: string, value: string): void {
  const result = spawnSync("/usr/bin/defaults", ["write", RECORDINGS_BUNDLE_ID, key, "-string", value], {
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
  const result = spawnSync(
    "/usr/bin/defaults",
    ["write", RECORDINGS_BUNDLE_ID, USE_FN_KEY_DEFAULTS_KEY, "-bool", enabled ? "true" : "false"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `defaults write ${USE_FN_KEY_DEFAULTS_KEY} failed: ${result.stderr?.trim() || `exit ${result.status}`}`,
    );
  }
}
