import { existsSync, readFileSync, mkdirSync, cpSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { PostProcessingMode, RecordingsConfig } from "../types/index.js";

const POST_PROCESSING_MODES = new Set<PostProcessingMode>([
  "off",
  "auto",
  "always",
]);

export const DEFAULT_CONFIG: RecordingsConfig = {
  openai_api_key: "",
  enhancement_api_key: "",
  transcription_model: "gpt-4o-transcribe",
  enhancement_model: "gpt-4o",
  transcriber_model: "gpt-4o",
  language: "en",
  audio_format: "wav",
  sample_rate: 16000,
  record_command: "sox",
  hotkey: "space",
  transcription_prompt: "",
  transcriber_prompt: "",
  post_processing_mode: "auto",
  auto_enhance: true,
  enhance_triggers: [
    "say it better",
    "rewrite this",
    "make it sound",
    "clean this up",
    "fix this",
    "rephrase",
    "write it properly",
    "make it professional",
    "improve this",
    "polish this",
  ],
  keyword_transforms: {},
  db_path: "",
  audio_dir: "",
  max_recording_seconds: 1800,
};

export function loadConfig(configPath?: string): RecordingsConfig {
  const config = { ...DEFAULT_CONFIG };
  let explicitPostProcessingMode = false;
  let explicitTranscriberModel = false;

  // 1. Load from config file
  const filePath =
    configPath || findConfigFile() || join(getDataDir(), "config.json");

  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const fileConfig = JSON.parse(raw) as Partial<RecordingsConfig>;
      explicitPostProcessingMode = typeof fileConfig.post_processing_mode === "string";
      explicitTranscriberModel = typeof fileConfig.transcriber_model === "string";
      Object.assign(config, expandEnvBackedConfig(fileConfig));
    } catch {
      // Ignore invalid config files
    }
  }

  // 2. Override with env vars
  if (process.env.OPENAI_API_KEY) {
    config.openai_api_key = process.env.OPENAI_API_KEY;
  }
  if (process.env.RECORDINGS_API_KEY) {
    config.openai_api_key = process.env.RECORDINGS_API_KEY;
  }
  if (process.env.RECORDINGS_ENHANCEMENT_KEY) {
    config.enhancement_api_key = process.env.RECORDINGS_ENHANCEMENT_KEY;
  }
  if (process.env.RECORDINGS_MODEL) {
    config.transcription_model = process.env.RECORDINGS_MODEL;
  }
  if (process.env.RECORDINGS_ENHANCEMENT_MODEL) {
    config.enhancement_model = process.env.RECORDINGS_ENHANCEMENT_MODEL;
  }
  if (process.env.RECORDINGS_TRANSCRIBER_MODEL) {
    config.transcriber_model = process.env.RECORDINGS_TRANSCRIBER_MODEL;
    explicitTranscriberModel = true;
  }
  if (process.env.RECORDINGS_LANGUAGE) {
    config.language = process.env.RECORDINGS_LANGUAGE;
  }
  if (process.env.RECORDINGS_TRANSCRIPTION_PROMPT) {
    config.transcription_prompt = process.env.RECORDINGS_TRANSCRIPTION_PROMPT;
  }
  if (process.env.RECORDINGS_TRANSCRIBER_PROMPT) {
    config.transcriber_prompt = process.env.RECORDINGS_TRANSCRIBER_PROMPT;
  }
  if (process.env.RECORDINGS_POST_PROCESSING_MODE) {
    config.post_processing_mode = normalizePostProcessingMode(
      process.env.RECORDINGS_POST_PROCESSING_MODE,
      config.post_processing_mode ?? "auto"
    );
    explicitPostProcessingMode = true;
  }
  if (process.env.RECORDINGS_AUTO_ENHANCE) {
    config.auto_enhance = parseBooleanEnv(
      process.env.RECORDINGS_AUTO_ENHANCE,
      config.auto_enhance
    );
  }
  if (process.env.HASNA_RECORDINGS_DB_PATH) {
    config.db_path = process.env.HASNA_RECORDINGS_DB_PATH;
  } else if (process.env.RECORDINGS_DB_PATH) {
    config.db_path = process.env.RECORDINGS_DB_PATH;
  }
  if (process.env.RECORDINGS_AUDIO_DIR) {
    config.audio_dir = process.env.RECORDINGS_AUDIO_DIR;
  }
  if (process.env.RECORDINGS_MAX_SECONDS) {
    config.max_recording_seconds = parseInt(
      process.env.RECORDINGS_MAX_SECONDS,
      10
    );
  }

  // 3. Load API key from ~/.secrets if not set
  if (!config.openai_api_key) {
    config.openai_api_key = loadSecretKey("OPENAI_API_KEY");
  }
  if (!config.enhancement_api_key) {
    config.enhancement_api_key =
      config.openai_api_key || loadSecretKey("OPENAI_API_KEY");
  }
  if (!explicitTranscriberModel) {
    config.transcriber_model = config.enhancement_model;
  }

  normalizePostProcessingConfig(config, explicitPostProcessingMode);

  // 4. Set defaults for paths
  if (!config.db_path) {
    config.db_path = join(getDataDir(), "recordings.db");
  }
  if (!config.audio_dir) {
    config.audio_dir = join(getDataDir(), "audio");
  }

  return config;
}

