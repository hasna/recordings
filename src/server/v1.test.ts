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
const queryCalls: Array<{ method: "get" | "all"; sql: string; params: unknown[] }> = [];
const recordingRows: Array<Record<string, unknown>> = [];
const idempotencyRows: Array<Record<string, unknown>> = [];

const successfulAuthentication = async (headers: Headers) => {
  const authorization = headers.get("Authorization") ?? "Bearer test";
  const kid = authorization.replace(/^Bearer\s+/i, "") || "test";
  return {
    ok: true as const,
    status: 200,
    principal: {
      kid,
      app: "recordings",
      scopes: ["recordings:write"],
      agent: null,
      claims: {
        v: 1 as const,
        kid,
        app: "recordings",
        scopes: ["recordings:write"],
        iat: 0,
        exp: null,
      },
    },
  };
};
let authenticateImpl: (headers: Headers) => Promise<unknown> = successfulAuthentication;
let ensureCloudSchemaImpl: () => Promise<void> = async () => {};
let getCloudVerifierImpl = () => ({
  authenticate: (headers: Headers) => authenticateImpl(headers),
});
let getCloudPgImpl: () => typeof fakePg = () => fakePg;

const fakePg = {
  async transaction<T>(operation: (transaction: typeof fakePg) => Promise<T>) {
    return operation(fakePg);
  },
  async run(sql: string, ...params: unknown[]) {
    runCalls.push({ sql, params });
    if (/insert\s+into\s+recording_idempotency/i.test(sql)) {
      if (idempotencyRows.some((row) =>
        (row["principal"] === params[0] && row["idempotency_key"] === params[1]) ||
        row["recording_id"] === params[3]
      )) return { changes: 0 };
      idempotencyRows.push({
        principal: params[0],
        idempotency_key: params[1],
        request_fingerprint: params[2],
        recording_id: params[3],
      });
    } else if (/insert\s+into\s+recordings/i.test(sql)) {
      if (recordingRows.some((row) => row["id"] === params[0])) return { changes: 0 };
      recordingRows.push({
        id: params[0],
        audio_path: params[1],
        raw_text: params[2],
        processed_text: params[3],
        processing_mode: params[4],
        model_used: params[5],
        enhancement_model: params[6],
        duration_ms: params[7],
        language: params[8],
        tags: params[9],
        agent_id: params[10],
        project_id: params[11],
        session_id: params[12],
        goal: params[13],
        role: params[14],
        task_list_id: params[15],
        machine_id: params[16],
        metadata: params[17],
        created_at: "2026-01-01T00:00:00.000Z",
      });
    } else if (/delete\s+from\s+recordings/i.test(sql)) {
      const index = recordingRows.findIndex((row) => row["id"] === params[0]);
      if (index === -1) return { changes: 0 };
      recordingRows.splice(index, 1);
      for (const row of idempotencyRows) {
        if (row["recording_id"] === params[0]) row["recording_id"] = null;
      }
    }
    return { changes: 1 };
  },
  async get(sql: string, ...params: unknown[]) {
    queryCalls.push({ method: "get", sql, params });
    if (/select\s+count\(\*\)\s+as\s+c\s+from\s+recordings/i.test(sql)) return { c: 7 };
    if (/from\s+recording_idempotency/i.test(sql)) {
      return idempotencyRows.find((row) =>
        row["principal"] === params[0] && row["idempotency_key"] === params[1]
      ) ?? null;
    }
    if (/from\s+recordings/i.test(sql)) {
      const ref = params[0] as string;
      return recordingRows.find((row) => row["id"] === ref) ?? null;
    }
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
  async all(sql: string, ...params: unknown[]) {
    queryCalls.push({ method: "all", sql, params });
    return [];
  },
  async exec() {},
};

mock.module("./cloud.js", () => ({
  getCloudPg: () => getCloudPgImpl(),
  getCloudVerifier: () => getCloudVerifierImpl(),
  ensureCloudSchema: () => ensureCloudSchemaImpl(),
}));

const { handleV1Request } = await import("./v1.js");

function post(path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://recordings.hasna.xyz${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function postAs(kid: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return post(path, body, { Authorization: `Bearer ${kid}`, ...headers });
}

function get(path: string): Request {
  return new Request(`https://recordings.hasna.xyz${path}`, {
    method: "GET",
    headers: { Authorization: "Bearer test" },
  });
}

function delAs(kid: string, path: string): Request {
  return new Request(`https://recordings.hasna.xyz${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${kid}` },
  });
}

