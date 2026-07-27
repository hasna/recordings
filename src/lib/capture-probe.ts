import { spawnSync } from "child_process";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { RecordingsConfig } from "../types/index.js";
import { checkRecordingDeps } from "./recorder.js";
import { RECORDINGS_BUNDLE_IDENTIFIER, TCC_DATABASE_UNREADABLE_STATE } from "./macos-bundle.js";

/**
 * Why this module exists.
 *
 * On macOS a process that has NOT been granted the Microphone TCC permission
 * does not fail when it opens an input device. CoreAudio hands it
 * ZERO-FILLED buffers instead. `rec` therefore exits 0 and writes a
 * correctly-sized, structurally valid WAV file that contains digital silence.
 *
 * Observed on a fleet Mac (macOS 26) with Microphone = not_determined:
 *   $ rec -q -c 1 -r 16000 /tmp/probe.wav trim 0 1   # exit 0, 64080 bytes
 *   $ sox /tmp/probe.wav -n stat                      # Maximum amplitude: 0.000000
 *
 * Consequence: exit status, file existence and file size prove NOTHING about
 * whether capture works. The only sound evidence is signal amplitude. Every
 * capture check in this package must therefore assert on amplitude.
 */

/** Peak amplitude of a 16-bit PCM WAV, normalised to 0..1. */
export interface WavPeak {
  samples: number;
  peak: number;
}

const RIFF_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const INT16_FULL_SCALE = 32768;
const FMT_CHUNK_MIN_BYTES = 16;
const WAVE_FORMAT_PCM = 1;
/**
 * WAVE_FORMAT_EXTENSIBLE. Legitimate uncompressed PCM whose real format lives in
 * a SubFormat GUID in the fmt extension; CoreAudio writers emit it. Rejecting it
 * outright would turn a real capture into "could not read captured audio".
 */
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
/** First 2 bytes of KSDATAFORMAT_SUBTYPE_PCM, which is little-endian 0x0001. */
const SUBFORMAT_OFFSET_IN_EXTENSION = 8;

/**
 * Read the peak amplitude of a 16-bit PCM WAV file.
 *
 * Walks the RIFF chunk list rather than assuming a fixed 44-byte header, since
 * sox emits a LIST/INFO chunk ahead of `data` for some output formats.
 *
 * The whole list is scanned before anything is decoded. Stopping at `data`
 * looked like a harmless optimisation and was not: RIFF does not mandate chunk
 * order, so a file with `data` ahead of `fmt ` left the format unread and fell
 * back to "assume 16-bit PCM" — which silently reinterpreted 32-bit float
 * samples as integers and reported a plausible, wrong peak. A format this
 * function cannot decode must raise, never guess.
 *
 * KNOWN LIMIT, stated rather than implied. Two of the robustness measures above do NOT compose:
 * a file with `data` ahead of `fmt ` AND an over-declared `data` size (a truncated capture) has
 * no recoverable format. The declared size is a lie, so the bytes following the data body are
 * indistinguishable from audio payload without pattern-matching for a `fmt ` signature — and
 * guessing the format is precisely what this function refuses to do. It raises instead. The chunk
 * walk is clamped to the file length so the scan cannot run off the end, which is as far as
 * ground truth reaches. Not reachable from sox output; documented because the two guarantees read
 * as if they compose and they do not.
 */
