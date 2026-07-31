// ── Types ───────────────────────────────────────────────────────────────────
export type {
  Recording,
  CreateRecordingInput,
  RecordingFilter,
  ProcessingMode,
  PostProcessingMode,
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
  ClientStore,
  TransportResolution,
  HttpTransport,
} from "./http/client.js";

// ── Config ──────────────────────────────────────────────────────────────────
export {
  loadConfig,
  getDataDir,
  ensureDataDir,
  DEFAULT_CONFIG,
  DEFAULT_TRANSCRIPTION_MODEL,
  DEFAULT_REALTIME_SESSION_MODEL,
  DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
  normalizeModelSlots,
  normalizePostProcessingConfig,
  normalizePostProcessingMode,
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

// ── Capability probes (prove capture/credentials, not mere presence) ─────────
export {
  probeMicrophoneCapture,
  captureProbePrecondition,
  captureProbeSubject,
  microphoneGrantInstruction,
  classifyPermissionState,
  readWavPeak,
  DEFAULT_PROBE_SECONDS,
  MAX_PROBE_SECONDS,
  SILENCE_PEAK_THRESHOLD,
  DEFAULT_RECORD_EXECUTABLE,
  RECORDINGS_BUNDLE_IDENTIFIER,
  TCC_UNREADABLE_STATE,
  type CaptureProbeResult,
  type CaptureProbeSubject,
  type MicrophoneGrantInstruction,
  type PermissionRequestState,
  type WavPeak,
} from "./lib/capture-probe.js";

// Persistence is the other half of "it recorded": which store is live, and
// whether that store actually accepts a write.
export {
  describeActiveStore,
  probeRecordingPersistence,
  safeBaseUrl,
  AUTO_FLIP_MODE_SOURCE,
  PERSISTENCE_PROBE_TAG,
  PERSISTENCE_PROBE_MARKER_PREFIX,
  type ActiveStoreDescription,
  type PersistenceProbeResult,
} from "./lib/persistence-probe.js";

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