export function normalizePostProcessingMode(
  value: string | undefined,
  fallback: PostProcessingMode = "auto"
): PostProcessingMode {
  const mode = value?.trim().toLowerCase();
  if (mode && POST_PROCESSING_MODES.has(mode as PostProcessingMode)) {
    return mode as PostProcessingMode;
  }
  return fallback;
}

export function normalizePostProcessingConfig(
  config: RecordingsConfig,
  preferPostProcessingMode = true
): RecordingsConfig {
  if (preferPostProcessingMode) {
    config.post_processing_mode = normalizePostProcessingMode(
      config.post_processing_mode,
      "auto"
    );
    config.auto_enhance = config.post_processing_mode !== "off";
    return config;
  }

  if (config.auto_enhance === false) {
    config.post_processing_mode = "off";
  } else {
    config.post_processing_mode = normalizePostProcessingMode(
      config.post_processing_mode,
      "auto"
    );
  }
  config.auto_enhance = config.post_processing_mode !== "off";
  return config;
}

function parseBooleanEnv(value: string, fallback: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function expandEnvBackedConfig(config: Partial<RecordingsConfig>): Partial<RecordingsConfig> {
  const expanded = { ...config };

  for (const key of ["openai_api_key", "enhancement_api_key"] as const) {
    const value = expanded[key];
    if (typeof value === "string" && value.startsWith("$") && value.length > 1) {
      expanded[key] = process.env[value.slice(1)] || value;
    }
  }

  return expanded;
}

function findConfigFile(): string | null {
  // Walk up from cwd looking for .recordings/config.json
  let dir = process.cwd();
  const root = "/";
  while (dir !== root) {
    const candidate = join(dir, ".recordings", "config.json");
    if (existsSync(candidate)) return candidate;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function getDataDir(): string {
  // Check for .recordings in cwd hierarchy (project-local)
  let dir = process.cwd();
  const root = "/";
  while (dir !== root) {
    const candidate = join(dir, ".recordings");
    if (existsSync(candidate)) return candidate;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }

  // Global: ~/.hasna/recordings (with backward compat from ~/.recordings)
  const home = homedir();
  const newDir = join(home, ".hasna", "recordings");
  const oldDir = join(home, ".recordings");

  // Auto-migrate from old location if new dir doesn't exist yet
  if (!existsSync(newDir) && existsSync(oldDir)) {
    try {
      mkdirSync(join(home, ".hasna"), { recursive: true });
      cpSync(oldDir, newDir, { recursive: true });
    } catch {
      // Fall through to use new dir
    }
  }

  return newDir;
}

function loadSecretKey(keyName: string): string {
  const secretsPath = join(homedir(), ".secrets");
  if (!existsSync(secretsPath)) return "";

  for (const candidate of listSecretFiles(secretsPath)) {
    try {
      const content = readFileSync(candidate, "utf-8");
      const match = content.match(
        new RegExp(`export\\s+${keyName}\\s*=\\s*"([^"]+)"`)
      );
      if (match) return match[1]!;

      const match2 = content.match(
        new RegExp(`export\\s+${keyName}\\s*=\\s*'([^']+)'`)
      );
      if (match2) return match2[1]!;

      const match3 = content.match(new RegExp(`${keyName}\\s*=\\s*(.+)`));
      if (match3) return match3[1]!.trim().replace(/^["']|["']$/g, "");
    } catch {
      // Ignore unreadable secret files
    }
  }

  return "";
}

function listSecretFiles(path: string): string[] {
  try {
    const stats = statSync(path);
    if (stats.isFile()) return [path];
    if (!stats.isDirectory()) return [];

    return readdirSync(path)
      .sort()
      .flatMap((entry) => {
        const child = join(path, entry);
        try {
          const childStats = statSync(child);
          if (childStats.isDirectory()) return listSecretFiles(child);
          if (childStats.isFile() && child.endsWith(".env")) return [child];
        } catch {
          // Ignore entries that disappear or are unreadable
        }
        return [];
      });
  } catch {
    return [];
  }
}

export function ensureDataDir(config: RecordingsConfig): void {
  const { mkdirSync } = require("fs") as typeof import("fs");
  mkdirSync(config.audio_dir, { recursive: true });

  // Ensure db directory exists
  const dbDir = config.db_path.substring(
    0,
    config.db_path.lastIndexOf("/")
  );
  if (dbDir) mkdirSync(dbDir, { recursive: true });
}