export function readWavPeak(filepath: string): WavPeak {
  const buf = readFileSync(filepath);
  if (buf.length < RIFF_HEADER_BYTES) {
    throw new Error(`not a RIFF file (${buf.length} bytes): ${filepath}`);
  }
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`not a RIFF/WAVE file: ${filepath}`);
  }

  let offset = RIFF_HEADER_BYTES;
  let bitsPerSample: number | null = null;
  let formatTag: number | null = null;
  let dataStart = -1;
  let dataLength = 0;

  while (offset + CHUNK_HEADER_BYTES <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const body = offset + CHUNK_HEADER_BYTES;

    if (chunkId === "fmt " && formatTag === null) {
      // Size the read off the DECLARED chunk length, not the remaining file. A
      // truncated fmt chunk otherwise reads the next chunk's header as
      // bitsPerSample (0x6164 = "da" from `data` = 24932 bits).
      if (chunkSize < FMT_CHUNK_MIN_BYTES || body + FMT_CHUNK_MIN_BYTES > buf.length) {
        throw new Error(
          `truncated fmt chunk (${chunkSize} bytes, need ${FMT_CHUNK_MIN_BYTES}): ${filepath}`
        );
      }
      formatTag = buf.readUInt16LE(body);
      bitsPerSample = buf.readUInt16LE(body + 14);

      // Resolve EXTENSIBLE to the format it actually carries. cbSize is at
      // fmt+16 and the SubFormat GUID starts at fmt+18; its first 2 bytes hold
      // the equivalent format tag.
      if (formatTag === WAVE_FORMAT_EXTENSIBLE) {
        const extensionStart = body + FMT_CHUNK_MIN_BYTES;
        const subFormatAt = extensionStart + SUBFORMAT_OFFSET_IN_EXTENSION;
        if (chunkSize < FMT_CHUNK_MIN_BYTES + 10 || subFormatAt + 2 > buf.length) {
          throw new Error(
            `WAVE_FORMAT_EXTENSIBLE without a readable SubFormat GUID: ${filepath}`
          );
        }
        formatTag = buf.readUInt16LE(subFormatAt);
      }
    } else if (chunkId === "data" && dataStart < 0) {
      dataStart = body;
      const remaining = buf.length - body;
      // Trust the file length over the declared size: a truncated capture
      // still carries usable samples and must not read out of bounds.
      //
      // A declared size of 0 is the inverse trap and used to win: `Math.min(0, remaining)` made a
      // `data` chunk that carries real audio report "capture produced no samples", which is a
      // FALSE FAILURE — and for a package whose app demonstrably records, a false failure costs
      // as much as a hidden real one. Zero means "size not filled in", not "no audio", so fall
      // back to the rest of the file.
      dataLength = chunkSize === 0 ? remaining : Math.min(chunkSize, remaining);
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    //
    // Clamped to the file length so an over-declared size cannot push `offset` past EOF and
    // silently end the scan early. The file's actual length is ground truth; the declared size is
    // the thing that may be lying.
    const declaredAdvance = chunkSize + (chunkSize % 2);
    offset = body + Math.min(declaredAdvance, Math.max(0, buf.length - body));
  }

  if (dataStart < 0) {
    throw new Error(`no data chunk in WAV: ${filepath}`);
  }
  if (bitsPerSample === null || formatTag === null) {
    throw new Error(`no fmt chunk in WAV, so the sample format is unknown: ${filepath}`);
  }
  if (formatTag !== WAVE_FORMAT_PCM) {
    throw new Error(
      `expected uncompressed PCM (format tag ${WAVE_FORMAT_PCM}), got tag ${formatTag}: ${filepath}`
    );
  }
  if (bitsPerSample !== 16) {
    throw new Error(`expected 16-bit PCM, got ${bitsPerSample}-bit: ${filepath}`);
  }

  const samples = Math.floor(dataLength / 2);
  let maxAbs = 0;
  for (let i = 0; i < samples; i++) {
    const value = Math.abs(buf.readInt16LE(dataStart + i * 2));
    if (value > maxAbs) maxAbs = value;
  }

  return { samples, peak: maxAbs / INT16_FULL_SCALE };
}

export interface CaptureProbeResult {
  ok: boolean;
  tool: string | null;
  seconds: number;
  samples: number;
  /** Normalised 0..1 peak amplitude. Exactly 0 means no signal reached us. */
  peak: number;
  /**
   * `true` when a capture happened and its amplitude was at or below
   * `SILENCE_PEAK_THRESHOLD`; `false` when a capture happened and carried signal;
   * **`null` when no amplitude was measured at all**.
   *
   * The null state is the point. This used to be a plain `boolean` defaulted to `true` on the
   * shared `base` object, so every early return inherited it — a missing `rec` binary reported
   * `silent=true samples=0 peak=0`, and a `--json` consumer reading `capture_probe.silent`
   * concluded "the microphone delivered digital silence" when no capture was ever attempted.
   * That is the same conflation of "could not measure" with "measured a bad value" that this
   * module exists to remove, reproduced inside the module itself.
   */
  silent: boolean | null;
  message: string;
}

