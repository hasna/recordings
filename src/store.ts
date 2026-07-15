// The single storage abstraction for @hasna/recordings.
//
// EVERY CLI command and MCP tool reads/writes through a `Store`. There are two
// transports behind the one interface:
//   • LocalStore  — on-box SQLite (src/db/*), first-class, fully functional.
//   • ApiStore    — the self-hosted / cloud HTTP `/v1` API with a bearer key.
//
// The transport is resolved from the environment by `resolveStorageClient`
// (src/http/client.ts): presence of HASNA_RECORDINGS_API_URL +
// HASNA_RECORDINGS_API_KEY (or an explicit STORAGE_MODE) routes to the ApiStore;
// otherwise the LocalStore is used. `self_hosted` and `cloud` are the SAME client
// code (ApiStore) — only the URL/key differ; that distinction is server-side
// tenancy, never a client concern.
//
// SAFETY: the ApiStore authenticates with a bearer key ONLY. A raw database DSN
// is NEVER read or accepted on the client. The key value is never logged.

import type {
  Recording,
  CreateRecordingInput,
  RecordingFilter,
  Agent,
  Project,
} from "./types/index.js";
import * as recordingsDb from "./db/recordings.js";
import * as agentsDb from "./db/agents.js";
import * as projectsDb from "./db/projects.js";
import { saveFeedback as saveFeedbackLocal, type FeedbackInput } from "./db/feedback.js";
import { resolveStorageClient, type StorageClient } from "./http/client.js";
import { createHash, randomUUID } from "node:crypto";
import { recordingCreateIdentity } from "./lib/recording-create-identity.js";

export const APP = "recordings";

export type { FeedbackInput } from "./db/feedback.js";

export interface RecordingStats {
  total: number;
  raw: number;
  enhanced: number;
  total_duration_ms: number;
  by_model: Record<string, number>;
}

export interface Store {
  readonly mode: "local" | "cloud-http";
  readonly baseUrl: string | null;

  // ── recordings ──
  createRecording(input: CreateRecordingInput, idempotencyKey?: string): Promise<Recording>;
  getRecording(id: string): Promise<Recording | null>;
  listRecordings(filter?: RecordingFilter): Promise<Recording[]>;
  countRecordings?(filter?: RecordingFilter): Promise<number>;
  searchRecordings(query: string, filter?: RecordingFilter): Promise<Recording[]>;
  deleteRecording(id: string): Promise<boolean>;
  getRecordingStats(): Promise<RecordingStats>;

  // ── agents ──
  registerAgent(name: string, description?: string, role?: string): Promise<Agent>;
  getAgent(idOrName: string): Promise<Agent | null>;
  listAgents(): Promise<Agent[]>;
  heartbeatAgent(idOrName: string): Promise<Agent | null>;
  setAgentFocus(idOrName: string, projectId: string | null): Promise<Agent | null>;

  // ── projects ──
  registerProject(name: string, path: string, description?: string): Promise<Project>;
  getProject(idOrPath: string): Promise<Project | null>;
  listProjects(): Promise<Project[]>;

  // ── feedback ──
  saveFeedback(input: FeedbackInput): Promise<void>;
}

function listQuery(
  filter?: RecordingFilter,
): Record<string, string | number | string[] | undefined> {
  if (!filter) return {};
  return {
    agent_id: filter.agent_id,
    project_id: filter.project_id,
    session_id: filter.session_id,
    processing_mode: filter.processing_mode,
    tags: filter.tags,
    search: filter.search,
    since: filter.since,
    until: filter.until,
    limit: filter.limit,
    offset: filter.offset,
  };
}

function unwrap<T>(res: unknown, key: string): T {
  if (res && typeof res === "object" && key in (res as Record<string, unknown>)) {
    return (res as Record<string, T>)[key]!;
  }
  return res as T;
}

// ── LocalStore (on-box SQLite) ────────────────────────────────────────────────

