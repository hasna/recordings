import { spawn, type ChildProcess } from "child_process";
import { join } from "path";
import { existsSync } from "fs";
import type { RecordingsConfig } from "../types/index.js";
import { RecordingError } from "../types/index.js";

let _recordProcess: ChildProcess | null = null;
let _currentFile: string | null = null;

/**
 * Check if sox/rec is available for recording
 */
export async function checkRecordingDeps(): Promise<{
  available: boolean;
  tool: string;
  message: string;
}> {
  // Check for sox
  try {
    const proc = Bun.spawn(["which", "sox"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    if (proc.exitCode === 0) {
      return { available: true, tool: "sox", message: "sox is available" };
    }
  } catch {
    // Not available
  }

  // Check for rec (part of sox)
  try {
    const proc = Bun.spawn(["which", "rec"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    if (proc.exitCode === 0) {
      return { available: true, tool: "rec", message: "rec is available" };
    }
  } catch {
    // Not available
  }

  // Check for ffmpeg
  try {
    const proc = Bun.spawn(["which", "ffmpeg"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    if (proc.exitCode === 0) {
      return {
        available: true,
        tool: "ffmpeg",
        message: "ffmpeg is available",
      };
    }
  } catch {
    // Not available
  }

  return {
    available: false,
    tool: "none",
    message:
      "No recording tool found. Install sox: brew install sox (macOS) or apt install sox (Linux)",
  };
}

/**
 * Start recording audio from microphone
 */
export function startRecording(config: RecordingsConfig): string {
  if (_recordProcess) {
    throw new RecordingError("Already recording. Stop the current recording first.");
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `recording-${timestamp}.${config.audio_format}`;
  const filepath = join(config.audio_dir, filename);

  // Build sox/rec command based on config
  const args = buildRecordArgs(filepath, config);

  _recordProcess = spawn(args[0]!, args.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
  });

  _currentFile = filepath;

  _recordProcess.on("error", (err) => {
    _recordProcess = null;
    _currentFile = null;
    throw new RecordingError(`Recording process error: ${err.message}`);
  });

  _recordProcess.on("exit", () => {
    _recordProcess = null;
  });

  return filepath;
}

/**
 * Stop the current recording
 */
export function stopRecording(): string | null {
  if (!_recordProcess) {
    return null;
  }

  const filepath = _currentFile;

  // Send SIGINT to gracefully stop sox/rec
  _recordProcess.kill("SIGINT");
  _recordProcess = null;
  _currentFile = null;

  return filepath;
}

/**
 * Check if currently recording
 */
export function isRecording(): boolean {
  return _recordProcess !== null;
}

/**
 * Get current recording file path
 */
export function getCurrentFile(): string | null {
  return _currentFile;
}

function buildRecordArgs(filepath: string, config: RecordingsConfig): string[] {
  const format = config.audio_format;
  const rate = config.sample_rate;
  const maxSeconds = config.max_recording_seconds;

  // Use rec (sox) for recording — most reliable cross-platform
  // rec outputs to file, auto-detects input device
  return [
    "rec",
    "-r",
    rate.toString(),
    "-c",
    "1", // mono
    "-b",
    "16", // 16-bit
    filepath,
    "trim",
    "0",
    maxSeconds.toString(),
  ];
}

/**
 * Record for a specific duration (non-interactive)
 */
export async function recordDuration(
  seconds: number,
  config: RecordingsConfig
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `recording-${timestamp}.${config.audio_format}`;
  const filepath = join(config.audio_dir, filename);

  const args = [
    "rec",
    "-r",
    config.sample_rate.toString(),
    "-c",
    "1",
    "-b",
    "16",
    filepath,
    "trim",
    "0",
    seconds.toString(),
  ];

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0 && !existsSync(filepath)) {
    const stderr = await new Response(proc.stderr).text();
    throw new RecordingError(`Recording failed (exit ${exitCode}): ${stderr}`);
  }

  return filepath;
}
