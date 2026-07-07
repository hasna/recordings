// Recordings storage backend resolver.
//
// This is the single seam the CLI and MCP go through for the recordings dataset.
// When the client-flip env resolves to cloud (mode=self_hosted + API_URL +
// API_KEY for `recordings`), ALL reads and writes are routed to the app's
// `<API_URL>/v1` HTTP API with the bearer key. Otherwise it delegates to the
// local store (bun:sqlite). Unset the env -> local, with no behavior change.

import type { Recording, CreateRecordingInput, RecordingFilter } from "../types/index.js";
import * as local from "../db/recordings.js";
import { resolveStorageClient, type StorageClient } from "./client.js";

const APP = "recordings";

export interface RecordingsBackend {
  readonly mode: "local" | "cloud-http";
  readonly baseUrl: string | null;
  createRecording(input: CreateRecordingInput): Promise<Recording>;
  getRecording(id: string): Promise<Recording | null>;
  listRecordings(filter?: RecordingFilter): Promise<Recording[]>;
  deleteRecording(id: string): Promise<boolean>;
  searchRecordings(query: string, filter?: RecordingFilter): Promise<Recording[]>;
  getRecordingStats(): Promise<{ total: number; raw: number; enhanced: number; total_duration_ms: number; by_model: Record<string, number> }>;
}

function listQuery(filter?: RecordingFilter): Record<string, string | number | undefined> {
  if (!filter) return {};
  return {
    agent_id: filter.agent_id,
    project_id: filter.project_id,
    session_id: filter.session_id,
    processing_mode: filter.processing_mode,
    search: filter.search,
    limit: filter.limit,
    offset: filter.offset,
  };
}

function cloudBackend(client: StorageClient): RecordingsBackend {
  return {
    mode: "cloud-http",
    baseUrl: client.baseUrl,
    async createRecording(input) {
      const res = await client.create<{ recording?: Recording } | Recording>("recordings", input);
      return ((res as { recording?: Recording }).recording ?? res) as Recording;
    },
    async getRecording(id) {
      const res = await client.get<{ recording?: Recording } | Recording>("recordings", id);
      if (!res) return null;
      return ((res as { recording?: Recording }).recording ?? res) as Recording;
    },
    async listRecordings(filter) {
      const { items } = await client.list<Recording>("recordings", listQuery(filter));
      return items;
    },
    async deleteRecording(id) {
      // Distinguish "not found" (false) from "deleted" (true) using the raw response.
      try {
        const res = await client.transport.del<{ deleted?: boolean }>(`/recordings/${encodeURIComponent(id)}`);
        return res?.deleted !== false;
      } catch (error) {
        if (error && typeof error === "object" && (error as { status?: number }).status === 404) return false;
        throw error;
      }
    },
    async searchRecordings(query, filter) {
      const { items } = await client.list<Recording>("recordings", listQuery({ ...(filter ?? {}), search: query }));
      return items;
    },
    async getRecordingStats() {
      const res = await client.transport.get<{ total?: number; raw?: number; enhanced?: number; total_duration_ms?: number; by_model?: Record<string, number> }>("/stats");
      return {
        total: res.total ?? 0,
        raw: res.raw ?? 0,
        enhanced: res.enhanced ?? 0,
        total_duration_ms: res.total_duration_ms ?? 0,
        by_model: res.by_model ?? {},
      };
    },
  };
}

const localBackend: RecordingsBackend = {
  mode: "local",
  baseUrl: null,
  async createRecording(input) {
    return local.createRecording(input);
  },
  async getRecording(id) {
    return local.getRecording(id);
  },
  async listRecordings(filter) {
    return local.listRecordings(filter);
  },
  async deleteRecording(id) {
    return local.deleteRecording(id);
  },
  async searchRecordings(query, filter) {
    return local.searchRecordings(query, filter);
  },
  async getRecordingStats() {
    return local.getRecordingStats();
  },
};

let cached: RecordingsBackend | null = null;

// Resolve the active recordings backend from the environment. Cached per-process
// after first resolution. Pass `env` explicitly in tests to bypass the cache.
export function resolveRecordingsBackend(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): RecordingsBackend {
  if (env === process.env && cached) return cached;
  const resolved = resolveStorageClient(APP, env);
  const backend = resolved.transport === "cloud-http" ? cloudBackend(resolved.client) : localBackend;
  if (env === process.env) cached = backend;
  return backend;
}

// Test helper: clear the cached backend.
export function __resetRecordingsBackend(): void {
  cached = null;
}
