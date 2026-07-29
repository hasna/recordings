import { describe, expect, test } from "bun:test";
import {
  HasnaHttpError,
  createHttpTransport,
  createStorageClient,
  defaultApiBaseUrl,
  resolveStorageClient,
  resolveTransport,
  toV1BaseUrl,
  type HttpTransport,
} from "./client.js";

describe("HTTP client URL and routing policy", () => {
  test("builds the default service URL and normalizes an API URL to /v1", () => {
    expect(defaultApiBaseUrl("voice-notes")).toBe("https://voice-notes.hasna.xyz");
    expect(toV1BaseUrl("https://api.example.test/root/v1/?ignored=yes#fragment"))
      .toBe("https://api.example.test/root/v1");
    expect(toV1BaseUrl("http://localhost:3000/"))
      .toBe("http://localhost:3000/v1");
  });

  test("rejects malformed and non-HTTP API URLs", () => {
    expect(() => toV1BaseUrl("ftp://api.example.test"))
      .toThrow("API URL must use http or https");
    expect(() => toV1BaseUrl("not a URL")).toThrow();
  });

  test("resolves defaults, automatic HTTP configuration, and explicit sqlite", () => {
    expect(resolveTransport("recordings", {})).toEqual({
      transport: "sqlite",
      requested: "sqlite",
      modeSource: "default",
      baseUrl: null,
      apiKeyPresent: false,
      misconfigured: false,
      warning: null,
    });

    expect(resolveTransport("recordings", {
      HASNA_RECORDINGS_API_URL: "https://api.example.test/base/",
      HASNA_RECORDINGS_API_KEY: "secret",
    })).toMatchObject({
      transport: "http",
      requested: "http",
      modeSource: "auto:api-url+api-key",
      baseUrl: "https://api.example.test/base/v1",
      apiKeyPresent: true,
      misconfigured: false,
    });

    expect(resolveTransport("recordings", {
      HASNA_RECORDINGS_CLIENT_STORE: " SQLite ",
      HASNA_RECORDINGS_API_URL: "https://api.example.test",
      HASNA_RECORDINGS_API_KEY: "secret",
    })).toMatchObject({
      transport: "sqlite",
      requested: "sqlite",
      modeSource: "HASNA_RECORDINGS_CLIENT_STORE",
      baseUrl: null,
      apiKeyPresent: true,
    });
  });

  test("reports missing credentials and invalid URLs without routing to HTTP", () => {
    const missingKey = resolveTransport("recordings", {
      HASNA_RECORDINGS_CLIENT_STORE: "http",
    });
    expect(missingKey).toMatchObject({
      transport: "sqlite",
      requested: "http",
      apiKeyPresent: false,
      misconfigured: true,
    });
    expect(missingKey.warning).toContain("no API key is set");

    const invalidUrl = resolveTransport("recordings", {
      HASNA_RECORDINGS_CLIENT_STORE: "http",
      HASNA_RECORDINGS_API_URL: "file:///tmp/recordings",
      HASNA_RECORDINGS_API_KEY: "secret",
    });
    expect(invalidUrl).toMatchObject({
      transport: "sqlite",
      requested: "http",
      baseUrl: null,
      apiKeyPresent: true,
      misconfigured: true,
    });
    expect(invalidUrl.warning).toContain("Invalid API URL");
  });

  test("rejects unknown client-store values", () => {
    expect(() => resolveTransport("recordings", {
      HASNA_RECORDINGS_CLIENT_STORE: "postgresql",
    })).toThrow("Unknown client store");
  });

  test("rejects retired or invalid legacy modes while ignoring live server backends", () => {
    expect(() => resolveTransport("recordings", {
      HASNA_RECORDINGS_MODE: "cloud",
    })).toThrow("deployment modes are removed");
    expect(() => resolveTransport("recordings", {
      HASNA_RECORDINGS_STORAGE_MODE: "mystery",
    })).toThrow("no longer selects one");
    expect(resolveTransport("recordings", {
      HASNA_RECORDINGS_STORAGE_MODE: "postgresql",
    }).transport).toBe("sqlite");
  });
});

