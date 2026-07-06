// ── Types ───────────────────────────────────────────────────────────────────
export type {
  Recording,
  CreateRecordingInput,
  RecordingFilter,
  ProcessingMode,
  Agent,
  Project,
  RecordingsConfig,
  TranscriptionResult,
  EnhancementResult,
} from "./types/index.js";

export {
  RecordingNotFoundError,
  RecordingError,
  TranscriptionError,
  EnhancementError,
} from "./types/index.js";

// ── Database ────────────────────────────────────────────────────────────────
export {
  getDatabase,
  closeDatabase,
  resetDatabase,
  getDbPath,
  shortUuid,
} from "./db/database.js";
export { PgAdapterAsync } from "./db/remote-storage.js";
export {
  RECORDINGS_STORAGE_ENV,
  RECORDINGS_STORAGE_FALLBACK_ENV,
  RECORDINGS_STORAGE_MODE_ENV,
  RECORDINGS_STORAGE_MODE_FALLBACK_ENV,
  STORAGE_DATABASE_ENV,
  STORAGE_MODE_ENV,
  getStorageConfig,
  getStorageConnectionString,
  getConnectionString,
  getStorageDatabaseEnv,
  getStorageDatabaseEnvName,
  getStorageDatabaseUrl,
  type StorageConfig,
  type StorageEnv,
  type StorageMode,
} from "./db/storage-config.js";
export {
  RECORDINGS_STORAGE_TABLES,
  STORAGE_TABLES,
  getStorageStatus,
  pushStorageChanges,
  pullStorageChanges,
  syncStorageChanges,
  parseStorageTables,
  type StorageStatus,
  type SyncResult,
} from "./db/storage-sync.js";
export { applyPgMigrations, type PgMigrationResult } from "./db/pg-migrate.js";

// ── Recordings CRUD ─────────────────────────────────────────────────────────
export {
  createRecording,
  getRecording,
  listRecordings,
  deleteRecording,
  searchRecordings,
  getRecordingStats,
} from "./db/recordings.js";

// ── Agents ──────────────────────────────────────────────────────────────────
export { registerAgent, getAgent, listAgents } from "./db/agents.js";

// ── Projects ────────────────────────────────────────────────────────────────
export {
  registerProject,
  getProject,
  listProjects,
} from "./db/projects.js";

// ── Config ──────────────────────────────────────────────────────────────────
export {
  loadConfig,
  getDataDir,
  ensureDataDir,
  DEFAULT_CONFIG,
} from "./lib/config.js";

// ── Transcription ───────────────────────────────────────────────────────────
export {
  transcribeAudio,
  transcribeBuffer,
  resetClient,
} from "./lib/transcriber.js";

// ── Enhancement ─────────────────────────────────────────────────────────────
export {
  needsEnhancement,
  enhanceText,
  processText,
  resetEnhancementClient,
} from "./lib/enhancer.js";

// ── Recorder ────────────────────────────────────────────────────────────────
export {
  startRecording,
  stopRecording,
  isRecording,
  getCurrentFile,
  checkRecordingDeps,
  recordDuration,
} from "./lib/recorder.js";

// ── SDK (typed /v1 cloud client, generated from the serve OpenAPI) ────────────
export {
  RecordingsV1Client,
  RecordingsV1ApiError,
} from "./sdk/index.js";
export type {
  RecordingsV1ClientOptions,
  RecordingsV1Recording,
  RecordingsV1Agent,
  RecordingsV1Project,
  RecordingsV1CreateRecordingInput,
  RecordingsV1RegisterAgentInput,
  RecordingsV1RegisterProjectInput,
} from "./sdk/index.js";
