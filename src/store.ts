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
  createRecording(input: CreateRecordingInput): Promise<Recording>;
  getRecording(id: string): Promise<Recording | null>;
  listRecordings(filter?: RecordingFilter): Promise<Recording[]>;
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

function listQuery(filter?: RecordingFilter): Record<string, string | number | undefined> {
  if (!filter) return {};
  return {
    agent_id: filter.agent_id,
    project_id: filter.project_id,
    session_id: filter.session_id,
    processing_mode: filter.processing_mode,
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
  async createRecording(input) {
    return recordingsDb.createRecording(input);
  },
  async getRecording(id) {
    return recordingsDb.getRecording(id);
  },
  async listRecordings(filter) {
    return recordingsDb.listRecordings(filter);
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
    async createRecording(input) {
      const res = await client.create<unknown>("recordings", input);
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
        if (error && typeof error === "object" && (error as { status?: number }).status === 404) return null;
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
