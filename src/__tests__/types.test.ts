import { describe, test, expect } from "bun:test";
import {
  RecordingNotFoundError,
  RecordingError,
  TranscriptionError,
  EnhancementError,
} from "../types/index.js";

describe("RecordingNotFoundError", () => {
  test("sets correct message with id", () => {
    const err = new RecordingNotFoundError("abc-123");
    expect(err.message).toBe("Recording not found: abc-123");
  });

  test("sets name to RecordingNotFoundError", () => {
    const err = new RecordingNotFoundError("xyz");
    expect(err.name).toBe("RecordingNotFoundError");
  });

  test("is an instance of Error", () => {
    const err = new RecordingNotFoundError("id");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("RecordingError", () => {
  test("sets correct message", () => {
    const err = new RecordingError("something went wrong");
    expect(err.message).toBe("something went wrong");
  });

  test("sets name to RecordingError", () => {
    const err = new RecordingError("msg");
    expect(err.name).toBe("RecordingError");
  });

  test("is an instance of Error", () => {
    const err = new RecordingError("msg");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("TranscriptionError", () => {
  test("sets correct message", () => {
    const err = new TranscriptionError("transcription failed");
    expect(err.message).toBe("transcription failed");
  });

  test("sets name to TranscriptionError", () => {
    const err = new TranscriptionError("msg");
    expect(err.name).toBe("TranscriptionError");
  });

  test("is an instance of Error", () => {
    const err = new TranscriptionError("msg");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("EnhancementError", () => {
  test("sets correct message", () => {
    const err = new EnhancementError("enhancement failed");
    expect(err.message).toBe("enhancement failed");
  });

  test("sets name to EnhancementError", () => {
    const err = new EnhancementError("msg");
    expect(err.name).toBe("EnhancementError");
  });

  test("is an instance of Error", () => {
    const err = new EnhancementError("msg");
    expect(err).toBeInstanceOf(Error);
  });
});
