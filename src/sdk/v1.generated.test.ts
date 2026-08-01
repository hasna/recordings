import { describe, expect, test } from "bun:test";
import { ApiError, RecordingsV1Client } from "./v1.generated.js";

describe("RecordingsV1Client query serialization", () => {
  test("explodes array query parameters into repeated values", async () => {
    let requestedUrl = "";
    const client = new RecordingsV1Client({
      baseUrl: "https://recordings.example.test",
      fetch: (async (input: string | URL | Request) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({ recordings: [], count: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    await client.listRecordings({ tags: ["work", "urgent"], limit: 5 });

    const url = new URL(requestedUrl);
    expect(url.searchParams.getAll("tags")).toEqual(["work", "urgent"]);
    expect(url.searchParams.get("limit")).toBe("5");
  });
});

describe("RecordingsV1Client", () => {
  test("requires a base URL", () => {
    expect(() => new RecordingsV1Client({ baseUrl: "" })).toThrow(
      "RecordingsV1Client requires a baseUrl",
    );
  });

  test("maps every operation to its method, encoded path, body, and headers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new RecordingsV1Client({
      baseUrl: "https://recordings.example.test/",
      apiKey: "sdk-key",
      headers: { "x-base": "base" },
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    const requestInit = { headers: { "x-request": "request" } };

    await client.listAgents(requestInit);
    await client.registerAgent({ name: "Ada" });
    await client.getAgent("agent/name");
    await client.listProjects();
    await client.registerProject({ name: "App", path: "/app" });
    await client.getProject("project/path");
    await client.listRecordings({
      tags: ["one", "two"],
      search: "hello",
      limit: 0,
    });
    await client.createRecording({ raw_text: "hello" });
    await client.getRecording("recording/id");
    await client.deleteRecording("recording/id");
    await client.getRecordingStats();

    expect(calls.map(({ url, init }) => [new URL(url).pathname, init.method])).toEqual([
      ["/v1/agents", "GET"],
      ["/v1/agents", "POST"],
      ["/v1/agents/agent%2Fname", "GET"],
      ["/v1/projects", "GET"],
      ["/v1/projects", "POST"],
      ["/v1/projects/project%2Fpath", "GET"],
      ["/v1/recordings", "GET"],
      ["/v1/recordings", "POST"],
      ["/v1/recordings/recording%2Fid", "GET"],
      ["/v1/recordings/recording%2Fid", "DELETE"],
      ["/v1/stats", "GET"],
    ]);
    expect(calls[0]!.init.headers).toEqual({
      Accept: "application/json",
      "x-api-key": "sdk-key",
      "x-base": "base",
      "x-request": "request",
    });
    expect(calls[1]!.init.headers).toEqual(expect.objectContaining({
      "Content-Type": "application/json",
      "x-api-key": "sdk-key",
    }));
    expect(calls[1]!.init.body).toBe('{"name":"Ada"}');
    expect(new URL(calls[6]!.url).searchParams.getAll("tags")).toEqual(["one", "two"]);
    expect(new URL(calls[6]!.url).searchParams.get("search")).toBe("hello");
    expect(new URL(calls[6]!.url).searchParams.get("limit")).toBe("0");
  });

  test("uses global fetch by default and accepts empty successful responses", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("", { status: 204 });
    }) as typeof fetch;
    try {
      const client = new RecordingsV1Client({ baseUrl: "https://recordings.example.test" });
      expect(await client.deleteRecording("gone")).toBeUndefined();
      expect(called).toBeTrue();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("parses JSON failures and exposes status, body, and error identity", async () => {
    const client = new RecordingsV1Client({
      baseUrl: "https://recordings.example.test",
      fetch: (async () => Response.json({ error: "denied" }, { status: 403 })) as typeof fetch,
    });

    let caught: unknown;
    try {
      await client.listAgents();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toEqual(expect.objectContaining({
      name: "ApiError",
      status: 403,
      body: { error: "denied" },
      message: "GET /v1/agents failed: 403",
    }));
  });

  test("preserves non-JSON error bodies as text", async () => {
    const client = new RecordingsV1Client({
      baseUrl: "https://recordings.example.test",
      fetch: (async () => new Response("upstream unavailable", { status: 503 })) as typeof fetch,
    });

    await expect(client.getRecording("one")).rejects.toEqual(
      expect.objectContaining({ status: 503, body: "upstream unavailable" }),
    );
  });
});
