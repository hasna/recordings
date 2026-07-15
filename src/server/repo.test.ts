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
  const idempotencyRows: Row[] = [];
  const advisoryLockRefs: string[] = [];
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
        idempotencyRows: idempotencyRows.map((row) => ({ ...row })),
      };
      try {
        return await operation(pg);
      } catch (error) {
        agents.splice(0, agents.length, ...snapshots.agents);
        projects.splice(0, projects.length, ...snapshots.projects);
        recordings.splice(0, recordings.length, ...snapshots.recordings);
        recordingTags.splice(0, recordingTags.length, ...snapshots.recordingTags);
        idempotencyRows.splice(0, idempotencyRows.length, ...snapshots.idempotencyRows);
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
      } else if (/^\s*insert\s+into\s+recording_idempotency/i.test(sql)) {
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
      } else if (/^\s*delete\s+from\s+recordings/i.test(sql)) {
        const index = recordings.findIndex((recording) => recording["id"] === params[0]);
        if (index === -1) return { changes: 0 };
        recordings.splice(index, 1);
        // Match the production FK: deletion keeps the principal/key/fingerprint
        // binding while clearing only the now-absent result reference.
        for (const row of idempotencyRows) {
          if (row["recording_id"] === params[0]) row["recording_id"] = null;
        }
      }
      return { changes: 1 };
    },
    async get(sql: string, ...params: unknown[]) {
      const ref = params[0] as string;
      if (/pg_advisory_xact_lock/i.test(sql)) {
        advisoryLockRefs.push(ref);
        return null;
      }
      if (/from\s+recording_idempotency/i.test(sql)) {
        return idempotencyRows.find((row) =>
          row["principal"] === params[0] && row["idempotency_key"] === params[1]
        ) ?? null;
      }
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
    idempotencyRows,
    advisoryLockRefs,
  };
  return pg as unknown as PgAdapterAsync & {
    agents: Row[];
    projects: Row[];
    recordings: Row[];
    recordingTags: Row[];
    idempotencyRows: Row[];
    advisoryLockRefs: string[];
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
    }, undefined, { principal: "recordings:writer-a" });
    const retry = await repo.createRecording(pg, {
      id: "pipeline-ambiguous-save",
      raw_text: "settled realtime text",
    }, undefined, { principal: "recordings:writer-a" });

    expect(first.id).toBe("pipeline-ambiguous-save");
    expect(retry.raw_text).toBe("settled realtime text");
    expect(pg.recordings).toHaveLength(1);
    expect(pg.advisoryLockRefs).toEqual([
      '["recordings:writer-a","pipeline-ambiguous-save"]',
      '["recordings:writer-a","pipeline-ambiguous-save"]',
    ]);
  });

  test("an idempotency key without an input id creates one stable Postgres row", async () => {
    const pg = makeFakePg();
    const first = await repo.createRecording(pg, {
      raw_text: "settled realtime text",
    }, "logical-save-a", { principal: "recordings:writer-a" });
    const retry = await repo.createRecording(pg, {
      raw_text: "settled realtime text",
    }, "logical-save-a", { principal: "recordings:writer-a" });

    expect(first.id).not.toBe("logical-save-a");
    expect(retry.id).toBe(first.id);
    expect(retry.raw_text).toBe("settled realtime text");
    expect(pg.recordings).toHaveLength(1);
    expect(pg.advisoryLockRefs).toEqual([
      '["recordings:writer-a","logical-save-a"]',
      '["recordings:writer-a","logical-save-a"]',
    ]);
  });

  test("an idempotency result cannot be replayed by a different authenticated principal", async () => {
    const pg = makeFakePg();
    await repo.createRecording(pg, {
      raw_text: "principal A private transcript",
    }, "shared-logical-key", { principal: "recordings:writer-a" });

    const second = await repo.createRecording(pg, {
      raw_text: "principal B request",
    }, "shared-logical-key", { principal: "recordings:writer-b" });
    expect(second.raw_text).toBe("principal B request");
    expect(second.id).not.toBe(pg.recordings[0]!["id"]);
    expect(pg.recordings).toHaveLength(2);
  });

  test("an idempotency key cannot be rebound to a changed request fingerprint", async () => {
    const pg = makeFakePg();
    await repo.createRecording(pg, {
      raw_text: "first request body",
    }, "changed-request-key", { principal: "recordings:writer-a" });

    await expect(repo.createRecording(pg, {
      raw_text: "different request body",
    }, "changed-request-key", { principal: "recordings:writer-a" })).rejects.toThrow(
      "idempotency key is already in use",
    );
    expect(pg.recordings).toHaveLength(1);
  });

  test("deleting a recording preserves a tombstone that rejects an exact delayed retry", async () => {
    const pg = makeFakePg();
    const first = await repo.createRecording(pg, {
      raw_text: "completed request",
    }, "deleted-request-key", { principal: "recordings:writer-a" });

    expect(await repo.deleteRecording(pg, first.id)).toBeTrue();
    await expect(repo.createRecording(pg, {
      raw_text: "completed request",
    }, "deleted-request-key", { principal: "recordings:writer-a" })).rejects.toThrow(
      "idempotency key is already in use",
    );
    expect(pg.recordings).toHaveLength(0);
    expect(pg.idempotencyRows).toEqual([
      expect.objectContaining({
        principal: "recordings:writer-a",
        idempotency_key: "deleted-request-key",
        recording_id: null,
      }),
    ]);
  });

  test("deleting a recording does not let the same principal rebind the key to a changed body", async () => {
    const pg = makeFakePg();
    const first = await repo.createRecording(pg, {
      raw_text: "first request body",
    }, "deleted-changed-key", { principal: "recordings:writer-a" });

    expect(await repo.deleteRecording(pg, first.id)).toBeTrue();
    await expect(repo.createRecording(pg, {
      raw_text: "different request body",
    }, "deleted-changed-key", { principal: "recordings:writer-a" })).rejects.toThrow(
      "idempotency key is already in use",
    );
    expect(pg.recordings).toHaveLength(0);
  });

  test("canonical metadata key order does not break an exact retry", async () => {
    const pg = makeFakePg();
    const first = await repo.createRecording(pg, {
      raw_text: "same request",
      metadata: { z: 2, a: 1 },
    }, "canonical-request-key", { principal: "recordings:writer-a" });
    const retry = await repo.createRecording(pg, {
      metadata: { a: 1, z: 2 },
      raw_text: "same request",
    }, "canonical-request-key", { principal: "recordings:writer-a" });

    expect(retry.id).toBe(first.id);
    expect(pg.recordings).toHaveLength(1);
  });

  test("a null body id lets a nonempty key define the Postgres identity", async () => {
    const pg = makeFakePg();
    const recording = await repo.createRecording(
      pg,
      JSON.parse('{"id":null,"raw_text":"settled realtime text"}'),
      "logical-save-null",
      { principal: "recordings:writer-a" },
    );

    expect(recording.id).not.toBe("logical-save-null");
    expect(pg.recordings).toHaveLength(1);
    expect(pg.advisoryLockRefs).toEqual(['["recordings:writer-a","logical-save-null"]']);
  });

  test("a conflicting explicit id and idempotency key fail before a Postgres write", async () => {
    const pg = makeFakePg();
    await expect(repo.createRecording(pg, {
      id: "recording-a",
      raw_text: "must not persist",
    }, "logical-save-b")).rejects.toThrow("recording id conflicts with idempotency key");
    expect(pg.recordings).toHaveLength(0);
  });

  test("invalid runtime ids and keys fail before a Postgres transaction", async () => {
    const pg = makeFakePg();
    const invalidInputs = [
      [JSON.parse('{"id":"","raw_text":"must not persist"}'), "recording id must not be empty"],
      [JSON.parse('{"id":17,"raw_text":"must not persist"}'), "recording id must be a string"],
      [JSON.parse('{"id":"bad\\u0000id","raw_text":"must not persist"}'), "recording id must not contain control characters"],
    ] as const;
    for (const [input, message] of invalidInputs) {
      await expect(Reflect.apply(repo.createRecording, repo, [pg, input])).rejects.toThrow(message);
    }
    const invalidKeys: ReadonlyArray<readonly [unknown, string]> = [
      ["", "idempotency key must not be empty"],
      [null, "idempotency key must be a string"],
      [17, "idempotency key must be a string"],
      ["bad\u0000key", "idempotency key must not contain control characters"],
      ["logical-save-\u00e9", "idempotency key must contain only printable ASCII characters"],
      ["x".repeat(256), "idempotency key must not exceed 255 characters"],
    ];
    for (const [key, message] of invalidKeys) {
      await expect(Reflect.apply(repo.createRecording, repo, [
        pg,
        { raw_text: "must not persist" },
        key,
      ])).rejects.toThrow(message);
    }
    expect(pg.recordings).toHaveLength(0);
    expect(pg.advisoryLockRefs).toHaveLength(0);
  });

  test("concurrent exact same-id retries observe one committed result", async () => {
    const pg = makeFakePg();
    const [winner, retry] = await Promise.all([
      repo.createRecording(pg, {
        id: "pipeline-concurrent-save",
        raw_text: "settled realtime text",
        tags: ["winner"],
      }, undefined, { principal: "recordings:writer-a" }),
      repo.createRecording(pg, {
        id: "pipeline-concurrent-save",
        raw_text: "settled realtime text",
        tags: ["winner"],
      }, undefined, { principal: "recordings:writer-a" }),
    ]);

    expect(retry.id).toBe(winner.id);
    expect(retry.raw_text).toBe("settled realtime text");
    expect(pg.recordings).toHaveLength(1);
    expect(pg.recordingTags).toEqual([
      { recording_id: "pipeline-concurrent-save", tag: "winner" },
    ]);
    expect(pg.agents).toHaveLength(0);
    expect(pg.advisoryLockRefs).toEqual([
      '["recordings:writer-a","pipeline-concurrent-save"]',
      '["recordings:writer-a","pipeline-concurrent-save"]',
    ]);
  });

  test("recording and normalized tags roll back together", async () => {
    const pg = makeFakePg();
    await expect(repo.createRecording(pg, {
      id: "pipeline-atomic-save",
      raw_text: "atomic",
      tags: ["winner", "reject-me"],
    }, undefined, { principal: "recordings:writer-a" })).rejects.toThrow("synthetic tag insert failure");

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
