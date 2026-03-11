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
