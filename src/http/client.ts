// Vendored HTTP storage client for the Hasna Service Contract v1.
//
// This is a self-contained copy of the `@hasna/contracts` client-flip transport
// + storage client (resolveStorageClient / createHasnaHttpTransport). It is
// vendored here — rather than imported from `@hasna/contracts` — because the
// published contracts package does not yet expose the client subpath, and this
// package externalizes `@hasna/contracts` at build time. Vendoring keeps the
// HTTP read/write path self-contained in the shipped `dist` bundle so an
// installed CLI works without an unpublished dependency.
//
// THE CLIENT HAS EXACTLY TWO STORES: `sqlite` (an on-box file) and `http` (the
// server's `<API_URL>/v1` API with a bearer key). It NEVER opens Postgres — the
// server's internal storage engine is the server's business and is invisible
// here. Deployment modes (`local | self_hosted | cloud | remote | hybrid`) are
// removed; see src/lib/retired-deployment-modes.ts for why a retired word now
// throws instead of being silently normalized.
//
// SAFETY: never logs, returns, or embeds the API key value.

import {
  asRetiredDeploymentMode,
  normalizeModeToken,
  retiredDeploymentModeError,
  type RetiredModeReplacement,
} from "../lib/retired-deployment-modes.js";

export type Env = Record<string, string | undefined>;

/** Where a client reads and writes. Two arms, no third. */
export type ClientStore = "sqlite" | "http";

/**
 * Values that belong to the SERVER's data-backend switch, not to the client.
 *
 * `recordings-serve` is configured with `HASNA_RECORDINGS_STORAGE_MODE=postgresql`,
 * and a CLI running in that same container inherits the variable. It says nothing
 * about where the CLIENT should read, so the client ignores it rather than
 * guessing — while a retired deployment word in the same variable still throws,
 * because that one WOULD have changed the client's routing before this change.
 */
const SERVER_BACKEND_VALUES = ["sqlite", "postgresql", "postgres"] as const;

function envToken(name: string): string {
  return name.toUpperCase().replace(/-/g, "_");
}

function clientStoreReplacement(envKey: string): RetiredModeReplacement {
  return { envKey, onBox: "sqlite", offBox: "http" };
}

function normalizeClientStore(value: string, sourceEnvKey: string, replacementEnvKey: string): ClientStore {
  const normalized = normalizeModeToken(value);
  if (normalized === "sqlite") return "sqlite";
  if (normalized === "http" || normalized === "https") return "http";
  if (asRetiredDeploymentMode(value)) {
    throw retiredDeploymentModeError(value, sourceEnvKey, clientStoreReplacement(replacementEnvKey));
  }
  throw new Error(`Unknown client store: ${value}. Use sqlite or http.`);
}

export function defaultApiBaseUrl(name: string): string {
  return `https://${name}.hasna.xyz`;
}

interface EnvKeys {
  /** The live client-store switch. */
  storeKeys: string[];
  /** Variables that used to carry a deployment mode and must no longer route anything. */
  retiredModeKeys: string[];
  apiUrlKeys: string[];
  apiKeyKeys: string[];
}

function envKeys(name: string): EnvKeys {
  const token = envToken(name);
  return {
    storeKeys: [`HASNA_${token}_CLIENT_STORE`, `${token}_CLIENT_STORE`],
    retiredModeKeys: [`HASNA_${token}_STORAGE_MODE`, `HASNA_${token}_MODE`, `${token}_STORAGE_MODE`, `${token}_MODE`],
    apiUrlKeys: [`HASNA_${token}_API_URL`, `${token}_API_URL`],
    apiKeyKeys: [`HASNA_${token}_API_KEY`, `${token}_API_KEY`],
  };
}

function firstEnv(env: Env, keys: readonly string[]): { key: string; value: string } | null {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return { key, value };
  }
  return null;
}

/**
 * Refuse a retired deployment word wherever one of the old mode variables still
 * carries it. Values that belong to the server's backend switch are ignored (see
 * SERVER_BACKEND_VALUES); anything else in those variables is an error, because
 * before this change an unrecognized value there silently fell back to on-box.
 */
function assertNoRetiredMode(env: Env, keys: EnvKeys): void {
  for (const key of keys.retiredModeKeys) {
    const value = env[key]?.trim();
    if (!value) continue;
    const normalized = normalizeModeToken(value);
    if ((SERVER_BACKEND_VALUES as readonly string[]).includes(normalized)) continue;
    if (asRetiredDeploymentMode(value)) {
      throw retiredDeploymentModeError(value, key, clientStoreReplacement(keys.storeKeys[0]!));
    }
    throw new Error(
      `${key}=${value} is not a client store. ${key} no longer selects one; ` +
        `set ${keys.storeKeys[0]}=sqlite or ${keys.storeKeys[0]}=http instead.`,
    );
  }
}

