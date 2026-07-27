import { spawnSync } from "child_process";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { RecordingsConfig } from "../types/index.js";
import { checkRecordingDeps } from "./recorder.js";

/**
 * Why this module exists.
 *
 * On macOS a process that has NOT been granted the Microphone TCC permission
 * does not fail when it opens an input device. CoreAudio hands it
 * ZERO-FILLED buffers instead. `rec` therefore exits 0 and writes a
 * correctly-sized, structurally valid WAV file that contains digital silence.
 *
 * Observed on station03 (macOS 26.5.1) with Microphone = not_determined:
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

/**
 * Read the peak amplitude of a 16-bit PCM WAV file.
 *
 * Walks the RIFF chunk list rather than assuming a fixed 44-byte header, since
 * sox emits a LIST/INFO chunk ahead of `data` for some output formats.
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
  let bitsPerSample = 16;
  let dataStart = -1;
  let dataLength = 0;

  while (offset + CHUNK_HEADER_BYTES <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const body = offset + CHUNK_HEADER_BYTES;

    if (chunkId === "fmt " && body + 16 <= buf.length) {
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (chunkId === "data") {
      dataStart = body;
      // Trust the file length over the declared size: a truncated capture
      // still carries usable samples and must not read out of bounds.
      dataLength = Math.min(chunkSize, buf.length - body);
      break;
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + chunkSize + (chunkSize % 2);
  }

  if (dataStart < 0) {
    throw new Error(`no data chunk in WAV: ${filepath}`);
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
  /** True when the capture produced digital silence. */
  silent: boolean;
  message: string;
}

export const DEFAULT_PROBE_SECONDS = 1;

/**
 * Actually capture from the microphone and assert that signal arrived.
 *
 * This records for `seconds` (default 1) and fails when the result is digital
 * silence, which on macOS is the signature of a missing Microphone grant.
 */
export function probeMicrophoneCapture(
  config: RecordingsConfig,
  options: { seconds?: number } = {}
): CaptureProbeResult {
  const seconds = options.seconds ?? DEFAULT_PROBE_SECONDS;
  const base: Omit<CaptureProbeResult, "ok" | "message"> = {
    tool: null,
    seconds,
    samples: 0,
    peak: 0,
    silent: true,
  };

  const executable =
    process.env.RECORDINGS_TEST_RECORD_EXECUTABLE || "rec";
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
      { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" }
    );

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

    const tool = "rec";
    if (peak.samples === 0) {
      return {
        ...base,
        tool,
        ok: false,
        message: "capture produced no samples",
      };
    }
    if (peak.peak === 0) {
      // Name the subject. The grant this probe needs belongs to whatever is
      // responsible for THIS process, not to Recordings.app, and conflating the
      // two sends the reader to a pane that will not fix anything.
      const subject = captureProbeSubject();
      return {
        ...base,
        tool,
        samples: peak.samples,
        ok: false,
        silent: true,
        message:
          `captured ${peak.samples} samples of digital silence (peak 0.000000). ` +
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
  /** True when this process cannot be shown a TCC prompt at all. */
  headless: boolean;
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
 *
 * Over SSH it is worse than ambiguous: there is no GUI session to display a
 * consent prompt, so the status stays `not_determined` forever and a silent
 * capture proves nothing about the app. Say so instead of implying a verdict.
 */
export function captureProbeSubject(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): CaptureProbeSubject {
  if (process.platform !== "darwin") {
    return {
      headless: false,
      subject: "this process",
      note: "microphone access is not gated by TCC on this platform",
    };
  }

  const overSsh = Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
  const termProgram = env.TERM_PROGRAM?.trim();
  const subject = overSsh
    ? "the SSH session (sshd), not Recordings.app"
    : `${termProgram || "the terminal application running this command"}, not Recordings.app`;

  return {
    headless: overSsh,
    subject,
    note: overSsh
      ? "Running over SSH: macOS cannot display a consent prompt to a session with no GUI, " +
        "so Microphone stays not_determined and a silent capture here says NOTHING about " +
        "whether Recordings.app can record. Judge the app by its own TCC entry and its log."
      : `Grants are per responsible process: this probe exercises ${subject}. ` +
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

export const RECORDINGS_BUNDLE_IDENTIFIER = "com.hasna.recordings";

/**
 * Whether a reported permission state proves the app has ever asked for consent.
 *
 * Only a definite authorization decision does. `not_determined` means it never
 * asked; so does anything the reporter could not resolve — including the
 * `ambiguous_multiple_installations` value emitted when several bundles exist,
 * which REPLACES the permission value rather than qualifying it. Treating an
 * unresolved state as "already asked" suppresses the one line that explains why
 * the Settings list has no Recordings row, which is the loop people get stuck in.
 */
export function permissionStateProvesRequest(permissionState: string): boolean {
  return (
    permissionState.startsWith("allowed") ||
    permissionState.startsWith("denied") ||
    permissionState.startsWith("limited")
  );
}

/**
 * Build the instruction a human must follow at the keyboard, naming the exact
 * pane, section, control and bundle.
 *
 * Microphone consent CANNOT be granted remotely: `tccutil` only resets entries,
 * there is no supported way to insert an authorization, and the user TCC.db is
 * SIP-protected. The only paths are the app's own request prompt or the Settings
 * toggle — and the toggle only exists once the app has asked at least once, so
 * the request must come first. "Grant Microphone" on its own is not actionable;
 * this spells out what to click and which binary receives it.
 */
export function microphoneGrantInstruction(options: {
  /** Path the installer treats as canonical. */
  installedAppPath?: string | null;
  /** Other Recordings.app bundles found on disk (e.g. legacy install sites). */
  otherAppPaths?: string[];
  /** Whether the app has ever prompted, i.e. whether a TCC row exists. */
  everRequested?: boolean;
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
  if (options.everRequested === false) {
    steps.push(
      "Note: the app has never requested microphone access on this machine (no TCC entry exists), " +
        "so the Microphone list will NOT contain a “Recordings” row until the app asks once. " +
        "Do the launch-and-record step first; the Settings toggle only exists afterwards."
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
