// ── Recording Types ──────────────────────────────────────────────────────────

export interface Recording {
  id: string;
  audio_path: string | null;
  raw_text: string;
  processed_text: string | null;
  processing_mode: ProcessingMode;
  model_used: string;
  enhancement_model: string | null;
  duration_ms: number;
  language: string | null;
  tags: string[];
  agent_id: string | null;
  project_id: string | null;
  session_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export type ProcessingMode = "raw" | "enhanced";

export interface CreateRecordingInput {
  audio_path?: string;
  raw_text: string;
  processed_text?: string;
  processing_mode?: ProcessingMode;
  model_used?: string;
  enhancement_model?: string;
  duration_ms?: number;
  language?: string;
  tags?: string[];
  agent_id?: string;
  project_id?: string;
  session_id?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordingFilter {
  agent_id?: string;
  project_id?: string;
  session_id?: string;
  processing_mode?: ProcessingMode;
  tags?: string[];
  search?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

// ── Agent Types ─────────────────────────────────────────────────────────────

export interface Agent {
  id: string;
  name: string;
  description: string | null;
  role: string;
  metadata: Record<string, unknown>;
  created_at: string;
  last_seen_at: string;
}

// ── Project Types ───────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  path: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

// ── Config Types ────────────────────────────────────────────────────────────

export interface RecordingsConfig {
  openai_api_key: string;
  enhancement_api_key: string;
  transcription_model: string;
  enhancement_model: string;
  language: string;
  audio_format: "wav" | "mp3" | "m4a" | "webm";
  sample_rate: number;
  record_command: string;
  hotkey: string;
  auto_enhance: boolean;
  enhance_triggers: string[];
  db_path: string;
  audio_dir: string;
  max_recording_seconds: number;
}

// ── Transcription Types ─────────────────────────────────────────────────────

export interface TranscriptionResult {
  text: string;
  duration_ms: number;
  model: string;
  language: string | null;
}

export interface EnhancementResult {
  original: string;
  enhanced: string;
  model: string;
  reasoning: string | null;
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class RecordingNotFoundError extends Error {
  constructor(id: string) {
    super(`Recording not found: ${id}`);
    this.name = "RecordingNotFoundError";
  }
}

export class RecordingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordingError";
  }
}

export class TranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionError";
  }
}

export class EnhancementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnhancementError";
  }
}
