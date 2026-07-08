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

// ── Database (local SQLite lifecycle) ─────────────────────────────────────────
export {
  getDatabase,
  closeDatabase,
  resetDatabase,
  getDbPath,
  shortUuid,
} from "./db/database.js";

// ── Storage abstraction (LocalStore + ApiStore behind one Store) ──────────────
export { getStore, __resetStore, APP } from "./store.js";
export type { Store, RecordingStats, FeedbackInput } from "./store.js";
export {
  resolveStorageClient,
  resolveTransport,
  createHttpTransport,
  createStorageClient,
  HasnaHttpError,
} from "./http/client.js";
export type {
  StorageClient,
  StorageMode,
  TransportResolution,
  HttpTransport,
} from "./http/client.js";

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