export const DEFAULT_PROBE_SECONDS = 1;
export const MAX_PROBE_SECONDS = 60;
export const DEFAULT_RECORD_EXECUTABLE = "rec";

/**
 * Amplitude at or below which a capture counts as no signal.
 *
 * Not exactly zero. A device can emit a trickle of dither or preamp noise while
 * delivering nothing, and `peak === 0` would call that a pass. One LSB is
 * 0.0000305; this threshold is ~33 LSB (32.77), still 40x below the 0.040466 peak
 * of a real quiet dictation measured on a fleet Mac, so genuine speech passes with
 * wide margin while a dead input does not.
 *
 * The multiplier read "80x" until review recomputed it: 0.040466 / 0.001 is 40.5,
 * not 80. The threshold value itself measures correctly — verified at the boundary,
 * int16 peak 32 fails and 34 passes — so only the stated margin was wrong. Corrected
 * rather than left, because an overstated margin inside the justification for a
 * threshold is the same defect class this module exists to remove.
 */
export const SILENCE_PEAK_THRESHOLD = 0.001;

/** Wall-clock headroom over the requested duration before `rec` is killed. */
const PROBE_TIMEOUT_GRACE_MS = 10_000;

/**
 * Actually capture from the microphone and assert that signal arrived.
 *
 * This records for `seconds` (default 1) and fails when the result carries no
 * signal, which on macOS is the signature of a missing Microphone grant.
 *
 * `executable` is injected rather than read from the environment. It used to be
 * `process.env.RECORDINGS_TEST_RECORD_EXECUTABLE || "rec"` — a test hook in the
 * shipped path, letting an env var choose which program this runs, in a package
 * whose own diagnostics exist because invisible inherited env vars caused an
 * outage. The repo idiom is injection (see cli/macos-permissions.ts).
 */
