import { describe, expect, test } from "bun:test";
import * as repo from "./repo.js";
import type { PgAdapterAsync } from "../db/remote-storage.js";

/**
 * Regression guard for the live-flip failure: POST /v1/recordings 500'd on ANY
 * agent_id that was not already an existing agent id (a name, or even a random
 * UUID) because the raw value was inserted straight into recordings.agent_id and
 * tripped the Postgres foreign key. createRecording must now resolve/register the
 * agent and resolve the project BEFORE the insert so the FK never fires.
 */

interface Row {
  [k: string]: unknown;
}

/** Minimal in-memory Postgres fake with real agents/projects/recordings tables. */
function makeFakePg() {
  const agents: Row[] = [];
  const projects: Row[] = [];
  const recordings: Row[] = [];
  const recordingTags: Row[] = [];
  let seq = 0;
  let transactionTail = Promise.resolve();

  const pg: Record<string, unknown> & {
    run: (sql: string, ...params: unknown[]) => Promise<{ changes: number }>;
    get: (sql: string, ...params: unknown[]) => Promise<unknown>;
  } = {
    async transaction<T>(operation: (transaction: unknown) => Promise<T>) {
      const previous = transactionTail;
      let release = () => {};
      transactionTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const snapshots = {
        agents: agents.map((row) => ({ ...row })),
        projects: projects.map((row) => ({ ...row })),
        recordings: recordings.map((row) => ({ ...row })),
        recordingTags: recordingTags.map((row) => ({ ...row })),
      };
      try {
        return await operation(pg);
      } catch (error) {
        agents.splice(0, agents.length, ...snapshots.agents);
        projects.splice(0, projects.length, ...snapshots.projects);
        recordings.splice(0, recordings.length, ...snapshots.recordings);
        recordingTags.splice(0, recordingTags.length, ...snapshots.recordingTags);
        throw error;
      } finally {
        release();
      }
    },
    async run(sql: string, ...params: unknown[]) {
      if (/^\s*insert\s+into\s+agents/i.test(sql)) {
        agents.push({ id: params[0], name: params[1], role: params[3] ?? "agent" });
      } else if (/^\s*insert\s+into\s+projects/i.test(sql)) {
        projects.push({ id: params[0], name: params[1], path: params[2] });
      } else if (/^\s*insert\s+into\s+recording_tags/i.test(sql)) {
        if (params[1] === "reject-me") throw new Error("synthetic tag insert failure");
        recordingTags.push({ recording_id: params[0], tag: params[1] });
      } else if (/^\s*insert\s+into\s+recordings/i.test(sql)) {
        // Enforce the FK the same way Postgres would: reject a dangling agent_id.
        const agentId = params[10];
        const projectId = params[11];
        if (agentId != null && !agents.some((a) => a["id"] === agentId)) {
          throw new Error(`insert or update on table "recordings" violates foreign key constraint "recordings_agent_id_fkey"`);
        }
        if (projectId != null && !projects.some((p) => p["id"] === projectId)) {
          throw new Error(`violates foreign key constraint "recordings_project_id_fkey"`);
        }
        if (/on\s+conflict\s*\(id\)\s+do\s+nothing/i.test(sql)
          && recordings.some((recording) => recording["id"] === params[0])) {
          return { changes: 0 };
        }
        recordings.push({
          id: params[0],
          raw_text: params[2],
          agent_id: agentId,
          project_id: projectId,
          created_at: new Date().toISOString(),
        });
      }
      return { changes: 1 };
    },
    async get(sql: string, ...params: unknown[]) {
      const ref = params[0] as string;
      if (/from\s+agents/i.test(sql)) {
        if (/where\s+id\s*=/i.test(sql)) return agents.find((a) => a["id"] === ref) ?? null;
        if (/where\s+name\s*=/i.test(sql)) return agents.find((a) => a["name"] === ref) ?? null;
        if (/like/i.test(sql)) return agents.find((a) => String(a["id"]).startsWith(ref)) ?? null;
      }
      if (/from\s+projects/i.test(sql)) {
        if (/where\s+id\s*=/i.test(sql)) return projects.find((p) => p["id"] === ref) ?? null;
        if (/where\s+path\s*=/i.test(sql)) return projects.find((p) => p["path"] === ref) ?? null;
        if (/where\s+name\s*=/i.test(sql)) return projects.find((p) => p["name"] === ref) ?? null;
        if (/like/i.test(sql)) return projects.find((p) => String(p["id"]).startsWith(ref)) ?? null;
      }
      if (/from\s+recordings/i.test(sql)) {
        if (/like/i.test(sql)) return recordings.find((r) => String(r["id"]).startsWith(ref)) ?? null;
        return recordings.find((r) => r["id"] === ref) ?? null;
      }
      return null;
    },
    async all() {
      return [];
    },
    async exec() {},
    // deterministic-ish id helper isn't needed; repo uses crypto.randomUUID
    _seq: () => seq++,
    agents,
    projects,
    recordings,
    recordingTags,
  };
  return pg as unknown as PgAdapterAsync & {
    agents: Row[];
    projects: Row[];
    recordings: Row[];
    recordingTags: Row[];
  };
}

