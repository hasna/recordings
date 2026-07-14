import { describe, expect, test } from "bun:test";
import { resolveStorageClient, createStorageClient, createHttpTransport, resolveTransport } from "./client.js";
import { countStoreRecordings, getStore, type Store } from "../store.js";

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

  test("getStore picks cloud-http from flip env (url+key, no mode)", () => {
    const b = getStore({
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

  test("getStore picks local when env unset", () => {
    const b = getStore({});
    expect(b.mode).toBe("local");
  });

  test("getStore picks cloud-http when env set", () => {
    const b = getStore({
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

describe("ApiStore.setAgentFocus error mapping", () => {
  const cloudEnv = {
    HASNA_RECORDINGS_API_URL: "https://recordings.hasna.xyz",
    HASNA_RECORDINGS_API_KEY: "k",
  };

  async function withFetch<T>(status: number, body: unknown, fn: () => Promise<T>): Promise<T> {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(body === undefined ? "" : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      return await fn();
    } finally {
      globalThis.fetch = orig;
    }
  }

  test("400 surfaces the server's clean 'project not found' message (no generic 'request failed -> 400')", async () => {
    await withFetch(400, { error: "project not found: deadbeef" }, async () => {
      const store = getStore(cloudEnv);
      let caught: unknown;
      try {
        await store.setAgentFocus("agent-1", "deadbeef");
      } catch (e) {
        caught = e;
      }
      expect((caught as Error).message).toBe("project not found: deadbeef");
      expect((caught as Error).message).not.toMatch(/request failed/i);
    });
  });

  test("404 still resolves to null (agent not found)", async () => {
    await withFetch(404, { error: "agent not found" }, async () => {
      const store = getStore(cloudEnv);
      expect(await store.setAgentFocus("nope", "x")).toBeNull();
    });
  });
});

describe("ApiStore project registration", () => {
  test("posts canonical project metadata and returns the Store id", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({
        project: {
          id: "canonical-project-id",
          name: "Desktop App",
          path: "recordings-app://projects/legacy-id",
          description: "Recordings macOS project",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      }), { status: 201, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const store = getStore({
        HASNA_RECORDINGS_API_URL: "https://recordings.hasna.xyz",
        HASNA_RECORDINGS_API_KEY: "test-key",
      });
      const project = await store.registerProject(
        "Desktop App",
        "recordings-app://projects/legacy-id",
        "Recordings macOS project",
      );
      expect(project.id).toBe("canonical-project-id");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        url: "https://recordings.hasna.xyz/v1/projects",
        body: {
          name: "Desktop App",
          path: "recordings-app://projects/legacy-id",
          description: "Recordings macOS project",
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("ApiStore recording counts", () => {
  test("uses the API total rather than the paginated item count", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({
        recordings: [{ id: "one" }],
        count: 42,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      const store = getStore({
        HASNA_RECORDINGS_API_URL: "https://recordings.hasna.xyz",
        HASNA_RECORDINGS_API_KEY: "test-key",
      });
      expect(await countStoreRecordings(store, { search: "needle", offset: 20, limit: 20 })).toBe(42);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("search=needle");
      expect(calls[0]).toContain("limit=500");
      expect(calls[0]).toContain("offset=0");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("pages legacy API responses whose count is only the page length", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    const recordings = Array.from({ length: 503 }, (_, index) => ({ id: `recording-${index}` }));
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url));
      calls.push(requestUrl.toString());
      const limit = Number(requestUrl.searchParams.get("limit"));
      const offset = Number(requestUrl.searchParams.get("offset"));
      const page = recordings.slice(offset, offset + limit);
      return new Response(JSON.stringify({ recordings: page, count: page.length }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const store = getStore({
        HASNA_RECORDINGS_API_URL: "https://recordings.hasna.xyz",
        HASNA_RECORDINGS_API_KEY: "test-key",
      });
      expect(await countStoreRecordings(store)).toBe(503);
      expect(calls).toHaveLength(3);
      expect(calls[0]).toContain("offset=0");
      expect(calls[1]).toContain("offset=500");
      expect(calls[2]).toContain("offset=503");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("continues legacy counting when the server clamps below the requested page size", async () => {
    const originalFetch = globalThis.fetch;
    const offsets: number[] = [];
    const recordings = Array.from({ length: 123 }, (_, index) => ({ id: `clamped-${index}` }));
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url));
      const offset = Number(requestUrl.searchParams.get("offset"));
      offsets.push(offset);
      const page = recordings.slice(offset, offset + 50);
      return new Response(JSON.stringify({ recordings: page, count: page.length }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const store = getStore({
        HASNA_RECORDINGS_API_URL: "https://recordings.hasna.xyz",
        HASNA_RECORDINGS_API_KEY: "test-key",
      });
      expect(await countStoreRecordings(store)).toBe(123);
      expect(offsets).toEqual([0, 50, 100, 123]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects an offset-ignoring legacy API that alternates full pages", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      const prefix = calls % 2 === 0 ? "page-b" : "page-a";
      const recordings = Array.from({ length: 500 }, (_, index) => ({ id: `${prefix}-${index}` }));
      return new Response(JSON.stringify({ recordings, count: recordings.length }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const store = getStore({
        HASNA_RECORDINGS_API_URL: "https://recordings.hasna.xyz",
        HASNA_RECORDINGS_API_KEY: "test-key",
      });
      await expect(countStoreRecordings(store)).rejects.toThrow("ignored pagination");
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects an offset-ignoring legacy API that reorders the same page", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    const recordings = Array.from({ length: 500 }, (_, index) => ({ id: `recording-${index}` }));
    globalThis.fetch = (async () => {
      calls += 1;
      const page = calls % 2 === 0 ? [...recordings].reverse() : recordings;
      return new Response(JSON.stringify({ recordings: page, count: page.length }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const store = getStore({
        HASNA_RECORDINGS_API_URL: "https://recordings.hasna.xyz",
        HASNA_RECORDINGS_API_KEY: "test-key",
      });
      await expect(countStoreRecordings(store)).rejects.toThrow("ignored pagination");
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("legacy Store count compatibility", () => {
  test("accepts and counts a structural Store without countRecordings", async () => {
    const { countRecordings: _countRecordings, ...legacyBase } = getStore({});
    const rows = Array.from({ length: 23 }, (_, index) => ({ id: `legacy-${index}` }));
    const offsets: number[] = [];
    const legacyStore = {
      ...legacyBase,
      async listRecordings(filter) {
        const offset = filter?.offset ?? 0;
        offsets.push(offset);
        return rows.slice(offset, offset + 7) as Awaited<ReturnType<Store["listRecordings"]>>;
      },
    } satisfies Store;

    expect(await countStoreRecordings(legacyStore, {
      search: "needle",
      limit: 1,
      offset: 10,
    })).toBe(23);
    expect(offsets).toEqual([0, 7, 14, 21, 23]);
  });
});
