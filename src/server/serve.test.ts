import { afterEach, describe, expect, test } from "bun:test";
import { requireSigningSecret } from "./cloud-config.js";
import { buildFetch } from "./serve.js";

const originalMode = process.env.HASNA_RECORDINGS_STORAGE_MODE;

afterEach(() => {
  if (originalMode === undefined) delete process.env.HASNA_RECORDINGS_STORAGE_MODE;
  else process.env.HASNA_RECORDINGS_STORAGE_MODE = originalMode;
});

describe("public readiness", () => {
  test("rejects missing and undersized signing secrets without including their value in errors", () => {
    expect(() => requireSigningSecret({})).toThrow("requires a signing secret");
    const invalidSecret = "too-short";
    try {
      requireSigningSecret({ HASNA_RECORDINGS_API_SIGNING_KEY: invalidSecret });
      throw new Error("expected invalid signing configuration to fail");
    } catch (error) {
      expect((error as Error).message).toContain("at least 16 bytes");
      expect((error as Error).message).not.toContain(invalidSecret);
    }
    expect(requireSigningSecret({ HASNA_RECORDINGS_API_SIGNING_KEY: "0123456789abcdef" })).toBe(
      "0123456789abcdef",
    );
  });

  test("rejects missing or invalid signing verifier configuration before probing storage", async () => {
    process.env.HASNA_RECORDINGS_STORAGE_MODE = "remote";
    for (const message of ["signing secret is required", "signing secret is too short"]) {
      let storageProbes = 0;
      const fetch = buildFetch({
        checkCloudAuth: () => { throw new Error(message); },
        pingCloud: async () => { storageProbes++; },
        logError: () => {},
      });
      const response = await fetch(
        new Request("http://localhost/ready"),
        { requestIP: () => ({ address: `203.0.113.${storageProbes + 10}` }) },
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        status: "unavailable",
        error: "dependency unavailable",
      });
      expect(storageProbes).toBe(0);
    }
  });

  test("does not expose database errors to unauthenticated callers or logs", async () => {
    process.env.HASNA_RECORDINGS_STORAGE_MODE = "remote";
    const logged: unknown[][] = [];
    const fetch = buildFetch({
      pingCloud: async () => { throw new Error("password=secret host=private-db.internal"); },
      logError: (...args: unknown[]) => { logged.push(args); },
    });
    const response = await fetch(
      new Request("http://localhost/ready"),
      { requestIP: () => ({ address: "203.0.113.9" }) },
    );
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).toContain("dependency unavailable");
    expect(body).not.toContain("password");
    expect(body).not.toContain("private-db");
    expect(JSON.stringify(logged)).not.toContain("secret");
    expect(JSON.stringify(logged)).not.toContain("private-db");
  });
});