const localStore: Store = {
  mode: "local",
  baseUrl: null,
  async createRecording(input, idempotencyKey) {
    return recordingsDb.createRecording(input, undefined, idempotencyKey);
  },
  async getRecording(id) {
    return recordingsDb.getRecording(id);
  },
  async listRecordings(filter) {
    return recordingsDb.listRecordings(filter);
  },
  async countRecordings(filter) {
    return recordingsDb.countRecordings(filter);
  },
  async searchRecordings(query, filter) {
    return recordingsDb.searchRecordings(query, filter);
  },
  async deleteRecording(id) {
    return recordingsDb.deleteRecording(id);
  },
  async getRecordingStats() {
    return recordingsDb.getRecordingStats();
  },
  async registerAgent(name, description, role) {
    return agentsDb.registerAgent(name, description, role);
  },
  async getAgent(idOrName) {
    return agentsDb.getAgent(idOrName);
  },
  async listAgents() {
    return agentsDb.listAgents();
  },
  async heartbeatAgent(idOrName) {
    return agentsDb.heartbeatAgent(idOrName);
  },
  async setAgentFocus(idOrName, projectId) {
    return agentsDb.setAgentFocus(idOrName, projectId);
  },
  async registerProject(name, path, description) {
    return projectsDb.registerProject(name, path, description);
  },
  async getProject(idOrPath) {
    return projectsDb.getProject(idOrPath);
  },
  async listProjects() {
    return projectsDb.listProjects();
  },
  async saveFeedback(input) {
    saveFeedbackLocal(input);
  },
};

// ── ApiStore (self-hosted / cloud HTTP `/v1` + bearer key) ────────────────────

function apiStore(client: StorageClient): Store {
  return {
    mode: "cloud-http",
    baseUrl: client.baseUrl,
    async createRecording(input, idempotencyKey) {
      const keyCandidate = idempotencyKey === undefined
        && (input.id === undefined || input.id === null)
        ? randomUUID()
        : idempotencyKey;
      const identity = recordingCreateIdentity(
        input,
        keyCandidate,
      );
      const res = await client.create<unknown>(
        "recordings",
        identity.input,
        identity.idempotencyKey,
      );
      return unwrap<Recording>(res, "recording");
    },
    async getRecording(id) {
      const res = await client.get<unknown>("recordings", id);
      return res ? unwrap<Recording>(res, "recording") : null;
    },
    async listRecordings(filter) {
      const { items } = await client.list<Recording>("recordings", listQuery(filter));
      return items;
    },
    async countRecordings(filter) {
      const pageLimit = 500;
      const maxPageRequests = 10_000;
      let offset = 0;
      let pageRequests = 0;
      const seenPageKeys = new Set<string>();

      while (pageRequests < maxPageRequests) {
        pageRequests += 1;
        const { items, raw } = await client.list<Recording>("recordings", {
          ...listQuery(filter),
          limit: pageLimit,
          offset,
        });
        const count = raw && typeof raw === "object"
          ? (raw as { count?: unknown }).count
          : undefined;
        if (typeof count !== "number" || !Number.isFinite(count)) {
          throw new Error("Recordings API response is missing a valid count");
        }

        // Current servers return the filtered total. Legacy servers returned
        // the current page length, so a full page must be followed until EOF.
        if (count > items.length) return count;
        if (items.length === 0) return offset;
        offset += items.length;

        const pageKey = recordingPageFingerprint(items);
        if (seenPageKeys.has(pageKey)) {
          throw new Error("Recordings API ignored pagination while counting legacy results");
        }
        seenPageKeys.add(pageKey);
      }
      throw new Error(`Recordings API exceeded ${maxPageRequests} pages while counting legacy results`);
    },
    async searchRecordings(query, filter) {
      const { items } = await client.list<Recording>("recordings", listQuery({ ...(filter ?? {}), search: query }));
      return items;
    },
    async deleteRecording(id) {
      try {
        const res = await client.transport.del<{ deleted?: boolean }>(`/recordings/${encodeURIComponent(id)}`);
        return res?.deleted !== false;
      } catch (error) {
        if (error && typeof error === "object" && (error as { status?: number }).status === 404) return false;
        throw error;
      }
    },
    async getRecordingStats() {
      const res = await client.transport.get<Partial<RecordingStats>>("/stats");
      return {
        total: res.total ?? 0,
        raw: res.raw ?? 0,
        enhanced: res.enhanced ?? 0,
        total_duration_ms: res.total_duration_ms ?? 0,
        by_model: res.by_model ?? {},
      };
    },
    async registerAgent(name, description, role) {
      const res = await client.create<unknown>("agents", { name, description, role });
      return unwrap<Agent>(res, "agent");
    },
    async getAgent(idOrName) {
      const res = await client.get<unknown>("agents", idOrName);
      return res ? unwrap<Agent>(res, "agent") : null;
    },
    async listAgents() {
      const { items } = await client.list<Agent>("agents");
      return items;
    },
    async heartbeatAgent(idOrName) {
      try {
        const res = await client.transport.post<unknown>(`/agents/${encodeURIComponent(idOrName)}/heartbeat`);
        return res ? unwrap<Agent>(res, "agent") : null;
      } catch (error) {
        if (error && typeof error === "object" && (error as { status?: number }).status === 404) return null;
        throw error;
      }
    },
    async setAgentFocus(idOrName, projectId) {
      try {
        const res = await client.transport.post<unknown>(`/agents/${encodeURIComponent(idOrName)}/focus`, { project_id: projectId });
        return res ? unwrap<Agent>(res, "agent") : null;
      } catch (error) {
        if (error && typeof error === "object") {
          const status = (error as { status?: number }).status;
          if (status === 404) return null;
          // A 400 means the project ref could not be resolved server-side.
          // Surface the server's clean message ("project not found: X") instead
          // of the generic "request failed -> 400".
          if (status === 400) {
            const body = (error as { body?: unknown }).body;
            const msg = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
              ? (body as { error: string }).error
              : "invalid focus request";
            throw new Error(msg);
          }
        }
        throw error;
      }
    },
    async registerProject(name, path, description) {
      const res = await client.create<unknown>("projects", { name, path, description });
      return unwrap<Project>(res, "project");
    },
    async getProject(idOrPath) {
      const res = await client.get<unknown>("projects", idOrPath);
      return res ? unwrap<Project>(res, "project") : null;
    },
    async listProjects() {
      const { items } = await client.list<Project>("projects");
      return items;
    },
    async saveFeedback(input) {
      await client.create<unknown>("feedback", input);
    },
  };
}

