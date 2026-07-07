import { describe, expect, test } from "bun:test";
import { resolveStorageClient, createStorageClient, createHttpTransport, resolveTransport } from "./client.js";
import { resolveRecordingsBackend } from "./backend.js";

const APP = "recordings";

function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const method = (init?.method || "GET").toUpperCase();
    const headers = (init?.headers || {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, headers, body });
    const { status, body: resBody } = handler(url, init || {});
    return new Response(resBody === undefined ? "" : JSON.stringify(resBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

describe("client-flip resolution", () => {
  test("no env -> local", () => {
    const r = resolveTransport(APP, {});
    expect(r.transport).toBe("local");
  });

  test("self_hosted + url + key -> cloud-http with /v1 base", () => {
    const r = resolveTransport(APP, {
      HASNA_RECORDINGS_STORAGE_MODE: "self_hosted",
      HASNA_RECORDINGS_API_URL: "https://recordings.hasna.xyz",
      HASNA_RECORDINGS_API_KEY: "test-key",
    });
    expect(r.transport).toBe("cloud-http");
    expect(r.baseUrl).toBe("https://recordings.hasna.xyz/v1");
  });

  test("flip env (url + key, NO mode var) -> cloud-http", () => {
    // Regression: @hasna/machines flip writes ONLY API_URL + API_KEY.
    const r = resolveTransport(APP, {
      HASNA_RECORDINGS_API_URL: "https://recordings.hasna.xyz",
      HASNA_RECORDINGS_API_KEY: "test-key",
    });
    expect(r.transport).toBe("cloud-http");
    expect(r.modeSource).toBe("auto:api-url+api-key");
    expect(r.baseUrl).toBe("https://recordings.hasna.xyz/v1");
  });

  test("url + key but explicit mode=local forces local (override)", () => {
    const r = resolveTransport(APP, {
      HASNA_RECORDINGS_STORAGE_MODE: "local",
      HASNA_RECORDINGS_API_URL: "https://recordings.hasna.xyz",
      HASNA_RECORDINGS_API_KEY: "test-key",
    });
    expect(r.transport).toBe("local");
  });

  test("url only (no key) -> local, not cloud", () => {
    const r = resolveTransport(APP, {
      HASNA_RECORDINGS_API_URL: "https://recordings.hasna.xyz",
    });
    expect(r.transport).toBe("local");
  });

  test("resolveRecordingsBackend picks cloud-http from flip env (url+key, no mode)", () => {
    const b = resolveRecordingsBackend({
      HASNA_RECORDINGS_API_URL: "https://recordings.hasna.xyz",
      HASNA_RECORDINGS_API_KEY: "test-key",
    });
    expect(b.mode).toBe("cloud-http");
    expect(b.baseUrl).toBe("https://recordings.hasna.xyz/v1");
  });

  test("cloud requested but no key -> misconfigured (throws in resolveStorageClient)", () => {
    expect(() =>
      resolveStorageClient(APP, { HASNA_RECORDINGS_STORAGE_MODE: "self_hosted" }),
    ).toThrow();
  });

  test("resolveRecordingsBackend picks local when env unset", () => {
    const b = resolveRecordingsBackend({});
    expect(b.mode).toBe("local");
  });

  test("resolveRecordingsBackend picks cloud-http when env set", () => {
    const b = resolveRecordingsBackend({
      HASNA_RECORDINGS_STORAGE_MODE: "self_hosted",
      HASNA_RECORDINGS_API_URL: "https://recordings.hasna.xyz",
      HASNA_RECORDINGS_API_KEY: "test-key",
    });
    expect(b.mode).toBe("cloud-http");
    expect(b.baseUrl).toBe("https://recordings.hasna.xyz/v1");
  });
});

describe("cloud HTTP CRUD mapping + auth", () => {
  test("create posts to /v1/recordings with bearer + idempotency key", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 201, body: { recording: { id: "abc", raw_text: "hi" } } }));
    const client = createStorageClient(APP, createHttpTransport({ name: APP, baseUrl: "https://recordings.hasna.xyz/v1", apiKey: "sekret", fetchImpl }));
    const res = await client.create<{ recording: { id: string } }>("recordings", { raw_text: "hi" });
    expect((res as any).recording.id).toBe("abc");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://recordings.hasna.xyz/v1/recordings");
    expect(calls[0].headers.Authorization).toBe("Bearer sekret");
    expect(calls[0].headers["Idempotency-Key"]).toBeTruthy();
  });

  test("list maps recordings envelope to items", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, body: { recordings: [{ id: "1" }, { id: "2" }], count: 2 } }));
    const client = createStorageClient(APP, createHttpTransport({ name: APP, baseUrl: "https://recordings.hasna.xyz/v1", apiKey: "k", fetchImpl }));
    const res = await client.list("recordings", { limit: 5 });
    expect(res.items.length).toBe(2);
    expect(calls[0].url).toContain("limit=5");
  });

  test("get 404 -> null", async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 404, body: { error: "not found" } }));
    const client = createStorageClient(APP, createHttpTransport({ name: APP, baseUrl: "https://recordings.hasna.xyz/v1", apiKey: "k", fetchImpl }));
    expect(await client.get("recordings", "missing")).toBeNull();
  });

  test("delete resolves for 404 (idempotent)", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 404, body: undefined }));
    const client = createStorageClient(APP, createHttpTransport({ name: APP, baseUrl: "https://recordings.hasna.xyz/v1", apiKey: "k", fetchImpl }));
    await client.delete("recordings", "gone");
    expect(calls[0].method).toBe("DELETE");
  });
});