export function toV1BaseUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("API URL must use http or https.");
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1")) path = path.slice(0, -"/v1".length);
  url.pathname = `${path}/v1`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export type TransportKind = ClientStore;

export interface TransportResolution {
  /** The store actually in use. `sqlite` whenever routing to `http` was refused. */
  transport: TransportKind;
  /** The store that was asked for. Differs from `transport` only when misconfigured. */
  requested: ClientStore;
  /** What decided it: an env var NAME, `auto:api-url+api-key`, or `default`. Never a value. */
  modeSource: string;
  baseUrl: string | null;
  apiKeyPresent: boolean;
  misconfigured: boolean;
  warning: string | null;
}

// Resolve where a client should read/write given the environment.
// transport is `http` IFF the client store resolves to http AND an API key is
// present. http requested but no key => misconfigured (caller hard-fails) so we
// never silently drift onto the wrong on-box dataset.
export function resolveTransport(name: string, env: Env = process.env): TransportResolution {
  const keys = envKeys(name);
  assertNoRetiredMode(env, keys);
  const storeHit = firstEnv(env, keys.storeKeys);
  const urlHit = firstEnv(env, keys.apiUrlKeys);
  const keyHit = firstEnv(env, keys.apiKeyKeys);

  let requested: ClientStore = "sqlite";
  let modeSource = "default";

  if (storeHit) {
    requested = normalizeClientStore(storeHit.value, storeHit.key, keys.storeKeys[0]!);
    modeSource = storeHit.key;
  } else if (urlHit && keyHit) {
    // The fleet flip (@hasna/machines) writes ONLY HASNA_<APP>_API_URL +
    // HASNA_<APP>_API_KEY — no store var. Presence of both IS the signal to use
    // the API, so route to http. Rollback = unset either var -> back to sqlite.
    // An explicit store var (handled above) still wins, so `...CLIENT_STORE=sqlite`
    // forces the on-box file even when the URL/key are present.
    requested = "http";
    modeSource = "auto:api-url+api-key";
  }

  if (requested === "sqlite") {
    return { transport: "sqlite", requested, modeSource, baseUrl: null, apiKeyPresent: Boolean(keyHit), misconfigured: false, warning: null };
  }

  if (!keyHit) {
    return {
      transport: "sqlite",
      requested,
      modeSource,
      baseUrl: null,
      apiKeyPresent: false,
      misconfigured: true,
      warning: `${modeSource}=http but no API key is set (${keys.apiKeyKeys[0]}). Refusing to route to the API.`,
    };
  }

  const rawUrl = urlHit?.value ?? defaultApiBaseUrl(name);
  let baseUrl: string;
  try {
    baseUrl = toV1BaseUrl(rawUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { transport: "sqlite", requested, modeSource, baseUrl: null, apiKeyPresent: true, misconfigured: true, warning: `Invalid API URL: ${message}.` };
  }

  return { transport: "http", requested, modeSource, baseUrl, apiKeyPresent: true, misconfigured: false, warning: null };
}

export class HasnaHttpError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  constructor(method: string, path: string, status: number, body: unknown) {
    super(`Hasna request failed: ${method} ${path} -> ${status}`);
    this.name = "HasnaHttpError";
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type QueryParams = Record<string, string | number | boolean | null | undefined | ReadonlyArray<string | number | boolean>>;

export interface RequestOptions {
  query?: QueryParams;
  idempotencyKey?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  retries?: number;
}

export interface HttpTransport {
  readonly baseUrl: string;
  request<T = unknown>(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  get<T = unknown>(path: string, opts?: RequestOptions): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  put<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  del<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
}

export interface TransportOptions {
  name: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}

function appendQuery(path: string, query?: QueryParams): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) params.append(key, String(v));
    else params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
}

const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createHttpTransport(options: TransportOptions): HttpTransport {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const base = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const sleep = options.sleepImpl ?? defaultSleep;

  async function once<T>(method: string, rel: string, url: string, body: unknown, opts: RequestOptions): Promise<{ ok: true; value: T } | { ok: false; retryable: boolean; error: Error }> {
    const headers: Record<string, string> = {
      "x-api-key": options.apiKey,
      Authorization: `Bearer ${options.apiKey}`,
      Accept: "application/json",
      ...(opts.headers ?? {}),
    };
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? timeoutMs);
    init.signal = controller.signal;
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (opts.signal?.aborted) return { ok: false, retryable: false, error: err };
      return { ok: false, retryable: true, error: err };
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    }
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      return { ok: false, retryable: RETRY_STATUSES.has(response.status), error: new HasnaHttpError(method, rel, response.status, parsed) };
    }
    return { ok: true, value: parsed as T };
  }

  async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    const upper = method.toUpperCase();
    const rel = appendQuery(path.startsWith("/") ? path : `/${path}`, opts.query);
    const url = `${base}${rel}`;
    const methodRetryable = IDEMPOTENT.has(upper) || Boolean(opts.idempotencyKey);
    const maxRetries = opts.retries ?? 2;
    const maxAttempts = methodRetryable ? maxRetries + 1 : 1;
    let last: { error: Error } | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await once<T>(upper, rel, url, body, opts);
      if (result.ok) return result.value;
      last = result;
      const canRetry = methodRetryable && result.retryable && attempt < maxAttempts;
      if (!canRetry) break;
      const backoff = Math.min(2_000, 200 * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * (backoff / 2 + 1));
      await sleep(backoff + jitter);
    }
    throw last!.error;
  }

  return {
    baseUrl: base,
    request,
    get: (path, opts) => request("GET", path, undefined, opts),
    post: (path, body, opts) => request("POST", path, body, opts),
    patch: (path, body, opts) => request("PATCH", path, body, opts),
    put: (path, body, opts) => request("PUT", path, body, opts),
    del: (path, body, opts) => request("DELETE", path, body, opts),
  };
}

