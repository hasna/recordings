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

/**
 * The request path — 401, 404 and 200 — which had NO coverage at all.
 *
 * Review proved the gap by deleting the `models.retrieve` call and its success return outright,
 * replacing them with an unconditional `{ok: true, status: 200}` that made no request: the suite
 * still reported 7 pass / 0 fail, exit 0. Every pre-existing test passed an empty key, so all of
 * them returned at the missing-key branch before a client was ever constructed. So the probe's
 * headline claim — "a rejected or revoked key surfaces as a failure instead of a green tick" —
 * was itself unproven, in a PR titled "prove capture and credentials instead of reporting
 * presence".
 *
 * `retrieveModel` is the injection point added for this, mirroring the `executable` seam the
 * capture probe already uses.
 */
describe("verifyTranscriptionCredential request path", () => {
  const config = { openai_api_key: "sk-config-placeholder" } as unknown as RecordingsConfig;

  function apiError(status: number, message: string): Error & { status: number } {
    return Object.assign(new Error(message), { status });
  }

  test("a 200 with a reachable model is the only path to ok", async () => {
    let sawModel: string | null = null;
    let sawKey: string | null = null;

    const result = await verifyTranscriptionCredential(config, "gpt-4o-transcribe", {
      apiKey: "sk-live-key-for-this-role",
      retrieveModel: async (model, apiKey) => {
        sawModel = model;
        sawKey = apiKey;
        return { id: model };
      },
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.model).toBe("gpt-4o-transcribe");
    expect(result.message).toContain("credential accepted");
    // The probe must send the model and key it was asked about, not the config key.
    expect(sawModel).toBe("gpt-4o-transcribe");
    expect(sawKey).toBe("sk-live-key-for-this-role");
  });

  // The headline claim: a key that is PRESENT but invalid must fail, not pass.
  test("a 401 is reported as a rejected key, not a missing one", async () => {
    const result = await verifyTranscriptionCredential(config, "gpt-4o-transcribe", {
      apiKey: "sk-invalid-key",
      retrieveModel: async () => {
        throw apiError(401, "Incorrect API key provided: sk-invali**********alid.");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.message).toContain("REJECTED");
    expect(result.message).toContain("HTTP 401");
    // And the echoed key material must be redacted INSIDE the function, not just by a caller.
    expect(result.message).not.toContain("sk-invali");
    expect(result.message).toContain("[redacted]");
  });

  test("a 404 is reported as authenticated-but-model-unavailable", async () => {
    const result = await verifyTranscriptionCredential(config, "gpt-4o-transcribe", {
      apiKey: "sk-valid-key",
      retrieveModel: async () => {
        throw apiError(404, "The model 'gpt-4o-transcribe' does not exist");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    // This distinction is the whole reason the role/model pairing bug was worth fixing: the key
    // works, the model does not. Collapsing it into "credential failed" sends the reader to
    // rotate a healthy key.
    expect(result.message).toContain("authenticated");
    expect(result.message).toContain("not available to this key");
  });

  test("a transport error with no HTTP status reports a null status", async () => {
    const result = await verifyTranscriptionCredential(config, "gpt-4o-transcribe", {
      apiKey: "sk-valid-key",
      retrieveModel: async () => {
        throw new Error("Unable to connect. Is the computer able to access the url?");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    // No fabricated "HTTP null" in the operator-facing text.
    expect(result.message).not.toContain("HTTP");
    expect(result.message).toContain("Unable to connect");
  });

  // Guards the mutant review used: deleting the request and returning ok:true unconditionally.
  test("the probe cannot pass without the request actually being made", async () => {
    let called = 0;
    const result = await verifyTranscriptionCredential(config, "gpt-4o-transcribe", {
      apiKey: "sk-valid-key",
      retrieveModel: async (model) => {
        called += 1;
        return { id: model };
      },
    });

    expect(called).toBe(1);
    expect(result.ok).toBe(true);
  });
});

describe("redactKeyMaterial covers the headers this package actually sends", () => {
  // `x-api-key` is the header the transport sets (src/http/client.ts). The prefix allowlist could
  // never match it: a Hasna API key is not `sk-` shaped.
  test("redacts x-api-key, Basic auth and URL userinfo", () => {
    // Fixture deliberately low-entropy and self-labelling: a realistic-looking token here trips
    // the staged secrets scan (`generic-api-key`) on every future commit touching this file.
    const fakeHeaderValue = "EXAMPLE-NOT-A-REAL-KEY";
    expect(redactKeyMaterial(`failed with x-api-key: ${fakeHeaderValue}`)).not.toContain(
      fakeHeaderValue
    );
    expect(redactKeyMaterial("Authorization: Basic dXNlcjpwYXNzd29yZA==")).not.toContain(
      "dXNlcjpwYXNzd29yZA=="
    );
    const userinfo = redactKeyMaterial("GET https://svc:hunter2@recordings.example.test/v1/stats");
    expect(userinfo).not.toContain("hunter2");
    // The host must survive — it is the actionable part.
    expect(userinfo).toContain("recordings.example.test");
  });

  test("leaves ordinary prose with a colon alone", () => {
    const message = "read-back failed: the stored transcript did not match what was written";
    expect(redactKeyMaterial(message)).toBe(message);
  });
});
