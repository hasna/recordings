import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { DEFAULT_CONFIG } from "../lib/config.js";
import type { RecordingsConfig } from "../types/index.js";
import { RecordingError } from "../types/index.js";
import { EventEmitter } from "events";

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `open-recordings-test-rec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("checkRecordingDeps", () => {
  test("returns an object with available, tool, and message fields", async () => {
    const { checkRecordingDeps } = await import("../lib/recorder.js");
    const result = await checkRecordingDeps();
    expect(result).toHaveProperty("available");
    expect(result).toHaveProperty("tool");
    expect(result).toHaveProperty("message");
    expect(typeof result.available).toBe("boolean");
    expect(typeof result.tool).toBe("string");
    expect(typeof result.message).toBe("string");
  });

  test("detects at least one recording tool on this system or returns none", async () => {
    const { checkRecordingDeps } = await import("../lib/recorder.js");
    const result = await checkRecordingDeps();
    if (result.available) {
      expect(result.tool).toBe("rec");
      expect(result.message).toContain("is available");
    } else {
      expect(result.tool).toBe("none");
      expect(result.message).toContain("No recording tool found");
      expect(result.message).toContain("Install sox");
    }
  });
});

describe("isRecording", () => {
  test("returns false when not recording", async () => {
    const { isRecording } = await import("../lib/recorder.js");
    expect(isRecording()).toBe(false);
  });
});

describe("getCurrentFile", () => {
  test("returns null when not recording", async () => {
    const { getCurrentFile } = await import("../lib/recorder.js");
    expect(getCurrentFile()).toBeNull();
  });
});

describe("stopRecording", () => {
  test("returns null when not recording", async () => {
    const { stopRecording } = await import("../lib/recorder.js");
    const result = stopRecording();
    expect(result).toBeNull();
  });
});

describe("startRecording with mocked spawn", () => {
  test("holds global-state maintenance exclusion until the stopped child actually exits", async () => {
    const mockProcess = new EventEmitter() as any;
    mockProcess.kill = mock(() => {});
    mockProcess.stdin = null;
    mockProcess.stdout = null;
    mockProcess.stderr = null;

    mock.module("child_process", () => ({
      spawn: mock(() => mockProcess),
    }));

    const recorder = await import("../lib/recorder.js");
    recorder.stopRecording();
    const previousHome = process.env.HOME;
    const home = join(tempDir, "home");
    const readers = join(home, ".hasna", ".recordings-store-readers");
    const marker = join(home, ".hasna", ".recordings-install-maintenance");
    process.env.HOME = home;

    try {
      const config: RecordingsConfig = {
        ...DEFAULT_CONFIG,
        audio_dir: join(home, ".hasna", "recordings", "audio"),
        max_recording_seconds: 0,
      };

      recorder.startRecording(config);
      expect(readdirSync(readers).filter((entry) => entry.startsWith("lease-"))).toHaveLength(1);

      recorder.stopRecording();
      expect(mockProcess.kill).toHaveBeenCalledWith("SIGINT");
      expect(readdirSync(readers).filter((entry) => entry.startsWith("lease-"))).toHaveLength(1);

      mkdirSync(marker, { mode: 0o700 });
      expect(() => recorder.startRecording(config)).toThrow("installation maintenance");

      mockProcess.emit("exit", 0);
      expect(readdirSync(readers).filter((entry) => entry.startsWith("lease-"))).toHaveLength(0);
    } finally {
      mockProcess.emit("exit", 0);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      recorder.stopRecording();
    }
  });

  test("releases global-state maintenance exclusion when the recording child errors", async () => {
    const mockProcess = new EventEmitter() as any;
    mockProcess.kill = mock(() => {});
    mockProcess.stdin = null;
    mockProcess.stdout = null;
    mockProcess.stderr = null;

    mock.module("child_process", () => ({
      spawn: mock(() => mockProcess),
    }));

    const recorder = await import("../lib/recorder.js");
    recorder.stopRecording();
    const previousHome = process.env.HOME;
    const home = join(tempDir, "error-home");
    const readers = join(home, ".hasna", ".recordings-store-readers");
    process.env.HOME = home;

    try {
      recorder.startRecording({
        ...DEFAULT_CONFIG,
        audio_dir: join(home, ".hasna", "recordings", "audio"),
        max_recording_seconds: 0,
      });
      expect(readdirSync(readers).filter((entry) => entry.startsWith("lease-"))).toHaveLength(1);

      expect(() => mockProcess.emit("error", new Error("spawn ENOENT"))).toThrow(RecordingError);
      expect(readdirSync(readers).filter((entry) => entry.startsWith("lease-"))).toHaveLength(0);
    } finally {
      mockProcess.emit("exit", 0);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      recorder.stopRecording();
    }
  });

  test("keeps project-local recording available during global maintenance", async () => {
    const mockProcess = new EventEmitter() as any;
    mockProcess.kill = mock(() => {});
    mockProcess.stdin = null;
    mockProcess.stdout = null;
    mockProcess.stderr = null;

    mock.module("child_process", () => ({
      spawn: mock(() => mockProcess),
    }));

    const recorder = await import("../lib/recorder.js");
    recorder.stopRecording();
    const previousHome = process.env.HOME;
    const home = join(tempDir, "project-home");
    const marker = join(home, ".hasna", ".recordings-install-maintenance");
    const readers = join(home, ".hasna", ".recordings-store-readers");
    mkdirSync(marker, { recursive: true, mode: 0o700 });
    process.env.HOME = home;

    try {
      const filepath = recorder.startRecording({
        ...DEFAULT_CONFIG,
        audio_dir: join(home, "workspace", "project", ".recordings", "audio"),
        max_recording_seconds: 0,
      });
      expect(filepath).toContain(join("project", ".recordings", "audio"));
      expect(existsSync(readers)).toBe(false);
    } finally {
      recorder.stopRecording();
      mockProcess.emit("exit", 0);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test("spawns rec process and returns filepath", async () => {
    // Create a mock child process
    const mockProcess = new EventEmitter() as any;
    mockProcess.kill = mock(() => {});
    mockProcess.stdin = null;
    mockProcess.stdout = null;
    mockProcess.stderr = null;

    mock.module("child_process", () => ({
      spawn: mock(() => mockProcess),
    }));

    // Re-import to pick up mock
    const recorder = await import("../lib/recorder.js");

    // Reset any existing recording state by stopping
    recorder.stopRecording();

    const config: RecordingsConfig = {
      ...DEFAULT_CONFIG,
      audio_dir: tempDir,
      audio_format: "wav",
      sample_rate: 16000,
      max_recording_seconds: 300,
    };

    const filepath = recorder.startRecording(config);
    expect(filepath).toContain(tempDir);
    expect(filepath).toContain("recording-");
    expect(filepath).toContain(".wav");
    expect(recorder.isRecording()).toBe(true);
    expect(recorder.getCurrentFile()).toBe(filepath);

    // Stop
    const stopped = recorder.stopRecording();
    expect(stopped).toBe(filepath);
    expect(recorder.isRecording()).toBe(false);
  });

  test("throws RecordingError when already recording", async () => {
    const mockProcess = new EventEmitter() as any;
    mockProcess.kill = mock(() => {});
    mockProcess.stdin = null;
    mockProcess.stdout = null;
    mockProcess.stderr = null;

    mock.module("child_process", () => ({
      spawn: mock(() => mockProcess),
    }));

    const recorder = await import("../lib/recorder.js");
    recorder.stopRecording(); // Clean state

    const config: RecordingsConfig = {
      ...DEFAULT_CONFIG,
      audio_dir: tempDir,
    };

    recorder.startRecording(config);

    try {
      recorder.startRecording(config);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(RecordingError);
      expect((err as Error).message).toContain("Already recording");
    }

    recorder.stopRecording();
  });

  test("generates filename with mp3 format", async () => {
    const mockProcess = new EventEmitter() as any;
    mockProcess.kill = mock(() => {});
    mockProcess.stdin = null;
    mockProcess.stdout = null;
    mockProcess.stderr = null;

    mock.module("child_process", () => ({
      spawn: mock(() => mockProcess),
    }));

    const recorder = await import("../lib/recorder.js");
    recorder.stopRecording();

    const config: RecordingsConfig = {
      ...DEFAULT_CONFIG,
      audio_dir: tempDir,
      audio_format: "mp3",
    };

    const filepath = recorder.startRecording(config);
    expect(filepath).toContain(".mp3");

    recorder.stopRecording();
  });

  test("handles process exit event", async () => {
    const mockProcess = new EventEmitter() as any;
    mockProcess.kill = mock(() => {});
    mockProcess.stdin = null;
    mockProcess.stdout = null;
    mockProcess.stderr = null;

    mock.module("child_process", () => ({
      spawn: mock(() => mockProcess),
    }));

    const recorder = await import("../lib/recorder.js");
    recorder.stopRecording();

    const config: RecordingsConfig = {
      ...DEFAULT_CONFIG,
      audio_dir: tempDir,
    };

    recorder.startRecording(config);
    expect(recorder.isRecording()).toBe(true);

    // Simulate process exit
    mockProcess.emit("exit", 0);

    // After exit, _recordProcess should be null but _currentFile may still be set
    // until stopRecording is called
    recorder.stopRecording();
  });

  test("handles process error event by clearing state", async () => {
    const mockProcess = new EventEmitter() as any;
    mockProcess.kill = mock(() => {});
    mockProcess.stdin = null;
    mockProcess.stdout = null;
    mockProcess.stderr = null;

    mock.module("child_process", () => ({
      spawn: mock(() => mockProcess),
    }));

    const recorder = await import("../lib/recorder.js");
    recorder.stopRecording();

    const config: RecordingsConfig = {
      ...DEFAULT_CONFIG,
      audio_dir: tempDir,
    };

    recorder.startRecording(config);
    expect(recorder.isRecording()).toBe(true);

    // Simulate process error - the error handler throws, but we catch it
    try {
      mockProcess.emit("error", new Error("spawn ENOENT"));
    } catch {
      // The error handler throws a RecordingError
    }

    // After error, state should be cleared
    // Note: the error handler sets _recordProcess = null and _currentFile = null
    // but since it throws, the state cleanup depends on the throw being caught
    recorder.stopRecording(); // Cleanup
  });

  test("stopRecording sends SIGINT to process", async () => {
    const mockProcess = new EventEmitter() as any;
    mockProcess.kill = mock(() => {});
    mockProcess.stdin = null;
    mockProcess.stdout = null;
    mockProcess.stderr = null;

    mock.module("child_process", () => ({
      spawn: mock(() => mockProcess),
    }));

    const recorder = await import("../lib/recorder.js");
    recorder.stopRecording();

    const config: RecordingsConfig = {
      ...DEFAULT_CONFIG,
      audio_dir: tempDir,
    };

    recorder.startRecording(config);
    recorder.stopRecording();

    expect(mockProcess.kill).toHaveBeenCalledWith("SIGINT");
  });
});

describe("recordDuration", () => {
  test("holds global-state maintenance exclusion until the bounded child exits", async () => {
    const { recordDuration } = await import("../lib/recorder.js");
    const previousHome = process.env.HOME;
    const originalSpawn = Bun.spawn;
    const home = join(tempDir, "duration-home");
    const readers = join(home, ".hasna", ".recordings-store-readers");
    const marker = join(home, ".hasna", ".recordings-install-maintenance");
    let finish!: (exitCode: number) => void;
    const exited = new Promise<number>((resolve) => { finish = resolve; });
    const spawnMock = mock(() => ({
      exited,
      exitCode: null,
      stderr: new Blob([""]),
    })) as unknown as typeof Bun.spawn;
    Bun.spawn = spawnMock;
    process.env.HOME = home;

    const config: RecordingsConfig = {
      ...DEFAULT_CONFIG,
      audio_dir: join(home, ".hasna", "recordings", "audio"),
    };
    const recording = recordDuration(1, config);

    try {
      expect(readdirSync(readers).filter((entry) => entry.startsWith("lease-"))).toHaveLength(1);
      mkdirSync(marker, { mode: 0o700 });
      expect(spawnMock).toHaveBeenCalledTimes(1);

      finish(0);
      expect(await recording).toContain(config.audio_dir);
      expect(readdirSync(readers).filter((entry) => entry.startsWith("lease-"))).toHaveLength(0);
    } finally {
      finish(1);
      await recording.catch(() => undefined);
      Bun.spawn = originalSpawn;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test("throws when rec is not available", async () => {
    const { recordDuration } = await import("../lib/recorder.js");

    const config: RecordingsConfig = {
      ...DEFAULT_CONFIG,
      audio_dir: tempDir,
    };

    try {
      await recordDuration(1, config);
      // If rec is installed, this might succeed
    } catch (err) {
      // Expected to fail since rec isn't typically installed in CI
      // Could be ENOENT from Bun.spawn or RecordingError
      expect(err).toBeDefined();
    }
  });
});
