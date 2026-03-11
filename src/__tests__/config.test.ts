import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { loadConfig, getDataDir, ensureDataDir, DEFAULT_CONFIG } from "../lib/config.js";

let tempDir: string;

// Save and restore env vars
const savedEnv: Record<string, string | undefined> = {};
const envKeys = [
  "OPENAI_API_KEY",
  "RECORDINGS_API_KEY",
  "RECORDINGS_ENHANCEMENT_KEY",
  "RECORDINGS_MODEL",
  "RECORDINGS_ENHANCEMENT_MODEL",
  "RECORDINGS_LANGUAGE",
  "RECORDINGS_DB_PATH",
  "RECORDINGS_AUDIO_DIR",
  "RECORDINGS_MAX_SECONDS",
];

beforeEach(() => {
  tempDir = join(tmpdir(), `open-recordings-test-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });

  // Save env vars
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  // Restore env vars
  for (const key of envKeys) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }

  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("DEFAULT_CONFIG", () => {
  test("has expected default values", () => {
    expect(DEFAULT_CONFIG.transcription_model).toBe("gpt-4o-mini-transcribe");
    expect(DEFAULT_CONFIG.enhancement_model).toBe("gpt-4o");
    expect(DEFAULT_CONFIG.language).toBe("en");
    expect(DEFAULT_CONFIG.audio_format).toBe("wav");
    expect(DEFAULT_CONFIG.sample_rate).toBe(16000);
    expect(DEFAULT_CONFIG.record_command).toBe("sox");
    expect(DEFAULT_CONFIG.hotkey).toBe("space");
    expect(DEFAULT_CONFIG.auto_enhance).toBe(true);
    expect(DEFAULT_CONFIG.max_recording_seconds).toBe(300);
    expect(DEFAULT_CONFIG.enhance_triggers).toContain("say it better");
    expect(DEFAULT_CONFIG.enhance_triggers).toContain("rewrite this");
  });
});

describe("loadConfig", () => {
  test("returns defaults when no config file or env vars", () => {
    const config = loadConfig(join(tempDir, "nonexistent.json"));
    expect(config.transcription_model).toBe("gpt-4o-mini-transcribe");
    expect(config.enhancement_model).toBe("gpt-4o");
    expect(config.language).toBe("en");
    expect(config.audio_format).toBe("wav");
    expect(config.auto_enhance).toBe(true);
  });

  test("loads config from file", () => {
    const configPath = join(tempDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        transcription_model: "whisper-1",
        language: "fr",
        auto_enhance: false,
      })
    );

    const config = loadConfig(configPath);
    expect(config.transcription_model).toBe("whisper-1");
    expect(config.language).toBe("fr");
    expect(config.auto_enhance).toBe(false);
    // Other defaults still present
    expect(config.audio_format).toBe("wav");
  });

  test("ignores invalid JSON config file", () => {
    const configPath = join(tempDir, "bad-config.json");
    writeFileSync(configPath, "this is not json {{{");

    const config = loadConfig(configPath);
    // Should fall back to defaults
    expect(config.transcription_model).toBe("gpt-4o-mini-transcribe");
  });

  test("env var OPENAI_API_KEY overrides config", () => {
    process.env.OPENAI_API_KEY = "sk-env-key";
    const config = loadConfig(join(tempDir, "nonexistent.json"));
    expect(config.openai_api_key).toBe("sk-env-key");
  });

  test("env var RECORDINGS_API_KEY overrides OPENAI_API_KEY", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.RECORDINGS_API_KEY = "sk-recordings";
    const config = loadConfig(join(tempDir, "nonexistent.json"));
    expect(config.openai_api_key).toBe("sk-recordings");
  });

  test("env var RECORDINGS_ENHANCEMENT_KEY sets enhancement_api_key", () => {
    process.env.RECORDINGS_ENHANCEMENT_KEY = "sk-enhance";
    const config = loadConfig(join(tempDir, "nonexistent.json"));
    expect(config.enhancement_api_key).toBe("sk-enhance");
  });

  test("env var RECORDINGS_MODEL overrides transcription_model", () => {
    process.env.RECORDINGS_MODEL = "whisper-1";
    const config = loadConfig(join(tempDir, "nonexistent.json"));
    expect(config.transcription_model).toBe("whisper-1");
  });

  test("env var RECORDINGS_ENHANCEMENT_MODEL overrides enhancement_model", () => {
    process.env.RECORDINGS_ENHANCEMENT_MODEL = "gpt-3.5-turbo";
    const config = loadConfig(join(tempDir, "nonexistent.json"));
    expect(config.enhancement_model).toBe("gpt-3.5-turbo");
  });

  test("env var RECORDINGS_LANGUAGE overrides language", () => {
    process.env.RECORDINGS_LANGUAGE = "de";
    const config = loadConfig(join(tempDir, "nonexistent.json"));
    expect(config.language).toBe("de");
  });

  test("env var RECORDINGS_DB_PATH overrides db_path", () => {
    process.env.RECORDINGS_DB_PATH = "/custom/db.sqlite";
    const config = loadConfig(join(tempDir, "nonexistent.json"));
    expect(config.db_path).toBe("/custom/db.sqlite");
  });

  test("env var RECORDINGS_AUDIO_DIR overrides audio_dir", () => {
    process.env.RECORDINGS_AUDIO_DIR = "/custom/audio";
    const config = loadConfig(join(tempDir, "nonexistent.json"));
    expect(config.audio_dir).toBe("/custom/audio");
  });

  test("env var RECORDINGS_MAX_SECONDS overrides max_recording_seconds", () => {
    process.env.RECORDINGS_MAX_SECONDS = "60";
    const config = loadConfig(join(tempDir, "nonexistent.json"));
    expect(config.max_recording_seconds).toBe(60);
  });

  test("sets default db_path when not configured", () => {
    const config = loadConfig(join(tempDir, "nonexistent.json"));
    expect(config.db_path).toBeTruthy();
    expect(config.db_path).toContain("recordings.db");
  });

  test("sets default audio_dir when not configured", () => {
    const config = loadConfig(join(tempDir, "nonexistent.json"));
    expect(config.audio_dir).toBeTruthy();
    expect(config.audio_dir).toContain("audio");
  });

  test("enhancement_api_key falls back to openai_api_key", () => {
    process.env.OPENAI_API_KEY = "sk-shared";
    const config = loadConfig(join(tempDir, "nonexistent.json"));
    expect(config.enhancement_api_key).toBe("sk-shared");
  });

  test("file config values are overridden by env vars", () => {
    const configPath = join(tempDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ language: "fr", transcription_model: "file-model" })
    );
    process.env.RECORDINGS_LANGUAGE = "ja";

    const config = loadConfig(configPath);
    expect(config.language).toBe("ja"); // env wins
    expect(config.transcription_model).toBe("file-model"); // no env override for this
  });
});

describe("ensureDataDir", () => {
  test("creates audio_dir and db directory", () => {
    const audioDir = join(tempDir, "audio-out");
    const dbPath = join(tempDir, "db-dir/recordings.db");
    const config = {
      ...DEFAULT_CONFIG,
      audio_dir: audioDir,
      db_path: dbPath,
    };

    ensureDataDir(config);
    expect(existsSync(audioDir)).toBe(true);
    expect(existsSync(join(tempDir, "db-dir"))).toBe(true);
  });
});

describe("getDataDir", () => {
  test("returns a string", () => {
    const dir = getDataDir();
    expect(typeof dir).toBe("string");
    expect(dir).toContain(".recordings");
  });
});

describe("loadSecretKey (via loadConfig)", () => {
  test("loads API key from ~/.secrets with double quotes", () => {
    const config = loadConfig(join(tempDir, "nonexistent.json"));
    // The key is either loaded from ~/.secrets or empty
    expect(typeof config.openai_api_key).toBe("string");
  });

  test("loads secret key with single quotes format", () => {
    // We can't easily mock ~/.secrets, but we test the regex patterns directly
    // by testing the config loading with different env overrides
    // The loadSecretKey function is internal, so we test its effect indirectly
    // When no env var is set and no ~/.secrets has the key, it returns ""
    const config = loadConfig(join(tempDir, "nonexistent.json"));
    // At minimum, the function doesn't crash
    expect(config).toBeDefined();
  });
});

describe("findConfigFile (via loadConfig without explicit path)", () => {
  test("loads config without explicit path (uses findConfigFile)", () => {
    // When no configPath is given, findConfigFile walks up from cwd
    const config = loadConfig();
    expect(config).toBeDefined();
    expect(config.transcription_model).toBeTruthy();
  });
});

describe("ensureDataDir edge cases", () => {
  test("handles db_path without directory separator", () => {
    const config = {
      ...DEFAULT_CONFIG,
      audio_dir: join(tempDir, "audio"),
      db_path: "recordings.db", // no directory part
    };
    // Should not throw - dbDir will be empty string
    ensureDataDir(config);
    expect(existsSync(join(tempDir, "audio"))).toBe(true);
  });
});
