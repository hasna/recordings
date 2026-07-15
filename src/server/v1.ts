/**
 * Versioned `/v1` HTTP API for `recordings-serve` (A1 pure-remote).
 *
 * Every handler goes through the repo-native Postgres repository (`./repo.ts`)
 * which reads/writes the shared cloud Postgres directly. Auth is enforced by the contracts
 * API-key verifier: reads require `recordings:read`, writes require
 * `recordings:write` (a `recordings:*` key satisfies both). This is a real
 * wrapper over the core storage lib — there are NO stubs; unimplemented routes
 * return 404.
 */
import type { CreateRecordingInput } from "../types/index.js";
import { getCloudPg, getCloudVerifier, ensureCloudSchema } from "./cloud.js";
import * as repo from "./repo.js";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function error(status: number, message: string, extra?: Record<string, unknown>): Response {
  return json({ error: message, ...(extra ?? {}) }, status);
}

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    const text = await req.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Handle a `/v1/*` request. Returns `null` when the path is not a `/v1` route so
 * the caller can fall through to other handlers.
 */
export async function handleV1Request(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (path !== "/v1" && !path.startsWith("/v1/")) return null;

  const method = req.method.toUpperCase();
  const isWrite = method !== "GET" && method !== "HEAD";
  const requiredScopes = [isWrite ? "recordings:write" : "recordings:read"];

  // ── Auth (contracts API-key verifier) ──
  let decision;
  try {
    const verifier = getCloudVerifier();
    decision = await verifier.authenticate(req.headers, { method, path, requiredScopes });
  } catch {
    return error(503, "authentication service unavailable");
  }
  if (!decision.ok) {
    return error(decision.status, decision.message, { reason: decision.reason });
  }

  // Schema is idempotently ensured on the first authenticated request.
  let pg;
  try {
    await ensureCloudSchema();
    pg = getCloudPg();
  } catch {
    return error(503, "storage unavailable");
  }

  const segments = path.split("/").filter(Boolean); // ["v1", resource, id?, action?]
  const resource = segments[1];
  const id = segments[2] ? decodeURIComponent(segments[2]) : undefined;
  const action = segments[3] ? decodeURIComponent(segments[3]) : undefined;

  try {
    // ── /v1/recordings ──
    if (resource === "recordings") {
      if (!id) {
        if (method === "GET") {
          const filter = {
            ...(url.searchParams.get("agent_id") ? { agent_id: url.searchParams.get("agent_id")! } : {}),
            ...(url.searchParams.get("project_id") ? { project_id: url.searchParams.get("project_id")! } : {}),
            ...(url.searchParams.get("session_id") ? { session_id: url.searchParams.get("session_id")! } : {}),
            ...(url.searchParams.get("processing_mode")
              ? { processing_mode: url.searchParams.get("processing_mode") as CreateRecordingInput["processing_mode"] }
              : {}),
            ...(url.searchParams.getAll("tags").length > 0
              ? { tags: url.searchParams.getAll("tags") }
              : {}),
            ...(url.searchParams.get("search") ? { search: url.searchParams.get("search")! } : {}),
            ...(url.searchParams.get("since") ? { since: url.searchParams.get("since")! } : {}),
            ...(url.searchParams.get("until") ? { until: url.searchParams.get("until")! } : {}),
            ...(url.searchParams.get("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
            ...(url.searchParams.get("offset") ? { offset: Number(url.searchParams.get("offset")) } : {}),
          };
          const [recordings, count] = await Promise.all([
            repo.listRecordings(pg, filter),
            repo.countRecordings(pg, filter),
          ]);
          return json({ recordings, count });
        }
        if (method === "POST") {
          const body = await readJson<CreateRecordingInput>(req);
          if (!body || typeof body.raw_text !== "string" || !body.raw_text.trim()) {
            return error(400, "raw_text is required");
          }
          const recording = await repo.createRecording(
            pg,
            body,
            req.headers.get("Idempotency-Key") ?? undefined,
            { principal: `${decision.principal.app}:${decision.principal.kid}` },
          );
          return json({ recording }, 201);
        }
        return error(405, `method ${method} not allowed on /v1/recordings`);
      }
      // /v1/recordings/:id
      if (method === "GET") {
        const recording = await repo.getRecording(pg, id);
        return recording ? json({ recording }) : error(404, "recording not found");
      }
      if (method === "DELETE") {
        const deleted = await repo.deleteRecording(pg, id);
        return deleted ? json({ deleted: true }) : error(404, "recording not found");
      }
      return error(405, `method ${method} not allowed on /v1/recordings/:id`);
    }

    // ── /v1/stats ──
    if (resource === "stats") {
      if (method === "GET") return json(await repo.getRecordingStats(pg));
      return error(405, `method ${method} not allowed on /v1/stats`);
    }

    // ── /v1/agents ──
    if (resource === "agents") {
      if (!id) {
        if (method === "GET") {
          const agents = await repo.listAgents(pg);
          return json({ agents, count: agents.length });
        }
        if (method === "POST") {
          const body = await readJson<{ name?: string; description?: string; role?: string }>(req);
          if (!body || typeof body.name !== "string" || !body.name.trim()) {
            return error(400, "name is required");
          }
          const agent = await repo.registerAgent(pg, body.name, body.description ?? null, body.role ?? null);
          return json({ agent }, 201);
        }
        return error(405, `method ${method} not allowed on /v1/agents`);
      }
      // /v1/agents/:id/heartbeat
      if (action === "heartbeat") {
        if (method !== "POST") return error(405, `method ${method} not allowed on /v1/agents/:id/heartbeat`);
        const agent = await repo.heartbeatAgent(pg, id);
        return agent ? json({ agent }) : error(404, "agent not found");
      }
      // /v1/agents/:id/focus
      if (action === "focus") {
        if (method !== "POST") return error(405, `method ${method} not allowed on /v1/agents/:id/focus`);
        const body = await readJson<{ project_id?: string | null }>(req);
        try {
          const agent = await repo.setAgentFocus(pg, id, body?.project_id ?? null);
          return agent ? json({ agent }) : error(404, "agent not found");
        } catch (e) {
          // Unknown project ref -> clean 400 (never leak the raw FK error).
          if (e instanceof repo.ProjectNotFoundError) return error(400, e.message);
          throw e;
        }
      }
      if (action) return error(404, `unknown agent action: ${action}`);
      if (method === "GET") {
        const agent = await repo.getAgent(pg, id);
        return agent ? json({ agent }) : error(404, "agent not found");
      }
      return error(405, `method ${method} not allowed on /v1/agents/:id`);
    }

    // ── /v1/projects ──
    if (resource === "projects") {
      if (!id) {
        if (method === "GET") {
          const projects = await repo.listProjects(pg);
          return json({ projects, count: projects.length });
        }
        if (method === "POST") {
          const body = await readJson<{ name?: string; path?: string; description?: string }>(req);
          if (!body || typeof body.name !== "string" || !body.name.trim() || typeof body.path !== "string" || !body.path.trim()) {
            return error(400, "name and path are required");
          }
          const project = await repo.registerProject(pg, body.name, body.path, body.description ?? null);
          return json({ project }, 201);
        }
        return error(405, `method ${method} not allowed on /v1/projects`);
      }
      if (method === "GET") {
        const project = await repo.getProject(pg, id);
        return project ? json({ project }) : error(404, "project not found");
      }
      return error(405, `method ${method} not allowed on /v1/projects/:id`);
    }

    // ── /v1/feedback ──
    if (resource === "feedback") {
      if (id) return error(404, "feedback has no item routes");
      if (method === "POST") {
        const body = await readJson<{ message?: string; email?: string; category?: string; version?: string }>(req);
        if (!body || typeof body.message !== "string" || !body.message.trim()) {
          return error(400, "message is required");
        }
        return json(
          await repo.saveFeedback(pg, {
            message: body.message,
            email: body.email ?? null,
            category: body.category ?? null,
            version: body.version ?? null,
          }),
          201,
        );
      }
      return error(405, `method ${method} not allowed on /v1/feedback`);
    }

    return error(404, `unknown /v1 resource: ${resource ?? ""}`);
  } catch (e) {
    // Clean domain errors carry a safe, client-facing message → 400.
    if (e instanceof repo.ProjectNotFoundError || e instanceof repo.ValidationError) {
      return error(400, e.message);
    }
    if (e instanceof repo.IdempotencyConflictError) {
      return error(409, e.message);
    }
    // Anything else is an unexpected/internal failure. Its raw text (e.g. a
    // Postgres constraint name like `agents_active_project_id_fkey`, table or
    // column names, or a DSN fragment) must NEVER reach the client. Log it
    // server-side for diagnosis and return a generic message.
    console.error(`[recordings-serve] unhandled ${method} ${path} error:`, e);
    return error(500, "internal server error");
  }
}
