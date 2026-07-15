import { ValidationError } from "../db/errors.js";
import type { CreateRecordingInput } from "../types/index.js";

export interface RecordingCreateIdentity {
  input: CreateRecordingInput;
  idempotencyKey?: string;
}

export const MAX_RECORDING_IDENTITY_LENGTH = 255;

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
): RecordingCreateIdentity {
  const bodyId = validateIdentityValue(input.id, "recording id", true);
  const headerKey = validateIdentityValue(idempotencyKey, "idempotency key");
  if (bodyId !== undefined && headerKey !== undefined && bodyId !== headerKey) {
    throw new ValidationError("recording id conflicts with idempotency key");
  }

  const effectiveKey = headerKey ?? bodyId;
  const { id: _runtimeId, ...inputWithoutId } = input;
  return {
    input: effectiveKey === undefined
      ? inputWithoutId
      : { ...inputWithoutId, id: effectiveKey },
    idempotencyKey: effectiveKey,
  };
}