describe("repo.createRecording reference resolution", () => {
  test("registers a first-time agent NAME and links the recording (no FK 500)", async () => {
    const pg = makeFakePg();
    const rec = await repo.createRecording(pg, {
      raw_text: "live check",
      agent_id: "zzlivecheck-mcp-agent2",
    });
    // Agent auto-registered exactly once, and the recording links to its real id.
    expect(pg.agents.length).toBe(1);
    expect(pg.agents[0]!["name"]).toBe("zzlivecheck-mcp-agent2");
    expect(rec.agent_id).toBe(pg.agents[0]!["id"]);
  });

  test("resolves an existing agent id/name to the real PK", async () => {
    const pg = makeFakePg();
    const agent = await repo.registerAgent(pg, "existing-agent");
    const rec = await repo.createRecording(pg, {
      raw_text: "x",
      agent_id: "existing-agent",
    });
    expect(pg.agents.length).toBe(1); // not re-registered
    expect(rec.agent_id).toBe(agent.id);
  });

  test("saves cleanly with no agent_id", async () => {
    const pg = makeFakePg();
    const rec = await repo.createRecording(pg, { raw_text: "x" });
    expect(rec.agent_id).toBeNull();
    expect(pg.agents.length).toBe(0);
  });

  test("a retried caller-owned recording id returns the first committed row", async () => {
    const pg = makeFakePg();
    const first = await repo.createRecording(pg, {
      id: "pipeline-ambiguous-save",
      raw_text: "settled realtime text",
    });
    const retry = await repo.createRecording(pg, {
      id: "pipeline-ambiguous-save",
      raw_text: "batch fallback transcript",
      project_id: "project-removed-after-first-commit",
    });

    expect(first.id).toBe("pipeline-ambiguous-save");
    expect(retry.raw_text).toBe("settled realtime text");
    expect(pg.recordings).toHaveLength(1);
  });

  test("concurrent same-id retry observes the winner before resolving changed refs", async () => {
    const pg = makeFakePg();
    const [winner, retry] = await Promise.all([
      repo.createRecording(pg, {
        id: "pipeline-concurrent-save",
        raw_text: "settled realtime text",
        tags: ["winner"],
      }),
      repo.createRecording(pg, {
        id: "pipeline-concurrent-save",
        raw_text: "batch fallback transcript",
        agent_id: "losing-agent",
        project_id: "project-removed-after-first-commit",
        tags: ["loser"],
      }),
    ]);

    expect(retry.id).toBe(winner.id);
    expect(retry.raw_text).toBe("settled realtime text");
    expect(pg.recordings).toHaveLength(1);
    expect(pg.recordingTags).toEqual([
      { recording_id: "pipeline-concurrent-save", tag: "winner" },
    ]);
    expect(pg.agents).toHaveLength(0);
  });

  test("recording and normalized tags roll back together", async () => {
    const pg = makeFakePg();
    await expect(repo.createRecording(pg, {
      id: "pipeline-atomic-save",
      raw_text: "atomic",
      tags: ["winner", "reject-me"],
    })).rejects.toThrow("synthetic tag insert failure");

    expect(pg.recordings).toHaveLength(0);
    expect(pg.recordingTags).toHaveLength(0);
  });

  test("unknown project ref fails as a clean ProjectNotFoundError (→400), not a 500", async () => {
    const pg = makeFakePg();
    await expect(
      repo.createRecording(pg, { raw_text: "x", project_id: "00000000-does-not-exist" }),
    ).rejects.toBeInstanceOf(repo.ProjectNotFoundError);
    expect(pg.recordings.length).toBe(0);
  });
});
