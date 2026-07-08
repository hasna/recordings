import { describe, expect, test, mock, beforeEach } from "bun:test";

// ── In-memory fake of the cloud module ────────────────────────────────────────
// Regression guard for the live-flip failures: the client ApiStore POSTs to
// /v1/feedback, /v1/agents/:id/heartbeat and /v1/agents/:id/focus. A stale
// server had no feedback resource (404) and treated heartbeat/focus as GET-only
// (405). This test exercises the real handler routing so those regressions can
// never come back silently.

const AGENT_ROW = {
  id: "agent-1",
  name: "probe",
  description: null,
  role: "agent",
  metadata: "{}",
  created_at: "2026-01-01T00:00:00.000Z",
  last_seen_at: "2026-01-01T00:00:00.000Z",
  active_project_id: null,
};

const runCalls: Array<{ sql: string; params: unknown[] }> = [];

const fakePg = {
  async run(sql: string, ...params: unknown[]) {
    runCalls.push({ sql, params });
    return { changes: 1 };
  },
  async get(sql: string) {
    // Any agent lookup resolves to our canned row; everything else is null.
    if (/from\s+agents/i.test(sql)) return { ...AGENT_ROW };
    return null;
  },
  async all() {
    return [];
  },
  async exec() {},
};

mock.module("./cloud.js", () => ({
  getCloudPg: () => fakePg,
  getCloudVerifier: () => ({
    authenticate: async () => ({ ok: true }),
  }),
  ensureCloudSchema: async () => {},
}));

const { handleV1Request } = await import("./v1.js");

function post(path: string, body?: unknown): Request {
  return new Request(`https://recordings.hasna.xyz${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("v1 handler: previously-failing cloud routes", () => {
  beforeEach(() => {
    runCalls.length = 0;
  });

  test("POST /v1/feedback -> 201 (resource exists, not 404)", async () => {
    const req = post("/v1/feedback", { message: "hello", category: "test" });
    const res = await handleV1Request(req, new URL(req.url));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(201);
    expect(runCalls.some((c) => /insert into feedback/i.test(c.sql))).toBe(true);
  });

  test("POST /v1/feedback with blank message -> 400 (validated)", async () => {
    const req = post("/v1/feedback", { message: "   " });
    const res = await handleV1Request(req, new URL(req.url));
    expect(res!.status).toBe(400);
  });

  test("POST /v1/agents/:id/heartbeat -> 200 (not 405)", async () => {
    const req = post("/v1/agents/agent-1/heartbeat");
    const res = await handleV1Request(req, new URL(req.url));
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { agent?: { id: string } };
    expect(body.agent?.id).toBe("agent-1");
    expect(runCalls.some((c) => /update agents set last_seen_at/i.test(c.sql))).toBe(true);
  });

  test("POST /v1/agents/:id/focus -> 200 (not 405)", async () => {
    const req = post("/v1/agents/agent-1/focus", { project_id: null });
    const res = await handleV1Request(req, new URL(req.url));
    expect(res!.status).toBe(200);
    expect(runCalls.some((c) => /update agents set active_project_id/i.test(c.sql))).toBe(true);
  });
});