describe("v1 handler: previously-failing cloud routes", () => {
  beforeEach(() => {
    runCalls.length = 0;
    queryCalls.length = 0;
    recordingRows.length = 0;
    idempotencyRows.length = 0;
    authenticateImpl = successfulAuthentication;
    ensureCloudSchemaImpl = async () => {};
    getCloudVerifierImpl = () => ({
      authenticate: (headers: Headers) => authenticateImpl(headers),
    });
    getCloudPgImpl = () => fakePg;
  });

  test("verifier construction failures return a fixed 503 without leaking configuration", async () => {
    const hostile =
      'signing configuration for role "api_verifier" references postgres://auth-db.internal/keys?credential=PRIVATE_MARKER';
    getCloudVerifierImpl = () => {
      throw new Error(hostile);
    };
    const logs: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      const req = get("/v1/recordings");
      const res = await handleV1Request(req, new URL(req.url));
      expect(res!.status).toBe(503);
      expect(await res!.json()).toEqual({ error: "authentication service unavailable" });
      expect(logs.join("\n")).not.toContain(hostile);
      expect(logs.join("\n")).not.toMatch(/api_verifier|PRIVATE_MARKER|auth-db\.internal/i);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("authenticated schema failures return a fixed 503 without leaking storage details", async () => {
    const hostile =
      'relation "recording_idempotency" does not exist for role "svc_writer" at postgres://db.internal/recordings?credential=PRIVATE_MARKER';
    ensureCloudSchemaImpl = async () => {
      throw new Error(hostile);
    };
    const logs: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      const req = get("/v1/recordings");
      const res = await handleV1Request(req, new URL(req.url));
      expect(res!.status).toBe(503);
      expect(await res!.json()).toEqual({ error: "storage unavailable" });
      expect(logs.join("\n")).not.toContain(hostile);
      expect(logs.join("\n")).not.toMatch(/recording_idempotency|svc_writer|PRIVATE_MARKER|db\.internal/i);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("storage adapter failures after schema validation return a fixed non-leaking 503", async () => {
    const hostile =
      'connection rejected for role "runtime_writer" at postgres://db.internal/recordings?credential=PRIVATE_MARKER';
    getCloudPgImpl = () => {
      throw new Error(hostile);
    };
    const logs: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      const req = get("/v1/recordings");
      const res = await handleV1Request(req, new URL(req.url));
      expect(res!.status).toBe(503);
      expect(await res!.json()).toEqual({ error: "storage unavailable" });
      expect(logs.join("\n")).not.toContain(hostile);
      expect(logs.join("\n")).not.toMatch(/runtime_writer|PRIVATE_MARKER|db\.internal/i);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("verifier store failures return a fixed 503 without rejecting or leaking credentials", async () => {
    const hostile =
      'credential lookup failed for role "revocation_reader" at postgres://auth-db.internal/keys?credential=PRIVATE_MARKER';
    authenticateImpl = async () => {
      throw new Error(hostile);
    };
    const logs: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      const req = get("/v1/recordings");
      const res = await handleV1Request(req, new URL(req.url));
      expect(res!.status).toBe(503);
      expect(await res!.json()).toEqual({ error: "authentication service unavailable" });
      expect(logs.join("\n")).not.toContain(hostile);
      expect(logs.join("\n")).not.toMatch(/revocation_reader|PRIVATE_MARKER|auth-db\.internal/i);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("ordinary invalid credentials preserve the verifier's 401 response", async () => {
    authenticateImpl = async () => ({
      ok: false,
      status: 401,
      message: "invalid API key",
      reason: "invalid",
    });

    const req = get("/v1/recordings");
    const res = await handleV1Request(req, new URL(req.url));
    expect(res!.status).toBe(401);
    expect(await res!.json()).toEqual({ error: "invalid API key", reason: "invalid" });
  });

  test("GET /v1/recordings propagates exploded tags/date filters and returns filtered total", async () => {
    const req = get(
      "/v1/recordings?tags=work&tags=urgent&since=2026-01-01&until=2026-01-31&limit=2&offset=4",
    );
    const res = await handleV1Request(req, new URL(req.url));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ recordings: [], count: 7 });

    const listCall = queryCalls.find((call) => call.method === "all" && /from recordings/i.test(call.sql));
    const countCall = queryCalls.find((call) => call.method === "get" && /count\(\*\).*from recordings/i.test(call.sql));
    expect(listCall?.params).toEqual(["work", "urgent", "2026-01-01", "2026-01-31", 2, 4]);
    expect(countCall?.params).toEqual(["work", "urgent", "2026-01-01", "2026-01-31"]);
    expect(listCall?.sql.match(/recording_tags/g)).toHaveLength(2);
    expect(countCall?.sql.match(/recording_tags/g)).toHaveLength(2);
  });

  test("POST /v1/recordings binds the idempotency header to one persisted row", async () => {
    const firstRequest = post(
      "/v1/recordings",
      { raw_text: "settled realtime text" },
      { "Idempotency-Key": "logical-save-a" },
    );
    const firstResponse = await handleV1Request(firstRequest, new URL(firstRequest.url));
    expect(firstResponse!.status).toBe(201);
    const first = await firstResponse!.json() as { recording: { id: string; raw_text: string } };

    const retryRequest = post(
      "/v1/recordings",
      { raw_text: "settled realtime text" },
      { "Idempotency-Key": "logical-save-a" },
    );
    const retryResponse = await handleV1Request(retryRequest, new URL(retryRequest.url));
    const retry = await retryResponse!.json() as { recording: { id: string; raw_text: string } };
    expect(retryResponse!.status).toBe(201);
    expect(retry.recording).toMatchObject({
      id: first.recording.id,
      raw_text: "settled realtime text",
    });
    expect(recordingRows).toHaveLength(1);
    expect(queryCalls.filter((call) => /pg_advisory_xact_lock/i.test(call.sql))).toHaveLength(2);
  });

  test("POST /v1/recordings never exposes another principal's idempotent result", async () => {
    const firstRequest = postAs(
      "writer-a",
      "/v1/recordings",
      { raw_text: "principal A private transcript" },
      { "Idempotency-Key": "shared-logical-key" },
    );
    const firstResponse = await handleV1Request(firstRequest, new URL(firstRequest.url));
    expect(firstResponse!.status).toBe(201);

    const collisionRequest = postAs(
      "writer-b",
      "/v1/recordings",
      { raw_text: "principal B request" },
      { "Idempotency-Key": "shared-logical-key" },
    );
    const collisionResponse = await handleV1Request(collisionRequest, new URL(collisionRequest.url));
    expect(collisionResponse!.status).toBe(201);
    const collision = await collisionResponse!.json() as { recording: { id: string; raw_text: string } };
    expect(collision.recording.raw_text).toBe("principal B request");
    expect(collision.recording.id).not.toBe(
      (await firstResponse!.clone().json() as { recording: { id: string } }).recording.id,
    );
    expect(recordingRows).toHaveLength(2);
  });

  test("POST /v1/recordings rejects a changed request under the same principal and key", async () => {
    const firstRequest = postAs(
      "writer-a",
      "/v1/recordings",
      { raw_text: "first request body" },
      { "Idempotency-Key": "changed-request-key" },
    );
    const firstResponse = await handleV1Request(firstRequest, new URL(firstRequest.url));
    expect(firstResponse!.status).toBe(201);

    const changedRequest = postAs(
      "writer-a",
      "/v1/recordings",
      { raw_text: "different request body" },
      { "Idempotency-Key": "changed-request-key" },
    );
    const changedResponse = await handleV1Request(changedRequest, new URL(changedRequest.url));
    expect(changedResponse!.status).toBe(409);
    expect(await changedResponse!.json()).toEqual({ error: "idempotency key is already in use" });
  });

  test("DELETE keeps the caller's key tombstoned and returns no deleted transcript on retry", async () => {
    const createRequest = postAs(
      "writer-a",
      "/v1/recordings",
      { raw_text: "private deleted transcript" },
      { "Idempotency-Key": "deleted-request-key" },
    );
    const createResponse = await handleV1Request(createRequest, new URL(createRequest.url));
    const created = await createResponse!.json() as { recording: { id: string } };

    const deleteRequest = delAs("writer-a", `/v1/recordings/${created.recording.id}`);
    const deleteResponse = await handleV1Request(deleteRequest, new URL(deleteRequest.url));
    expect(deleteResponse!.status).toBe(200);

    const retryRequest = postAs(
      "writer-a",
      "/v1/recordings",
      { raw_text: "private deleted transcript" },
      { "Idempotency-Key": "deleted-request-key" },
    );
    const retryResponse = await handleV1Request(retryRequest, new URL(retryRequest.url));
    expect(retryResponse!.status).toBe(409);
    expect(await retryResponse!.json()).toEqual({ error: "idempotency key is already in use" });
    expect(recordingRows).toHaveLength(0);
  });

  test("a deleted principal's tombstone neither leaks nor binds another principal's key", async () => {
    const createRequest = postAs(
      "writer-a",
      "/v1/recordings",
      { raw_text: "principal A deleted transcript" },
      { "Idempotency-Key": "deleted-shared-key" },
    );
    const createResponse = await handleV1Request(createRequest, new URL(createRequest.url));
    const created = await createResponse!.json() as { recording: { id: string } };
    const deleteRequest = delAs("writer-a", `/v1/recordings/${created.recording.id}`);
    expect((await handleV1Request(deleteRequest, new URL(deleteRequest.url)))!.status).toBe(200);

    const otherRequest = postAs(
      "writer-b",
      "/v1/recordings",
      { raw_text: "principal B request" },
      { "Idempotency-Key": "deleted-shared-key" },
    );
    const otherResponse = await handleV1Request(otherRequest, new URL(otherRequest.url));
    expect(otherResponse!.status).toBe(201);
    expect(await otherResponse!.json()).toEqual({
      recording: expect.objectContaining({ raw_text: "principal B request" }),
    });
    expect(recordingRows).toHaveLength(1);
    expect(recordingRows[0]!["raw_text"]).not.toBe("principal A deleted transcript");
  });

  test("POST /v1/recordings never returns another principal's explicit-id row", async () => {
    const firstRequest = postAs(
      "writer-a",
      "/v1/recordings",
      { id: "shared-explicit-id", raw_text: "principal A private transcript" },
    );
    const firstResponse = await handleV1Request(firstRequest, new URL(firstRequest.url));
    expect(firstResponse!.status).toBe(201);

    const collisionRequest = postAs(
      "writer-b",
      "/v1/recordings",
      { id: "shared-explicit-id", raw_text: "principal B request" },
    );
    const collisionResponse = await handleV1Request(collisionRequest, new URL(collisionRequest.url));
    expect(collisionResponse!.status).toBe(409);
    expect(await collisionResponse!.json()).toEqual({ error: "idempotency key is already in use" });
  });

  test("POST /v1/recordings rejects an idempotency header that conflicts with body id", async () => {
    const request = post(
      "/v1/recordings",
      { id: "recording-a", raw_text: "must not persist" },
      { "Idempotency-Key": "logical-save-b" },
    );
    const response = await handleV1Request(request, new URL(request.url));
    expect(response!.status).toBe(400);
    expect(await response!.json()).toEqual({ error: "recording id conflicts with idempotency key" });
    expect(recordingRows).toHaveLength(0);
    expect(runCalls.some((call) => /insert\s+into\s+recordings/i.test(call.sql))).toBeFalse();
  });

  test("POST /v1/recordings lets a nonempty header define a null body identity", async () => {
    const request = post(
      "/v1/recordings",
      { id: null, raw_text: "settled realtime text" },
      { "Idempotency-Key": "logical-save-null" },
    );
    const response = await handleV1Request(request, new URL(request.url));

    expect(response!.status).toBe(201);
    expect((await response!.json() as { recording: { id: string } }).recording.id).not.toBe("logical-save-null");
    expect(recordingRows).toHaveLength(1);
  });

  test("POST /v1/recordings maps invalid runtime body identities to safe 400 responses", async () => {
    const cases = [
      [{ id: "", raw_text: "must not persist" }, "recording id must not be empty"],
      [{ id: 17, raw_text: "must not persist" }, "recording id must be a string"],
      [{ id: "bad\u0000id", raw_text: "must not persist" }, "recording id must not contain control characters"],
      [{ id: "x".repeat(256), raw_text: "must not persist" }, "recording id must not exceed 255 characters"],
    ] as const;
    for (const [body, message] of cases) {
      const request = post("/v1/recordings", body);
      const response = await handleV1Request(request, new URL(request.url));
      expect(response!.status).toBe(400);
      expect(await response!.json()).toEqual({ error: message });
    }
    expect(recordingRows).toHaveLength(0);
  });

  test("POST /v1/recordings maps invalid idempotency headers to safe 400 responses", async () => {
    const cases = [
      ["", "idempotency key must not be empty"],
      ["logical-save-\u00e9", "idempotency key must contain only printable ASCII characters"],
      ["x".repeat(256), "idempotency key must not exceed 255 characters"],
    ] as const;
    for (const [key, message] of cases) {
      const request = post(
        "/v1/recordings",
        { raw_text: "must not persist" },
        { "Idempotency-Key": key },
      );
      const response = await handleV1Request(request, new URL(request.url));
      expect(response!.status).toBe(400);
      expect(await response!.json()).toEqual({ error: message });
    }
    expect(recordingRows).toHaveLength(0);
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
