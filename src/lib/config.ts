import { copyFileSync, existsSync, readFileSync, mkdirSync, readdirSync, realpathSync, statSync } from "fs";
import { dirname, join, resolve, sep } from "path";
import { homedir } from "os";
import type { PostProcessingMode, RecordingsConfig } from "../types/index.js";
import {
  acquireLocalStoreReaderLease,
  isGlobalRecordingsStatePath,
} from "./install-maintenance.js";

const POST_PROCESSING_MODES = new Set<PostProcessingMode>([
  "off",
  "auto",
  "always",
]);
export const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
export const DEFAULT_REALTIME_SESSION_MODEL = "gpt-realtime";
export const DEFAULT_REALTIME_TRANSCRIPTION_MODEL = "gpt-realtime-whisper";

export const DEFAULT_CONFIG: RecordingsConfig = {
  openai_api_key: "",
  enhancement_api_key: "",
  transcription_model: DEFAULT_TRANSCRIPTION_MODEL,
  realtime_session_model: DEFAULT_REALTIME_SESSION_MODEL,
  realtime_transcription_model: DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
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
  config_warnings: [],
};

export function loadConfig(configPath?: string): RecordingsConfig {
  const config = { ...DEFAULT_CONFIG };
  config.config_warnings = [];
  let explicitPostProcessingMode = false;
  let explicitTranscriberModel = false;

  // 1. Load from config file
  const filePath =
    configPath || findConfigFile() || join(getDataDir(), "config.json");

  // Track whether the config file explicitly supplied an OpenAI key. When it
  // does, that deliberate app-level setting must win over an *ambient* generic
  // OPENAI_API_KEY. Bun auto-loads `.env` from the process cwd, so a stray
  // OPENAI_API_KEY in the working directory (e.g. the MCP service running from
  // $HOME) would otherwise silently clobber the configured key and yield 401s.
  let fileProvidedOpenAIKey = false;
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const fileConfig = JSON.parse(raw) as Partial<RecordingsConfig>;
      const expanded = expandEnvBackedConfig(fileConfig);
      explicitPostProcessingMode = typeof fileConfig.post_processing_mode === "string";
      explicitTranscriberModel = typeof fileConfig.transcriber_model === "string";
      Object.assign(config, expanded);
      fileProvidedOpenAIKey =
        typeof expanded.openai_api_key === "string" &&
        expanded.openai_api_key.length > 0;
    } catch {
      // Ignore invalid config files
    }
  }

  // 2. Override with env vars.
  // Generic OPENAI_API_KEY only applies when the config file did NOT set one,
  // so an ambient/auto-loaded key can't hijack an explicitly configured key.
  // The recordings-namespaced RECORDINGS_API_KEY is always a deliberate opt-in
  // override and keeps its precedence below.
  if (process.env.OPENAI_API_KEY && !fileProvidedOpenAIKey) {
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
  if (process.env.RECORDINGS_REALTIME_SESSION_MODEL) {
    config.realtime_session_model = process.env.RECORDINGS_REALTIME_SESSION_MODEL;
  }
  if (process.env.RECORDINGS_REALTIME_TRANSCRIPTION_MODEL) {
    config.realtime_transcription_model = process.env.RECORDINGS_REALTIME_TRANSCRIPTION_MODEL;
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

  normalizeModelSlots(config);
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

export function normalizeModelSlots(config: RecordingsConfig): RecordingsConfig {
  const warnings = config.config_warnings ?? [];
  config.config_warnings = warnings;

  const boundedModel = config.transcription_model?.trim() || DEFAULT_TRANSCRIPTION_MODEL;
  if (isRealtimeOnlyModel(boundedModel)) {
    warnings.push(
      `Ignoring RECORDINGS_MODEL=${boundedModel}; bounded transcription uses ${DEFAULT_TRANSCRIPTION_MODEL}.`
    );
    config.transcription_model = DEFAULT_TRANSCRIPTION_MODEL;
  } else {
    config.transcription_model = boundedModel;
  }

  const realtimeSessionModel = config.realtime_session_model?.trim() || DEFAULT_REALTIME_SESSION_MODEL;
  if (isTranscriptionOnlyModel(realtimeSessionModel)) {
    warnings.push(
      `Ignoring realtime session model ${realtimeSessionModel}; use ${DEFAULT_REALTIME_TRANSCRIPTION_MODEL} as realtime_transcription_model instead.`
    );
    config.realtime_session_model = DEFAULT_REALTIME_SESSION_MODEL;
  } else {
    config.realtime_session_model = realtimeSessionModel;
  }

  const realtimeTranscriptionModel = config.realtime_transcription_model?.trim()
    || DEFAULT_REALTIME_TRANSCRIPTION_MODEL;
  if (!isRealtimeTranscriptionModel(realtimeTranscriptionModel)) {
    warnings.push(
      `Ignoring realtime transcription model ${realtimeTranscriptionModel}; realtime transcription uses ${DEFAULT_REALTIME_TRANSCRIPTION_MODEL}.`
    );
    config.realtime_transcription_model = DEFAULT_REALTIME_TRANSCRIPTION_MODEL;
  } else {
    config.realtime_transcription_model = realtimeTranscriptionModel;
  }

  return config;
}

export function isTranscriptionOnlyModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m === "whisper-1"
    || m === DEFAULT_REALTIME_TRANSCRIPTION_MODEL
    || m.includes("transcribe");
}

function isRealtimeOnlyModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m.startsWith("gpt-realtime");
}

function isRealtimeTranscriptionModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m === DEFAULT_REALTIME_TRANSCRIPTION_MODEL
    || (m.startsWith("gpt-realtime") && m.includes("whisper"));
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
    const releaseLease = acquireLocalStoreReaderLease();
    try {
      try {
        if (existsSync(oldDir)) mergeDirectoryContents(oldDir, newDir);
      } catch {
        // Fall through to use new dir
      }
    } finally {
      releaseLease();
    }
  }

  return newDir;
}

function findProjectRecordingsPath(entry?: string): string | null {
  const cwd = canonicalExistingPath(process.cwd());
  const home = canonicalExistingPath(getHomeDir());
  const repositoryRoot = findRepositoryRoot(cwd);
  const cwdIsInsideHome = cwd === home || cwd.startsWith(`${home}${sep}`);
  const repositoryIsInsideHome = repositoryRoot !== null &&
    repositoryRoot !== home &&
    repositoryRoot.startsWith(`${home}${sep}`);
  const boundary = cwdIsInsideHome
    ? (repositoryIsInsideHome ? repositoryRoot! : home)
    : (repositoryRoot ?? cwd);
  const excludeBoundary = boundary === home;
  let dir = cwd;

  while (true) {
    if (excludeBoundary && dir === boundary) break;
    const candidate = entry
      ? join(dir, ".recordings", entry)
      : join(dir, ".recordings");
    if (existsSync(candidate)) return candidate;
    if (dir === boundary) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findRepositoryRoot(start: string): string | null {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
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
  const dbDir = config.db_path.substring(
    0,
    config.db_path.lastIndexOf("/")
  );
  const releaseLease = [config.audio_dir, dbDir]
    .some((path) => path.length > 0 && isGlobalRecordingsStatePath(path))
    ? acquireLocalStoreReaderLease()
    : () => {};

  try {
    mkdirSync(config.audio_dir, { recursive: true });
    if (dbDir) mkdirSync(dbDir, { recursive: true });
  } finally {
    releaseLease();
  }
}
