import { copyFileSync, existsSync, readFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { homedir } from "os";
import type { RecordingsConfig } from "../types/index.js";

export const DEFAULT_CONFIG: RecordingsConfig = {
  openai_api_key: "",
  enhancement_api_key: "",
  transcription_model: "gpt-4o-transcribe",
  enhancement_model: "gpt-4o",
  language: "en",
  audio_format: "wav",
  sample_rate: 16000,
  record_command: "sox",
  hotkey: "space",
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

  // 1. Load from config file
  const filePath =
    configPath || findConfigFile() || join(getDataDir(), "config.json");

  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const fileConfig = JSON.parse(raw) as Partial<RecordingsConfig>;
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
  if (process.env.RECORDINGS_LANGUAGE) {
    config.language = process.env.RECORDINGS_LANGUAGE;
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

  // 4. Set defaults for paths
  if (!config.db_path) {
    config.db_path = join(getDataDir(), "recordings.db");
  }
  if (!config.audio_dir) {
    config.audio_dir = join(getDataDir(), "audio");
  }

  return config;
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
  return findProjectRecordingsPath("config.json");
}

export function getDataDir(): string {
  // Check for .recordings in cwd hierarchy (project-local)
  const projectLocalDir = findProjectRecordingsPath();
  if (projectLocalDir) return projectLocalDir;

  // Global: ~/.hasna/recordings (with backward compat from ~/.recordings)
  const home = getHomeDir();
  const newDir = join(home, ".hasna", "recordings");
  const oldDir = join(home, ".recordings");

  // Auto-migrate from old location without overwriting newer target files.
  if (existsSync(oldDir)) {
    try {
      mergeDirectoryContents(oldDir, newDir);
    } catch {
      // Fall through to use new dir
    }
  }

  return newDir;
}

function findProjectRecordingsPath(entry?: string): string | null {
  const home = resolve(getHomeDir());
  let dir = resolve(process.cwd());
  while (true) {
    if (dir !== home) {
      const candidate = entry
        ? join(dir, ".recordings", entry)
        : join(dir, ".recordings");
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function mergeDirectoryContents(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir)) {
    const sourcePath = join(sourceDir, entry);
    const targetPath = join(targetDir, entry);
    const sourceStats = statSync(sourcePath);
    if (sourceStats.isDirectory()) {
      mergeDirectoryContents(sourcePath, targetPath);
    } else if (!existsSync(targetPath)) {
      copyFileSync(sourcePath, targetPath);
    }
  }
}

function loadSecretKey(keyName: string): string {
  const secretsPath = join(getHomeDir(), ".secrets");
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

function getHomeDir(): string {
  return process.env["HOME"] || process.env["USERPROFILE"] || homedir();
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