export function probeMicrophoneCapture(
  config: RecordingsConfig,
  options: { seconds?: number; executable?: string; timeoutMs?: number } = {}
): CaptureProbeResult {
  const requested = options.seconds ?? DEFAULT_PROBE_SECONDS;
  const seconds = Math.min(Math.max(requested, 1), MAX_PROBE_SECONDS);
  const executable = options.executable ?? DEFAULT_RECORD_EXECUTABLE;
  const base: Omit<CaptureProbeResult, "ok" | "message"> = {
    tool: null,
    seconds,
    samples: 0,
    peak: 0,
    // `null`, not `true`. Every early return below inherits this object, and none of them measured
    // an amplitude — the recorder timed out, failed to spawn, wrote no file, or wrote something
    // unreadable. Only the branch that actually reads a peak may state a verdict here.
    silent: null,
  };

  const filepath = join(
    tmpdir(),
    `recordings-capture-probe-${process.pid}-${Date.now()}.wav`
  );

  try {
    const result = spawnSync(
      executable,
      [
        "-q",
        "-r",
        String(config.sample_rate),
        "-c",
        "1",
        "-b",
        "16",
        filepath,
        "trim",
        "0",
        String(seconds),
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        encoding: "utf8",
        // Without this, `rec` blocked on a busy or absent CoreAudio device hangs
        // the whole command forever with no output.
        timeout: options.timeoutMs ?? seconds * 1000 + PROBE_TIMEOUT_GRACE_MS,
      }
    );

    if (result.signal) {
      return {
        ...base,
        ok: false,
        message:
          `'${executable}' did not finish within ` +
          `${((options.timeoutMs ?? seconds * 1000 + PROBE_TIMEOUT_GRACE_MS) / 1000).toFixed(1)}s ` +
          `and was killed (${result.signal}). The input device is most likely busy or absent.`,
      };
    }
    if (result.error) {
      return {
        ...base,
        ok: false,
        message: `could not run '${executable}': ${result.error.message}`,
      };
    }
    if (!existsSync(filepath)) {
      const stderr = (result.stderr || "").trim();
      return {
        ...base,
        ok: false,
        message: `'${executable}' wrote no audio file${stderr ? `: ${stderr}` : ""}`,
      };
    }

    let peak: WavPeak;
    try {
      peak = readWavPeak(filepath);
    } catch (error) {
      return {
        ...base,
        ok: false,
        message: `could not read captured audio: ${(error as Error).message}`,
      };
    }

    const tool = executable;
    if (peak.samples === 0) {
      return {
        ...base,
        tool,
        ok: false,
        message: "capture produced no samples",
      };
    }
    if (peak.peak <= SILENCE_PEAK_THRESHOLD) {
      // Name the subject. The grant this probe needs belongs to whatever is
      // responsible for THIS process, not to Recordings.app, and conflating the
      // two sends the reader to a pane that will not fix anything.
      const subject = captureProbeSubject();
      return {
        ...base,
        tool,
        samples: peak.samples,
        peak: peak.peak,
        ok: false,
        silent: true,
        message:
          `captured ${peak.samples} samples with no usable signal ` +
          `(peak ${peak.peak.toFixed(6)}, at or below the ${SILENCE_PEAK_THRESHOLD} silence threshold). ` +
          (process.platform === "darwin"
            ? "On macOS this is what a process WITHOUT the Microphone permission receives — " +
              "CoreAudio zero-fills its buffers instead of returning an error. " +
              "Also rule out a hardware-muted or unselected input device. "
            : "The input device delivered no signal — check that it is selected and not muted. ") +
          `This probe's capture is attributed to ${subject.subject}. ${subject.note}`,
      };
    }

    return {
      tool,
      seconds,
      samples: peak.samples,
      peak: peak.peak,
      silent: false,
      ok: true,
      // State the limit of the claim in the same breath as the claim. A pass
      // proves a live device delivered signal to THIS process; the app holds a
      // separate grant and can still be silent.
      message:
        `captured ${peak.samples} samples, peak amplitude ${peak.peak.toFixed(6)} ` +
        `(proves capture for ${captureProbeSubject().subject})`,
    };
  } finally {
    rmSync(filepath, { force: true });
  }
}

export interface CaptureProbeSubject {
  /** True when this process is known to have no GUI session to be prompted in. */
  headless: boolean;
  /**
   * False when the responsible process could not be identified. An unidentified
   * subject must not be narrated as if it were a local terminal.
   */
  subject_known: boolean;
  /** What macOS will attribute the probe's microphone access to. */
  subject: string;
  note: string;
}

/**
 * Name whose Microphone grant this probe actually exercises.
 *
 * macOS attributes microphone access to the RESPONSIBLE process — for a CLI that
 * is the terminal application (or sshd), never Recordings.app. So a silent probe
 * means "the thing running this command has no grant", which is a different
 * finding, with a different fix, from "the app has no grant". Reporting the one
 * as the other is how a diagnostic sends someone to the wrong settings pane.
 * The user TCC db bears this out: it tracks `tmux` and `bun` as separate clients
 * with their own grants, independent of any app bundle.
 *
 * Detection is deliberately three-valued. An earlier version inferred "local
 * terminal" from the absence of SSH variables, which is wrong in the environment
 * this org actually drives these machines from: tmux snapshots the environment
 * when a pane is created and never refreshes it, so inside a pane SSH_CONNECTION
 * and TERM_PROGRAM are both absent even though the session is remote. `sudo`
 * (env_reset), launchd and cron produce the same false negative. When the
 * subject cannot be identified, say so rather than emit the reassuring note.
 */
