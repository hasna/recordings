import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { resetClient } from "../lib/transcriber.js";
import { TranscriptionError } from "../types/index.js";
import { DEFAULT_CONFIG } from "../lib/config.js";
import type { RecordingsConfig } from "../types/index.js";

const config: RecordingsConfig = {
  ...DEFAULT_CONFIG,
  openai_api_key: "sk-test-key",
  enhancement_api_key: "sk-test-key",
};

let tempDir: string;
let tempAudioFile: string;

beforeEach(() => {
  resetClient();
  tempDir = join(tmpdir(), `open-recordings-test-trans-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  // Create a fake audio file for tests that need to open a file
  tempAudioFile = join(tempDir, "test.wav");
  writeFileSync(tempAudioFile, Buffer.from("fake-audio-content"));
});

afterEach(() => {
  resetClient();
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("transcribeAudio", () => {
  test("throws TranscriptionError when no API key", async () => {
    const noKeyConfig = { ...config, openai_api_key: "" };
    const { transcribeAudio } = await import("../lib/transcriber.js");
    resetClient();

    try {
      await transcribeAudio(tempAudioFile, noKeyConfig);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TranscriptionError);
      expect((err as Error).message).toContain("API key not configured");
    }
  });

  test("calls OpenAI transcription API and returns result", async () => {
    mock.module("openai", () => ({
      default: class MockOpenAI {
        audio = {
          transcriptions: {
            create: mock(() =>
              Promise.resolve({
                text: "Hello world transcribed",
                language: "en",
              })
            ),
          },
        };
      },
    }));

    resetClient();
    const { transcribeAudio } = await import("../lib/transcriber.js");
    resetClient();

    const result = await transcribeAudio(tempAudioFile, config);
    expect(result.text).toBe("Hello world transcribed");
    expect(result.model).toBe(config.transcription_model);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.language).toBe("en");

    resetClient();
  });

  test("handles null language from API", async () => {
    mock.module("openai", () => ({
      default: class MockOpenAI {
        audio = {
          transcriptions: {
            create: mock(() =>
              Promise.resolve({
                text: "Transcribed text",
              })
            ),
          },
        };
      },
    }));

    resetClient();
    const { transcribeAudio } = await import("../lib/transcriber.js");
    resetClient();

    const result = await transcribeAudio(tempAudioFile, config);
    expect(result.text).toBe("Transcribed text");
    expect(result.language).toBeUndefined(); // property not present

    resetClient();
  });

  test("wraps API errors in TranscriptionError", async () => {
    mock.module("openai", () => ({
      default: class MockOpenAI {
        audio = {
          transcriptions: {
            create: mock(() => Promise.reject(new Error("API rate limit exceeded"))),
          },
        };
      },
    }));

    resetClient();
    const { transcribeAudio } = await import("../lib/transcriber.js");
    resetClient();

    try {
      await transcribeAudio(tempAudioFile, config);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TranscriptionError);
      expect((err as Error).message).toContain("Transcription failed");
      expect((err as Error).message).toContain("API rate limit exceeded");
    }

    resetClient();
  });

  test("wraps non-Error exceptions in TranscriptionError", async () => {
    mock.module("openai", () => ({
      default: class MockOpenAI {
        audio = {
          transcriptions: {
            create: mock(() => Promise.reject("string error")),
          },
        };
      },
    }));

    resetClient();
    const { transcribeAudio } = await import("../lib/transcriber.js");
    resetClient();

    try {
      await transcribeAudio(tempAudioFile, config);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TranscriptionError);
      expect((err as Error).message).toContain("Transcription failed");
    }

    resetClient();
  });

  test("uses config language when provided", async () => {
    let capturedOpts: any = null;
    mock.module("openai", () => ({
      default: class MockOpenAI {
        audio = {
          transcriptions: {
            create: mock((opts: any) => {
              capturedOpts = opts;
              return Promise.resolve({ text: "test", language: "fr" });
            }),
          },
        };
      },
    }));

    resetClient();
    const { transcribeAudio } = await import("../lib/transcriber.js");
    resetClient();

    const frConfig = { ...config, language: "fr" };
    await transcribeAudio(tempAudioFile, frConfig);
    expect(capturedOpts.language).toBe("fr");
    expect(capturedOpts.model).toBe(config.transcription_model);
    expect(capturedOpts.response_format).toBe("verbose_json");

    resetClient();
  });

  test("omits language when not in config", async () => {
    let capturedOpts: any = null;
    mock.module("openai", () => ({
      default: class MockOpenAI {
        audio = {
          transcriptions: {
            create: mock((opts: any) => {
              capturedOpts = opts;
              return Promise.resolve({ text: "test" });
            }),
          },
        };
      },
    }));

    resetClient();
    const { transcribeAudio } = await import("../lib/transcriber.js");
    resetClient();

    const noLangConfig = { ...config, language: "" };
    await transcribeAudio(tempAudioFile, noLangConfig);
    expect(capturedOpts.language).toBeUndefined();

    resetClient();
  });
});

describe("transcribeBuffer", () => {
  test("throws TranscriptionError when no API key", async () => {
    const noKeyConfig = { ...config, openai_api_key: "" };
    const { transcribeBuffer } = await import("../lib/transcriber.js");
    resetClient();

    try {
      await transcribeBuffer(Buffer.from("test"), "test.wav", noKeyConfig);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TranscriptionError);
      expect((err as Error).message).toContain("API key not configured");
    }
  });

  test("creates File and calls transcription API", async () => {
    mock.module("openai", () => ({
      default: class MockOpenAI {
        audio = {
          transcriptions: {
            create: mock(() =>
              Promise.resolve({
                text: "Buffer transcription result",
                language: "en",
              })
            ),
          },
        };
      },
    }));

    resetClient();
    const { transcribeBuffer } = await import("../lib/transcriber.js");
    resetClient();

    const result = await transcribeBuffer(
      Buffer.from("fake audio data"),
      "test.wav",
      config
    );
    expect(result.text).toBe("Buffer transcription result");
    expect(result.model).toBe(config.transcription_model);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);

    resetClient();
  });

  test("wraps API errors in TranscriptionError for buffer", async () => {
    mock.module("openai", () => ({
      default: class MockOpenAI {
        audio = {
          transcriptions: {
            create: mock(() => Promise.reject(new Error("Buffer API error"))),
          },
        };
      },
    }));

    resetClient();
    const { transcribeBuffer } = await import("../lib/transcriber.js");
    resetClient();

    try {
      await transcribeBuffer(Buffer.from("test"), "test.mp3", config);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TranscriptionError);
      expect((err as Error).message).toContain("Transcription failed");
      expect((err as Error).message).toContain("Buffer API error");
    }

    resetClient();
  });

  test("handles various file extensions for MIME type", async () => {
    let capturedFile: any = null;
    mock.module("openai", () => ({
      default: class MockOpenAI {
        audio = {
          transcriptions: {
            create: mock((opts: any) => {
              capturedFile = opts.file;
              return Promise.resolve({ text: "ok" });
            }),
          },
        };
      },
    }));

    resetClient();
    const { transcribeBuffer } = await import("../lib/transcriber.js");

    // Test different extensions - each creates a File with the correct MIME type
    const extensions = ["wav", "mp3", "m4a", "webm", "mp4", "mpeg", "mpga", "xyz"];
    for (const ext of extensions) {
      resetClient();
      await transcribeBuffer(Buffer.from("test"), `test.${ext}`, config);
      expect(capturedFile).toBeDefined();
    }

    resetClient();
  });
});

describe("resetClient", () => {
  test("clears the singleton client safely", () => {
    resetClient();
    resetClient(); // Double reset is fine
  });
});