function recordingPageFingerprint(items: Recording[]): string {
  const hash = createHash("sha256");
  const ids = items.map((item) => String(item.id ?? "")).sort();
  for (const id of ids) {
    hash.update(String(id.length));
    hash.update(":");
    hash.update(id);
    hash.update(";");
  }
  return `${items.length}:${hash.digest("hex")}`;
}

export async function countStoreRecordings(
  store: Store,
  filter?: RecordingFilter,
): Promise<number> {
  if (store.countRecordings) return store.countRecordings(filter);

  const pageLimit = 500;
  const maxPageRequests = 10_000;
  const { limit: _limit, offset: _offset, ...unpaginated } = filter ?? {};
  const seenPageKeys = new Set<string>();
  let offset = 0;

  for (let pageRequests = 0; pageRequests < maxPageRequests; pageRequests += 1) {
    const items = await store.listRecordings({
      ...unpaginated,
      limit: pageLimit,
      offset,
    });
    if (items.length === 0) return offset;

    const pageKey = recordingPageFingerprint(items);
    if (seenPageKeys.has(pageKey)) {
      throw new Error("Legacy Store ignored pagination while counting recordings");
    }
    seenPageKeys.add(pageKey);
    offset += items.length;
  }

  throw new Error(`Legacy Store exceeded ${maxPageRequests} pages while counting recordings`);
}

let cached: Store | null = null;

/**
 * Resolve the active Store from the environment. Cached per-process after first
 * resolution against `process.env`; pass an explicit `env` (e.g. in tests) to
 * bypass the cache. Throws if the cloud transport is requested but misconfigured
 * (URL/key mismatch) so callers never silently read the wrong dataset.
 */
export function getStore(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Store {
  if (env === process.env && cached) return cached;
  const resolved = resolveStorageClient(APP, env);
  const store = resolved.transport === "cloud-http" ? apiStore(resolved.client) : localStore;
  if (env === process.env) cached = store;
  return store;
}

/** Test helper: clear the cached Store. */
export function __resetStore(): void {
  cached = null;
}