export function captureProbeSubject(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  options: { platform?: string; hasTty?: boolean } = {}
): CaptureProbeSubject {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      headless: false,
      subject_known: true,
      subject: "this process",
      note: "microphone access is not gated by TCC on this platform",
    };
  }

  const overSsh = Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
  const inTmux = Boolean(env.TMUX || env.TMUX_PANE);
  const termProgram = env.TERM_PROGRAM?.trim();
  const hasTty = options.hasTty ?? Boolean(process.stdin.isTTY || process.stdout.isTTY);

  if (overSsh) {
    const subject = "the SSH session (sshd), not Recordings.app";
    return {
      headless: true,
      subject_known: true,
      subject,
      note:
        "Running over SSH: macOS cannot display a consent prompt to a session with no GUI, " +
        "so Microphone stays not_determined and a silent capture here says NOTHING about " +
        "whether Recordings.app can record. Judge the app by its own TCC entry and its log.",
    };
  }

  if (inTmux) {
    const subject = "the tmux server, not Recordings.app and not this pane's shell";
    return {
      headless: false,
      subject_known: true,
      subject,
      note:
        "Running inside tmux: TCC attributes this capture to the tmux binary, which holds its " +
        "own grant. tmux also snapshots the environment at pane creation, so SSH variables may " +
        "be missing even in a remote session — treat a silent result as inconclusive about both " +
        "Recordings.app and about whether anyone could have been prompted.",
    };
  }

  if (!termProgram && !hasTty) {
    return {
      headless: true,
      subject_known: false,
      subject: "an unidentified responsible process (not Recordings.app)",
      note:
        "The responsible process could not be identified: no SSH variables, no TERM_PROGRAM and " +
        "no tty, which is what launchd, cron, CI and sudo look like. Whatever holds the grant, it " +
        "is not Recordings.app, and nothing here can be shown a consent prompt. Inconclusive.",
    };
  }

  const subject = `${termProgram || "the terminal application running this command"}, not Recordings.app`;
  return {
    headless: false,
    subject_known: Boolean(termProgram),
    subject,
    note:
      `Grants are per responsible process: this probe exercises ${subject}. ` +
      "A pass proves the microphone hardware and the input device work; it does not " +
      "transfer to Recordings.app, which needs its own grant.",
  };
}

export interface MicrophoneGrantInstruction {
  /** The bundle that must receive the grant, or null when none was found. */
  bundle_path: string | null;
  bundle_identifier: string;
  /** Every Recordings.app on disk — more than one makes the grant ambiguous. */
  candidate_bundle_paths: string[];
  /** Ordered steps, already naming the pane, the section and the bundle. */
  steps: string[];
}

export { RECORDINGS_BUNDLE_IDENTIFIER };

/**
 * Value the TCC reader returns when a database existed but could not be read.
 *
 * Rebase note (#24 x #25): this used to be its own literal,
 * `"unreadable_no_full_disk_access"`, because this branch also owned the reader that produced
 * it. #24 replaced that reader with `resolveTccGrant()` in `cli/macos-permissions.ts`, which
 * reports the same condition as `"undetermined_tcc_database_unreadable"`. Two different strings
 * for one condition made every `=== TCC_UNREADABLE_STATE` comparison in the `check` renderer
 * dead code, so a refused database read fell through to the red "denied" branch and printed
 * grant instructions for a permission that may already have been granted — the exact false
 * statement this module exists to remove.
 *
 * The name is kept because it is part of the package's public surface; only the value moves, to
 * the single definition both sides now read.
 */
export const TCC_UNREADABLE_STATE = TCC_DATABASE_UNREADABLE_STATE;

/**
 * Has the app ever asked the user for this permission?
 *
 * Three-valued on purpose, and that is the whole point. The previous boolean
 * collapsed "I could not read the database" into "it never asked", so on a box
 * where TCC was unreadable — every tmux pane on the affected machine, because it had no
 * Full Disk Access — the CLI asserted "the app has never requested microphone
 * access (no TCC entry exists)" while the row
 * `kTCCServiceMicrophone|com.hasna.recordings|2` demonstrably existed. Emitting a
 * confident false statement to the operator is the exact failure this module was
 * written to remove, so unknown must stay unknown.
 *
 * `unknown` (TCC auth_value 1) counts as REQUESTED: a row exists, so the app has
 * asked and the Settings list will contain a Recordings entry.
 */
export type PermissionRequestState = "requested" | "never_requested" | "unknown";

