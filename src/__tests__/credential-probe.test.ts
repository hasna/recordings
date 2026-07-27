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
      "sent sk-abcdef1234567890 with header Bearer sk-zyxwvu9876543210"
    );
    expect(redacted).not.toMatch(/sk-abcdef/);
    expect(redacted).not.toMatch(/sk-zyxwvu/);
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
    expect(result.message).toContain("no OpenAI API key configured");
  });
});
