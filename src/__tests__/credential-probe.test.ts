import { describe, expect, test } from "bun:test";
import {
  redactKeyMaterial,
  verifyTranscriptionCredential,
} from "../lib/transcriber.js";
import type { RecordingsConfig } from "../types/index.js";

describe("redactKeyMaterial", () => {
  // OpenAI's 401 body echoes a partially masked key. Masked is still credential
  // material and must never reach scrollback, CI logs or a diagnostics file.
  test("redacts the masked key OpenAI echoes back in a 401", () => {
    const body =
      "401 Incorrect API key provided: sk-not-a**************************alid. " +
      "You can find your API key at https://platform.openai.com/account/api-keys.";

    const redacted = redactKeyMaterial(body);

    expect(redacted).not.toContain("sk-not-a");
    expect(redacted).toContain("[redacted]");
    // The actionable part of the message must survive.
    expect(redacted).toContain("Incorrect API key provided");
  });

  test("redacts unmasked key-shaped strings and bearer headers", () => {
    const redacted = redactKeyMaterial(
      "sent sk-EXAMPLENOTAREALKEY0001 with header Bearer sk-EXAMPLENOTAREALKEY0002"
    );
    // Assert against the fixtures actually used above; stale patterns here would
    // pass vacuously and prove nothing about the redaction.
    expect(redacted).not.toContain("sk-EXAMPLENOTAREALKEY0001");
    expect(redacted).not.toContain("sk-EXAMPLENOTAREALKEY0002");
    expect(redacted).toContain("[redacted]");
    expect(redacted).toContain("Bearer [redacted]");
  });

  test("leaves messages without key material untouched", () => {
    const message = "connect ECONNREFUSED 127.0.0.1:443";
    expect(redactKeyMaterial(message)).toBe(message);
  });
});

describe("verifyTranscriptionCredential", () => {
  // A missing key must be reported as missing, distinctly from a rejected one —
  // the two need different fixes.
  test("reports a missing key without attempting a request", async () => {
    const result = await verifyTranscriptionCredential(
      { openai_api_key: "" } as unknown as RecordingsConfig,
      "gpt-4o"
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.message).toContain("no API key configured for the transcription role");
  });
});

describe("verifyTranscriptionCredential role and key pairing", () => {
  // F6: the probe used to check resolveTranscriberModel(config) — the
  // POST-PROCESSING model — with openai_api_key, under a line labelled
  // "Transcription credential". With split keys that retrieved the enhancement
  // model using the transcription key (a red 404 on a working machine), and it
  // never touched config.transcription_model, so that model being unavailable
  // produced a green tick.
  test("defaults to the transcription role", async () => {
    const result = await verifyTranscriptionCredential(
      { openai_api_key: "" } as unknown as RecordingsConfig,
      "gpt-4o-transcribe"
    );

    expect(result.role).toBe("transcription");
    expect(result.model).toBe("gpt-4o-transcribe");
    expect(result.ok).toBe(false);
  });

  test("carries the enhancement role and its own model through the result", async () => {
    const result = await verifyTranscriptionCredential(
      { openai_api_key: "" } as unknown as RecordingsConfig,
      "gpt-4o",
      { apiKey: "", role: "enhancement" }
    );

    expect(result.role).toBe("enhancement");
    expect(result.model).toBe("gpt-4o");
    expect(result.message).toContain("enhancement role");
  });

  // The probe must send the key for the role under test, not whatever
  // config.openai_api_key happens to hold.
  test("an explicit apiKey overrides the config key for the missing-key check", async () => {
    const result = await verifyTranscriptionCredential(
      { openai_api_key: "config-key-is-present" } as unknown as RecordingsConfig,
      "gpt-4o",
      { apiKey: "", role: "enhancement" }
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("no API key configured for the enhancement role");
  });
});