export function classifyPermissionState(permissionState: string): PermissionRequestState {
  // The question this answers is "does a TCC row exist for this service", because that is what
  // decides whether a Recordings toggle is present in System Settings yet. Any row — allowed,
  // denied, limited, or an auth_value we do not recognise — means the app has asked.
  //
  // Rebase note (#24 x #25): the prefix tests below were written against this branch's own
  // reader, which suffixed EVERY readable row with `_identity_unverified`, so `"unknown_..."`
  // and `"allowed_..."` covered the row-exists cases by construction. #24's `resolveTccGrant()`
  // is now the only producer and it returns bare `"unknown"` for auth_value 1 and the
  // unprefixed `"stale_allowed_for_previous_app_build"` / `"unverified_no_installed_bundle"`
  // for allowed rows it could not bind to the installed bundle. Under the old prefix tests all
  // three fell through to `"unknown"`, downgrading three states that positively prove the app
  // has asked. `src/__tests__/tcc-state-contract.test.ts` pins every member of
  // `TccAuthorizationState` against this function so a state added later cannot fall through
  // silently.
  switch (permissionState) {
    // A row exists and carries a decision.
    case "allowed":
    case "allowed_identity_unverified":
    case "denied":
    case "limited":
    case "unknown":
    // Allowed rows whose stored code requirement could not be bound to the installed bundle.
    // The binding is unproven; the row's existence is not.
    case "stale_allowed_for_previous_app_build":
    case "unverified_no_installed_bundle":
      return "requested";
    case "not_determined":
      return "never_requested";
    default:
      break;
  }
  // `unknown(<n>)` is an auth_value this build does not have a label for. The row still exists.
  if (permissionState.startsWith("unknown(")) return "requested";
  // RETIRED VOCABULARY, deliberately still tolerated. Before #24 this branch's own reader
  // suffixed every readable row with `_identity_unverified`, producing `denied_identity_unverified`,
  // `limited_identity_unverified`, `unknown_identity_unverified` and `unknown(<n>)_identity_unverified`.
  // No code path emits those today — only `allowed_identity_unverified` survived, and it is handled
  // as a live state above. This stays because `recordings check --json` output is routinely captured
  // and re-read later (agents paste it into task records), so a blob written by an older build can
  // still arrive here; classifying it as `unknown` would turn a row that demonstrably exists into
  // "cannot tell". Scoped to the exact retired suffix, and pinned by
  // `src/__tests__/tcc-state-contract.test.ts` so it is removed deliberately rather than by drift.
  if (permissionState.endsWith("_identity_unverified")) return "requested";
  // Anything else is a reporter-level failure to resolve, not an answer about the app:
  // TCC_UNREADABLE_STATE, ambiguous_multiple_installations, unsupported.
  return "unknown";
}

/**
 * Build the instruction a human must follow at the keyboard, naming the exact
 * pane, section, control and bundle.
 *
 * Microphone consent CANNOT be granted remotely: `tccutil` only resets entries
 * (`tccutil reset SERVICE [BUNDLE_ID]` is its entire interface — there is no
 * insert), and the user TCC.db is SIP-protected so it is not writable even as
 * root. MDM/PPPC profiles can pre-approve many TCC services, but Apple restricts
 * Camera and Microphone to deny-only by profile, so for Microphone specifically
 * a human at the keyboard is the only path. The Settings toggle only exists once
 * the app has asked at least once, so the request must come first.
 * "Grant Microphone" on its own is not actionable; this spells out what to click
 * and which binary receives it.
 */
