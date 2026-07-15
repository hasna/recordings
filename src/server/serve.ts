/**
 * HTTP server for `recordings-serve`.
 *
 * Surfaces:
 *   GET /health   → { status, version, mode }        (unauthenticated liveness)
 *   GET /ready    → { status, version, mode }         (checks cloud Postgres reachability)
 *   GET /version  → { status, version, mode, name }
 *   GET /openapi.json (and /v1/openapi.json)          (SDK source of truth)
 *   ANY /v1/*     → versioned cloud API (A1 pure-remote, API-key auth)
 *   ANY /mcp      → MCP Streamable HTTP (same API-key auth as /v1)
 *
 * Per Amendment A1 the `/v1` handlers read/write the shared cloud Postgres directly with
 * @hasna/contracts API-key auth. No local sync/cache lives in the service.
 */
import { VERSION } from "../version.js";
import { isCloudModeEnabled } from "./cloud-config.js";
import { handleV1Request } from "./v1.js";
import { buildV1OpenApiDocument } from "./openapi.js";

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=, microphone=, geolocation=",
};

function jsonResponse(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...SECURITY_HEADERS, ...(headers || {}) },
  });
}

// ── Simple per-IP rate limiter ──────────────────────────────────────────────
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = Number.parseInt(process.env["RECORDINGS_RATE_LIMIT_MAX"] || "240", 10);

function resolveClientIp(
  req: Request,
  server: { requestIP(req: Request): { address: string } | null },
): string {
  const trustProxy = process.env["RECORDINGS_TRUST_PROXY"] === "1" || process.env["RECORDINGS_TRUST_PROXY"] === "true";
  if (trustProxy) {
    const forwarded =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim();
    if (forwarded) return forwarded;
  }
  return server.requestIP(req)?.address || "unknown";
}

function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { allowed: true };
}

export interface StartServerOptions {
  host?: string;
}

export interface BuildFetchOptions {
  checkCloudAuth?: () => unknown | Promise<unknown>;
  pingCloud?: () => Promise<unknown>;
  logError?: (...args: unknown[]) => void;
}

export function buildFetch(options: BuildFetchOptions = {}) {
  const checkCloudAuth = options.checkCloudAuth ?? (async () => {
    const { getCloudVerifier } = await import("./cloud.js");
    return getCloudVerifier();
  });
  const checkCloud = options.pingCloud ?? (async () => {
    const { pingCloud } = await import("./cloud.js");
    return pingCloud();
  });
  const logError = options.logError ?? console.error;
  return async function fetch(
    req: Request,
    server: { requestIP(req: Request): { address: string } | null },
  ): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": req.headers.get("origin") || "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Authorization",
          Vary: "Origin",
        },
      });
    }

    // Rate limiting (all requests), keyed on the real socket peer.
    const ip = resolveClientIp(req, server);
    const rl = checkRateLimit(ip);
    if (!rl.allowed) {
      return jsonResponse({ error: "Too many requests", retry_after: rl.retryAfter }, 429, {
        "Retry-After": String(rl.retryAfter ?? 60),
      });
    }

    const mode = isCloudModeEnabled() ? "remote" : "local";

    // ── Service surface probes (unauthenticated): /health /ready /version ──
    if ((path === "/health" || path === "/ready" || path === "/version") && method === "GET") {
      if (path === "/version") {
        return jsonResponse({ status: "ok", version: VERSION, mode, name: "recordings" });
      }
      if (path === "/ready") {
        if (mode === "remote") {
          try {
            await checkCloudAuth();
            await checkCloud();
          } catch {
            logError("recordings-serve: readiness dependency check failed");
            return jsonResponse(
              { status: "unavailable", version: VERSION, mode, error: "dependency unavailable" },
              503,
            );
          }
        }
        return jsonResponse({ status: "ready", version: VERSION, mode });
      }
      return jsonResponse({ status: "ok", version: VERSION, mode, name: "recordings" });
    }

    // ── OpenAPI document (unauthenticated; source of truth for the SDK) ──
    if ((path === "/openapi.json" || path === "/v1/openapi.json") && method === "GET") {
      return jsonResponse(buildV1OpenApiDocument());
    }

    // ── Versioned cloud API (/v1/*): A1 pure-remote, self-authenticating ──
    if (path === "/v1" || path.startsWith("/v1/")) {
      const res = await handleV1Request(req, url);
      if (res) return res;
    }

    // ── MCP Streamable HTTP — gated by the SAME API-key auth as /v1 ──
    if (path === "/mcp") {
      let verifier;
      try {
        const { getCloudVerifier } = await import("./cloud.js");
        verifier = getCloudVerifier();
      } catch (e) {
        return jsonResponse({ error: (e as Error).message }, 503);
      }
      const decision = await verifier.authenticate(req.headers, {
        method,
        path,
        requiredScopes: [method === "GET" ? "recordings:read" : "recordings:write"],
      });
      if (!decision.ok) {
        return jsonResponse({ error: decision.message, reason: decision.reason }, decision.status);
      }
      const { handleMcpRequest } = await import("../mcp/http.js");
      const { buildServer } = await import("../mcp/index.js");
      return handleMcpRequest(req, buildServer);
    }

    return jsonResponse({ error: "Not found" }, 404);
  };
}

export async function startServer(port: number, options?: StartServerOptions): Promise<ReturnType<typeof Bun.serve>> {
  const hostname = options?.host || process.env.HOST || "127.0.0.1";
  const fetch = buildFetch();
  const server = Bun.serve({ port, hostname, fetch });

  const shutdown = async () => {
    try {
      const { closeCloud } = await import("./cloud.js");
      await closeCloud();
    } catch {
      // ignore
    }
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const mode = isCloudModeEnabled() ? "remote (A1 pure-remote)" : "local";
  console.log(`recordings-serve listening on http://${hostname}:${port} (mode: ${mode})`);
  return server;
}