function newIdempotencyKey(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `idmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export interface StorageClient {
  readonly name: string;
  readonly baseUrl: string;
  readonly transport: HttpTransport;
  list<T = unknown>(resource: string, query?: QueryParams): Promise<{ items: T[]; raw: unknown }>;
  get<T = unknown>(resource: string, id: string): Promise<T | null>;
  create<T = unknown>(resource: string, body: unknown, idempotencyKey?: string): Promise<T>;
  update<T = unknown>(resource: string, id: string, patch: unknown, method?: "PATCH" | "PUT"): Promise<T>;
  delete(resource: string, id: string): Promise<void>;
}

function extractItems<T>(raw: unknown, extraKeys: string[] = []): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of [...extraKeys, "items", "data", "results", "rows", "records"]) {
      if (Array.isArray(obj[key])) return obj[key] as T[];
    }
  }
  return [];
}

export function createStorageClient(name: string, transport: HttpTransport): StorageClient {
  const rp = (r: string) => `/${r.replace(/^\/+|\/+$/g, "")}`;
  const ep = (r: string, id: string) => `${rp(r)}/${encodeURIComponent(String(id))}`;
  return {
    name,
    baseUrl: transport.baseUrl,
    transport,
    async list<T = unknown>(resource: string, query?: QueryParams) {
      const raw = await transport.get<unknown>(rp(resource), { query });
      return { items: extractItems<T>(raw, [resource]), raw };
    },
    async get<T = unknown>(resource: string, id: string) {
      try {
        return await transport.get<T>(ep(resource, id));
      } catch (error) {
        if (error instanceof HasnaHttpError && error.status === 404) return null;
        throw error;
      }
    },
    async create<T = unknown>(resource: string, body: unknown, idempotencyKey?: string) {
      return transport.post<T>(rp(resource), body, { idempotencyKey: idempotencyKey ?? newIdempotencyKey() });
    },
    async update<T = unknown>(resource: string, id: string, patch: unknown, method: "PATCH" | "PUT" = "PATCH") {
      const call = method === "PUT" ? transport.put<T> : transport.patch<T>;
      return call(ep(resource, id), patch);
    },
    async delete(resource: string, id: string) {
      try {
        await transport.del(ep(resource, id));
      } catch (error) {
        if (error instanceof HasnaHttpError && error.status === 404) return;
        throw error;
      }
    },
  };
}

export type ResolveResult =
  | { transport: "sqlite"; client: null; resolution: TransportResolution }
  | { transport: "http"; client: StorageClient; resolution: TransportResolution };

// The one call an app's storage resolver makes. Returns a ready StorageClient
// when the client store resolves to `http` (CLIENT_STORE=http, or API_URL +
// API_KEY present), else { transport:'sqlite' }. Throws if the API was requested
// but misconfigured (so callers never silently read the wrong dataset).
export function resolveStorageClient(name: string, env: Env = process.env, fetchImpl?: FetchLike): ResolveResult {
  const resolution = resolveTransport(name, env);
  if (resolution.misconfigured) {
    throw new Error(resolution.warning ?? `Client for '${name}' is misconfigured for the /v1 API.`);
  }
  if (resolution.transport === "sqlite" || !resolution.baseUrl) {
    return { transport: "sqlite", client: null, resolution };
  }
  const keys = envKeys(name);
  const apiKey = firstEnv(env, keys.apiKeyKeys)?.value;
  if (!apiKey) throw new Error(`Client for '${name}' resolved to the /v1 API without an API key.`);
  const transport = createHttpTransport({ name, baseUrl: resolution.baseUrl, apiKey, ...(fetchImpl ? { fetchImpl } : {}) });
  return { transport: "http", client: createStorageClient(name, transport), resolution };
}