export function microphoneGrantInstruction(options: {
  /** Path the installer treats as canonical. */
  installedAppPath?: string | null;
  /** Other Recordings.app bundles found on disk (e.g. legacy install sites). */
  otherAppPaths?: string[];
  /**
   * Whether the app has ever prompted. `unknown` means the TCC state could not
   * be resolved and MUST NOT be narrated as "it never asked".
   */
  requestState?: PermissionRequestState;
}): MicrophoneGrantInstruction {
  const candidates = [options.installedAppPath, ...(options.otherAppPaths ?? [])]
    .filter((path): path is string => Boolean(path))
    .filter((path, index, all) => all.indexOf(path) === index)
    .filter((path) => existsSync(path));

  const bundlePath = candidates[0] ?? null;
  const steps: string[] = [];

  if (!bundlePath) {
    steps.push(
      "No Recordings.app bundle was found on disk, so there is nothing to grant Microphone to yet. " +
        "Install the app first ('recordings app install')."
    );
    return {
      bundle_path: null,
      bundle_identifier: RECORDINGS_BUNDLE_IDENTIFIER,
      candidate_bundle_paths: candidates,
      steps,
    };
  }

  if (candidates.length > 1) {
    steps.push(
      `AMBIGUOUS: ${candidates.length} Recordings.app bundles exist (${candidates.join(", ")}). ` +
        "A TCC grant is bound to the bundle's code signature, so granting one does not grant the " +
        "other, and the toggle in Settings does not say which is which. Remove the bundles you are " +
        "not running before granting, or the grant may attach to the wrong one."
    );
  }

  steps.push(
    `At the keyboard on the machine itself (not over SSH), launch ${bundlePath} and start a ` +
      "recording once. macOS shows the consent sheet titled " +
      `"“Recordings” would like to access the microphone" — click Allow.`
  );
  steps.push(
    "If no sheet appears, open System Settings → Privacy & Security → Microphone " +
      "and switch ON the row named “Recordings”. " +
      `That row is bundle ${RECORDINGS_BUNDLE_IDENTIFIER} at ${bundlePath}; the binary that ` +
      `receives the grant is ${join(bundlePath, "Contents", "MacOS", "Recordings")}.`
  );
  if (options.requestState === "never_requested") {
    steps.push(
      "Note: the app has never requested microphone access on this machine (no TCC entry exists), " +
        "so the Microphone list will NOT contain a “Recordings” row until the app asks once. " +
        "Do the launch-and-record step first; the Settings toggle only exists afterwards."
    );
  } else if (options.requestState === "unknown") {
    // Never assert "no entry exists" from a failed read. Full Disk Access is held by the
    // SESSION's responsible process and inherited by its children, not by the tool named in the
    // command — measured on a fleet Mac, `bun` is explicitly DENIED (auth_value=0) yet reads
    // TCC.db over SSH, because it inherits sshd-keygen-wrapper's SystemPolicyAllFiles grant.
    // Saying "tmux and bun lack it" invites granting Full Disk Access to tmux or bun, which is
    // not what governs. Also note `sudo` CHANGES the responsible process and has produced a
    // false "unreadable" here.
    steps.push(
      "Note: whether the app has already asked could NOT be determined — the permission state " +
        `did not resolve (e.g. ${TCC_UNREADABLE_STATE}: the user TCC database could not be read). ` +
        "So a “Recordings” row may or may not already be in the Microphone list. Full Disk Access " +
        "is inherited from the session's responsible process, not granted per-tool, so re-read the " +
        "state from a plain ssh shell (whose parent holds it) rather than granting it to tmux or " +
        "bun — and not under sudo, which changes the responsible process. Do not conclude anything " +
        "from this state alone."
    );
  }
  steps.push(
    "Confirm afterwards with 'recordings app status --json' — microphone_permission must read " +
      "allowed, and a fresh line in ~/.hasna/recordings/Recordings.log must read " +
      "'RecordingEngine init; microphone=Microphone allowed'."
  );
  steps.push(
    "The grant is bound to the bundle's code signature: re-signing or rebuilding the app with a " +
      "different identity voids it and this instruction has to be repeated."
  );

  return {
    bundle_path: bundlePath,
    bundle_identifier: RECORDINGS_BUNDLE_IDENTIFIER,
    candidate_bundle_paths: candidates,
    steps,
  };
}

/**
 * Guard so callers do not probe when `rec` is missing entirely — that is a
 * different, clearer failure and deserves its own message.
 */
export async function captureProbePrecondition(): Promise<{
  ready: boolean;
  message: string;
}> {
  const deps = await checkRecordingDeps();
  return deps.available
    ? { ready: true, message: deps.message }
    : { ready: false, message: deps.message };
}
