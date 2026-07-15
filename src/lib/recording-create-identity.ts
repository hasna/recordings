import { ValidationError } from "../db/errors.js";
import type { CreateRecordingInput } from "../types/index.js";
import { createHash } from "node:crypto";

export interface RecordingCreateIdentity {
  input: CreateRecordingInput;
  idempotencyKey?: string;
}

export const MAX_RECORDING_IDENTITY_LENGTH = 255;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

/** Fingerprint the values that one recording insert would persist. */
export function recordingCreateFingerprint(input: CreateRecordingInput): string {
  const persisted = {
    id: input.id ?? null,
    audio_path: input.audio_path || null,
    raw_text: input.raw_text,
    processed_text: input.processed_text || null,
    processing_mode: input.processing_mode || "raw",
    model_used: input.model_used || "gpt-4o-transcribe",
    enhancement_model: input.enhancement_model || null,
    duration_ms: input.duration_ms || 0,
    language: input.language || null,
    tags: input.tags || [],
    agent_id: input.agent_id || null,
    project_id: input.project_id || null,
    session_id: input.session_id || null,
    goal: input.goal || null,
    role: input.role || null,
    task_list_id: input.task_list_id || null,
    machine_id: input.machine_id || null,
    metadata: input.metadata || {},
  };
  return createHash("sha256").update(canonicalJson(persisted), "utf8").digest("hex");
}

function validateIdentityValue(
  value: unknown,
  label: "recording id" | "idempotency key",
  nullMeansAbsent = false,
): string | undefined {
  if (value === undefined || (nullMeansAbsent && value === null)) return undefined;
  if (typeof value !== "string") {
    throw new ValidationError(`${label} must be a string`);
  }
  if (value.length === 0) {
    throw new ValidationError(`${label} must not be empty`);
  }
  if (value.length > MAX_RECORDING_IDENTITY_LENGTH) {
    throw new ValidationError(`${label} must not exceed ${MAX_RECORDING_IDENTITY_LENGTH} characters`);
  }
  if (value !== value.trim()) {
    throw new ValidationError(`${label} must not contain leading or trailing whitespace`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new ValidationError(`${label} must not contain control characters`);
  }
  if (/[^\u0020-\u007e]/.test(value)) {
    throw new ValidationError(`${label} must contain only printable ASCII characters`);
  }
  return value;
}

/** Bind one logical create to the same persisted identity on every backend. */
export function recordingCreateIdentity(
  input: CreateRecordingInput,
  idempotencyKey?: unknown,
  options: { bindIdempotencyKeyToId?: boolean } = {},
): RecordingCreateIdentity {
  const bodyId = validateIdentityValue(input.id, "recording id", true);
  const headerKey = validateIdentityValue(idempotencyKey, "idempotency key");
  if (bodyId !== undefined && headerKey !== undefined && bodyId !== headerKey) {
    throw new ValidationError("recording id conflicts with idempotency key");
  }

  const effectiveKey = headerKey ?? bodyId;
  const { id: _runtimeId, ...inputWithoutId } = input;
  const persistedId = options.bindIdempotencyKeyToId === false ? bodyId : effectiveKey;
  return {
    input: persistedId === undefined
      ? inputWithoutId
      : { ...inputWithoutId, id: persistedId },
    idempotencyKey: effectiveKey,
  };
}