describe("HTTP transport", () => {
  test("sends auth, query, and JSON body data and parses JSON responses", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const transport = createHttpTransport({
      name: "recordings",
      baseUrl: "https://api.example.test/v1///",
      apiKey: "top-secret",
      fetchImpl: async (url, init = {}) => {
        requests.push({ url, init });
        return new Response(JSON.stringify({ accepted: true }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const result = await transport.post<{ accepted: boolean }>("recordings?existing=yes", { raw_text: "hello" }, {
      query: {
        tag: ["one", "two"],
        limit: 0,
        active: false,
        absent: null,
        omitted: undefined,
      },
      idempotencyKey: "request-123",
      headers: { "x-request-source": "unit-test" },
    });

    expect(result).toEqual({ accepted: true });
    expect(transport.baseUrl).toBe("https://api.example.test/v1");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      "https://api.example.test/v1/recordings?existing=yes&tag=one&tag=two&limit=0&active=false",
    );
    expect(requests[0]!.init.method).toBe("POST");
    expect(requests[0]!.init.body).toBe(JSON.stringify({ raw_text: "hello" }));
    expect(requests[0]!.init.headers).toMatchObject({
      "x-api-key": "top-secret",
      Authorization: "Bearer top-secret",
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": "request-123",
      "x-request-source": "unit-test",
    });
  });

  test("returns undefined for an empty successful response", async () => {
    const transport = createHttpTransport({
      name: "recordings",
      baseUrl: "https://api.example.test/v1",
      apiKey: "secret",
      fetchImpl: async () => new Response(null, { status: 204 }),
    });

    await expect(transport.del("recordings/123")).resolves.toBeUndefined();
  });

  test("uses the requested verbs for PATCH and PUT convenience methods", async () => {
    const methods: string[] = [];
    const transport = createHttpTransport({
      name: "recordings",
      baseUrl: "https://api.example.test/v1",
      apiKey: "secret",
      fetchImpl: async (_url, init) => {
        methods.push(init?.method ?? "");
        return new Response(JSON.stringify({ updated: true }));
      },
    });

    await expect(transport.patch("recordings/123", { raw_text: "patch" }))
      .resolves.toEqual({ updated: true });
    await expect(transport.put("recordings/123", { raw_text: "replace" }))
      .resolves.toEqual({ updated: true });
    expect(methods).toEqual(["PATCH", "PUT"]);
  });

  test("retries retryable idempotent failures and applies backoff", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const transport = createHttpTransport({
      name: "recordings",
      baseUrl: "https://api.example.test/v1",
      apiKey: "secret",
      sleepImpl: async (ms) => { sleeps.push(ms); },
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(JSON.stringify({ error: "busy" }), { status: 503 });
        }
        return new Response(JSON.stringify({ recordings: [] }));
      },
    });

    await expect(transport.get("recordings")).resolves.toEqual({ recordings: [] });
    expect(attempts).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(200);
    expect(sleeps[0]).toBeLessThanOrEqual(300);
  });

  test("does not retry a POST without an idempotency key and exposes HTTP error details", async () => {
    let attempts = 0;
    const transport = createHttpTransport({
      name: "recordings",
      baseUrl: "https://api.example.test/v1",
      apiKey: "secret",
      sleepImpl: async () => { throw new Error("sleep must not be called"); },
      fetchImpl: async () => {
        attempts += 1;
        return new Response("permission denied", { status: 403 });
      },
    });

    let caught: unknown;
    try {
      await transport.post("recordings", { raw_text: "hello" }, { retries: 4 });
    } catch (error) {
      caught = error;
    }
    expect(attempts).toBe(1);
    expect(caught).toBeInstanceOf(HasnaHttpError);
    expect(caught).toMatchObject({
      name: "HasnaHttpError",
      status: 403,
      method: "POST",
      path: "/recordings",
      body: "permission denied",
    });
    expect((caught as Error).message).toBe("Hasna request failed: POST /recordings -> 403");
  });

  test("does not retry a caller-aborted request", async () => {
    let attempts = 0;
    const controller = new AbortController();
    controller.abort();
    const transport = createHttpTransport({
      name: "recordings",
      baseUrl: "https://api.example.test/v1",
      apiKey: "secret",
      fetchImpl: async (_url, init) => {
        attempts += 1;
        expect(init?.signal?.aborted).toBeTrue();
        throw new Error("aborted by caller");
      },
    });

    await expect(transport.get("recordings", { signal: controller.signal, retries: 3 }))
      .rejects.toThrow("aborted by caller");
    expect(attempts).toBe(1);
  });
});

