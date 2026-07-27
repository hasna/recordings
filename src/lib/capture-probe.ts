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
      return {
        ...base,
        tool,
        samples: peak.samples,
        ok: false,
        silent: true,
        message:
          process.platform === "darwin"
            ? `captured ${peak.samples} samples of digital silence (peak 0.000000). ` +
              "On macOS this is what a process WITHOUT the Microphone permission receives — " +
              "CoreAudio zero-fills its buffers instead of returning an error. " +
              "Grant Microphone to Recordings.app, or check that the input device is not hardware-muted."
            : `captured ${peak.samples} samples of digital silence (peak 0.000000). ` +
              "The input device delivered no signal — check that it is selected and not muted.",
      };
    }

    return {
      tool,
      seconds,
      samples: peak.samples,
      peak: peak.peak,
      silent: false,
      ok: true,
      message: `captured ${peak.samples} samples, peak amplitude ${peak.peak.toFixed(6)}`,
    };
  } finally {
    rmSync(filepath, { force: true });
  }
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
