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

// A real project row with a full 36-char UUID PK; the tools surface only the
// first 8 chars, so focus must resolve the truncated ref back to this row.
const PROJECT_ROW = {
  id: "164a6e1f-ac00-4d5d-9390-215cfa9be003",
  name: "workspace",
  path: "/home/agent/workspace",
  description: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const runCalls: Array<{ sql: string; params: unknown[] }> = [];

const fakePg = {
  async run(sql: string, ...params: unknown[]) {
    runCalls.push({ sql, params });
    return { changes: 1 };
  },
  async get(sql: string, ...params: unknown[]) {
    // Any agent lookup resolves to our canned row.
    if (/from\s+agents/i.test(sql)) return { ...AGENT_ROW };
    // Project resolution mirrors repo.getProject: exact id/path/name or the
    // truncated id-prefix (LIKE) all resolve to PROJECT_ROW; anything else null.
    if (/from\s+projects/i.test(sql)) {
      const ref = params[0] as string;
      const matches =
        ref === PROJECT_ROW.id ||
        ref === PROJECT_ROW.path ||
        ref === PROJECT_ROW.name ||
        (/like/i.test(sql) && PROJECT_ROW.id.startsWith(ref));
      return matches ? { ...PROJECT_ROW } : null;
    }
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

  test("POST focus with the TRUNCATED project id -> 200 and stores the full UUID", async () => {
    const shortId = "164a6e1f"; // the 8-char ref the tools surface
    const req = post("/v1/agents/agent-1/focus", { project_id: shortId });
    const res = await handleV1Request(req, new URL(req.url));
    expect(res!.status).toBe(200);
    const write = runCalls.find((c) => /update agents set active_project_id/i.test(c.sql));
    expect(write).toBeDefined();
    // The resolved full UUID is persisted, never the truncated ref.
    expect(write!.params[0]).toBe("164a6e1f-ac00-4d5d-9390-215cfa9be003");
  });

  test("POST focus with the project NAME -> 200 (resolved)", async () => {
    const req = post("/v1/agents/agent-1/focus", { project_id: "workspace" });
    const res = await handleV1Request(req, new URL(req.url));
    expect(res!.status).toBe(200);
    const write = runCalls.find((c) => /update agents set active_project_id/i.test(c.sql));
    expect(write!.params[0]).toBe("164a6e1f-ac00-4d5d-9390-215cfa9be003");
  });

  test("POST focus with an unknown project -> clean 400 (never a raw 500 FK leak)", async () => {
    const req = post("/v1/agents/agent-1/focus", { project_id: "deadbeef" });
    const res = await handleV1Request(req, new URL(req.url));
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toBe("project not found: deadbeef");
    // The Postgres FK constraint name must never surface to the client.
    expect(body.error).not.toMatch(/fkey/i);
    expect(body.error).not.toMatch(/foreign key/i);
    // And no focus write was attempted for the bad ref.
    expect(runCalls.some((c) => /update agents set active_project_id/i.test(c.sql))).toBe(false);
  });

  test("an unexpected DB error -> sanitized 500 that never leaks internals", async () => {
    // Simulate the raw Postgres failure the live probe saw (a FK violation whose
    // message carries the constraint name). It must be caught and sanitized.
    const boom = new Error(
      'insert or update on table "agents" violates foreign key constraint "agents_active_project_id_fkey"',
    );
    const original = fakePg.run;
    fakePg.run = async () => {
      throw boom;
    };
    try {
      const req = post("/v1/feedback", { message: "trigger", category: "test" });
      const res = await handleV1Request(req, new URL(req.url));
      expect(res!.status).toBe(500);
      const body = (await res!.json()) as { error: string };
      expect(body.error).toBe("internal server error");
      // No Postgres internals (constraint name, "foreign key", table/column text).
      expect(body.error).not.toMatch(/fkey/i);
      expect(body.error).not.toMatch(/foreign key/i);
      expect(body.error).not.toMatch(/agents_active_project_id/i);
      expect(body.error).not.toMatch(/violates|constraint/i);
    } finally {
      fakePg.run = original;
    }
  });
});