describe("storage client", () => {
  test("extracts list items from resource envelopes and handles an unknown shape", async () => {
    let raw: unknown = { recordings: [{ id: "rec-1" }] };
    const transport = {
      baseUrl: "https://api.example.test/v1",
      get: async () => raw,
    } as unknown as HttpTransport;
    const client = createStorageClient("recordings", transport);

    expect(await client.list<{ id: string }>("recordings", { limit: 1 })).toEqual({
      items: [{ id: "rec-1" }],
      raw,
    });
    raw = { count: 0 };
    expect(await client.list("recordings")).toEqual({ items: [], raw });
  });

  test("maps GET and DELETE 404 responses while preserving other failures", async () => {
    let getError: Error | null = new HasnaHttpError("GET", "/recordings/missing", 404, { error: "missing" });
    let deleteError: Error | null = new HasnaHttpError("DELETE", "/recordings/missing", 404, { error: "missing" });
    const transport = {
      baseUrl: "https://api.example.test/v1",
      get: async () => {
        if (getError) throw getError;
        return { id: "rec-1" };
      },
      del: async () => {
        if (deleteError) throw deleteError;
      },
    } as unknown as HttpTransport;
    const client = createStorageClient("recordings", transport);

    await expect(client.get("recordings", "missing")).resolves.toBeNull();
    await expect(client.delete("recordings", "missing")).resolves.toBeUndefined();

    getError = new HasnaHttpError("GET", "/recordings/private", 403, null);
    deleteError = new Error("network unavailable");
    await expect(client.get("recordings", "private")).rejects.toBe(getError);
    await expect(client.delete("recordings", "private")).rejects.toBe(deleteError);
  });

  test("creates, patches, replaces, and deletes normalized resource paths", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown; key?: string }> = [];
    const transport = {
      baseUrl: "https://api.example.test/v1",
      post: async (path: string, body: unknown, options: { idempotencyKey?: string }) => {
        calls.push({ method: "POST", path, body, key: options.idempotencyKey });
        return { id: "rec-1" };
      },
      patch: async (path: string, body: unknown) => {
        calls.push({ method: "PATCH", path, body });
        return { updated: true };
      },
      put: async (path: string, body: unknown) => {
        calls.push({ method: "PUT", path, body });
        return { replaced: true };
      },
      del: async (path: string) => { calls.push({ method: "DELETE", path }); },
    } as unknown as HttpTransport;
    const client = createStorageClient("recordings", transport);

    await expect(client.create("/recordings/", { raw_text: "hello" }, "operator-key"))
      .resolves.toEqual({ id: "rec-1" });
    await expect(client.create("recordings", { raw_text: "generated key" }))
      .resolves.toEqual({ id: "rec-1" });
    await expect(client.update("/recordings/", "folder/id", { raw_text: "patch" }))
      .resolves.toEqual({ updated: true });
    await expect(client.update("recordings", "folder/id", { raw_text: "put" }, "PUT"))
      .resolves.toEqual({ replaced: true });
    await expect(client.delete("/recordings/", "folder/id")).resolves.toBeUndefined();

    expect(calls[0]).toEqual({
      method: "POST",
      path: "/recordings",
      body: { raw_text: "hello" },
      key: "operator-key",
    });
    expect(calls[1]!.key).toBeString();
    expect(calls[1]!.key!.length).toBeGreaterThan(0);
    expect(calls.slice(2)).toEqual([
      { method: "PATCH", path: "/recordings/folder%2Fid", body: { raw_text: "patch" } },
      { method: "PUT", path: "/recordings/folder%2Fid", body: { raw_text: "put" } },
      { method: "DELETE", path: "/recordings/folder%2Fid" },
    ]);
  });
});

describe("resolved storage client", () => {
  test("returns sqlite without remote configuration and rejects incomplete auth", () => {
    expect(resolveStorageClient("recordings", {})).toMatchObject({
      transport: "sqlite",
      client: null,
    });
    expect(() => resolveStorageClient("recordings", {
      HASNA_RECORDINGS_CLIENT_STORE: "http",
    })).toThrow("no API key is set");
  });

  test("returns a working HTTP storage client when URL and key are configured", async () => {
    const requestedUrls: string[] = [];
    const resolved = resolveStorageClient("recordings", {
      HASNA_RECORDINGS_API_URL: "https://api.example.test/service",
      HASNA_RECORDINGS_API_KEY: "secret",
    }, async (url) => {
      requestedUrls.push(url);
      return new Response(JSON.stringify({ recordings: [{ id: "rec-1" }] }));
    });

    expect(resolved.transport).toBe("http");
    if (resolved.transport !== "http") throw new Error("expected HTTP client");
    expect(resolved.client.baseUrl).toBe("https://api.example.test/service/v1");
    await expect(resolved.client.list("recordings")).resolves.toMatchObject({
      items: [{ id: "rec-1" }],
    });
    expect(requestedUrls).toEqual(["https://api.example.test/service/v1/recordings"]);
  });
});
