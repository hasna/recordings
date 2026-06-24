import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildServer } from "./index.js";
import { handleMcpRequest, resolveMcpHttpPort, DEFAULT_MCP_HTTP_PORT } from "./http.js";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import { createRecording } from "../db/recordings.js";
import { registerAgent } from "../db/agents.js";
import { registerProject } from "../db/projects.js";

describe("recordings MCP HTTP transport", () => {
  let httpServer: ReturnType<typeof Bun.serve>;
  let port: number;

  beforeAll(() => {
    httpServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/health" && req.method === "GET") {
          return Response.json({ status: "ok", name: "recordings" });
        }
        if (url.pathname === "/mcp") {
          return handleMcpRequest(req, buildServer);
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    port = httpServer.port!;
  });

  afterAll(() => {
    httpServer.stop();
  });

  test("default port is 8873", () => {
    expect(DEFAULT_MCP_HTTP_PORT).toBe(8873);
    expect(resolveMcpHttpPort([])).toBe(8873);
  });

  test("GET /health returns 200", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", name: "recordings" });
  });

  test("MCP initialize + recording_stats over Streamable HTTP", async () => {
    const client = new Client({ name: "recordings-http-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );
    await client.connect(transport);
    const result = await client.callTool({ name: "recording_stats", arguments: {} });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string }> | undefined;
    expect(content?.[0]?.type).toBe("text");
    await client.close();
  });

  test("recordings_status exposes safe agent diagnostics", async () => {
    const client = new Client({ name: "recordings-http-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );
    await client.connect(transport);
    const result = await client.callTool({ name: "recordings_status", arguments: {} });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text?: string }> | undefined;
    expect(content?.[0]?.type).toBe("text");
    const status = JSON.parse(content?.[0]?.text ?? "{}") as {
      service: string;
      version: string;
      mcp: { default_http_port: number; endpoint: string };
      config: {
        transcription_model: string;
        realtime_session_model: string;
        realtime_transcription_model: string;
        transcriber_model: string;
        post_processing_mode: string;
        transcription_prompt_configured: boolean;
        transcriber_prompt_configured: boolean;
        config_warnings: string[];
        openai_api_key_configured: boolean;
      };
      stats: { total: number };
    };
    expect(status.service).toBe("recordings");
    expect(status.mcp.default_http_port).toBe(8873);
    expect(status.mcp.endpoint).toBe("/mcp");
    expect(status.config.transcription_model).toBe("gpt-4o-transcribe");
    expect(status.config.realtime_session_model).toBe("gpt-realtime");
    expect(status.config.realtime_transcription_model).toBe("gpt-realtime-whisper");
    expect(status.config.transcriber_model).toBe("gpt-4o");
    expect(status.config.post_processing_mode).toBe("auto");
    expect(typeof status.config.transcription_prompt_configured).toBe("boolean");
    expect(typeof status.config.transcriber_prompt_configured).toBe("boolean");
    expect(typeof status.config.openai_api_key_configured).toBe("boolean");
    expect(Array.isArray(status.config.config_warnings)).toBe(true);
    expect(typeof status.stats.total).toBe("number");
    expect(content?.[0]?.text).not.toContain("sk-");
    await client.close();
  });

  test("recordings_status reloads runtime model config without restarting server", async () => {
    const previousModel = process.env.RECORDINGS_MODEL;
    process.env.RECORDINGS_MODEL = "whisper-1";
    const client = new Client({ name: "recordings-http-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );

    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "recordings_status", arguments: {} });
      const content = result.content as Array<{ type: string; text?: string }> | undefined;
      const status = JSON.parse(content?.[0]?.text ?? "{}") as {
        config: { transcription_model: string };
      };
      expect(status.config.transcription_model).toBe("whisper-1");
    } finally {
      await client.close();
      if (previousModel === undefined) {
        delete process.env.RECORDINGS_MODEL;
      } else {
        process.env.RECORDINGS_MODEL = previousModel;
      }
    }
  });

  test("describe_tool documents separated transcription and transcriber prompts", async () => {
    const client = new Client({ name: "recordings-http-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );
    await client.connect(transport);
    const result = await client.callTool({
      name: "describe_tool",
      arguments: { name: "transcribe_audio" },
    });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text?: string }> | undefined;
    expect(content?.[0]?.text).toContain("transcription_prompt");
    expect(content?.[0]?.text).toContain("STT vocabulary/context only");
    expect(content?.[0]?.text).toContain("transcriber_prompt");
    expect(content?.[0]?.text).toContain("post_processing_mode");
    await client.close();
  });

  test("MCP list/search stay bounded even with full=true", async () => {
    const tempDir = join(tmpdir(), `open-recordings-mcp-compact-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    resetDatabase();
    getDatabase(join(tempDir, "recordings.db"));
    const longText = `First compact transcript ${"middle words ".repeat(40)}hidden-tail-token`;
    const created = createRecording({ raw_text: longText, model_used: "model-compact" });
    const client = new Client({ name: "recordings-http-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );

    try {
      await client.connect(transport);
      const listResult = await client.callTool({
        name: "list_recordings",
        arguments: { full: true, limit: 10 },
      });
      expect(listResult.isError).not.toBe(true);
      const listContent = listResult.content as Array<{ type: string; text?: string }> | undefined;
      const listText = listContent?.[0]?.text ?? "";
      expect(listText).toContain("recordings: showing 1 of 1");
      expect(listText).toContain("Preview:");
      expect(listText).toContain(`get_recording { "id": "${created.id.slice(0, 8)}" }`);
      expect(listText).not.toContain("hidden-tail-token");

      const searchResult = await client.callTool({
        name: "search_recordings",
        arguments: { query: "compact transcript", full: true, limit: 10 },
      });
      const searchContent = searchResult.content as Array<{ type: string; text?: string }> | undefined;
      const searchText = searchContent?.[0]?.text ?? "";
      expect(searchResult.isError).not.toBe(true);
      expect(searchText).toContain("results: showing 1 of 1");
      expect(searchText).not.toContain("hidden-tail-token");

      const detailResult = await client.callTool({
        name: "get_recording",
        arguments: { id: created.id.slice(0, 8) },
      });
      const detailContent = detailResult.content as Array<{ type: string; text?: string }> | undefined;
      expect(detailResult.isError).not.toBe(true);
      expect(detailContent?.[0]?.text).toContain("hidden-tail-token");
    } finally {
      await client.close();
      closeDatabase();
      resetDatabase();
      if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("MCP agents/projects/stats outputs are capped by default", async () => {
    const tempDir = join(tmpdir(), `open-recordings-mcp-caps-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    resetDatabase();
    getDatabase(join(tempDir, "recordings.db"));
    for (let i = 0; i < 55; i += 1) {
      registerAgent(`agent-${i}`, "review fixture", "agent");
      registerProject(`project-${i}`, join(tempDir, `project-${i}`), "review fixture");
    }
    for (let i = 0; i < 12; i += 1) {
      createRecording({ raw_text: `stats ${i}`, model_used: `model-${i}` });
    }
    const client = new Client({ name: "recordings-http-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );

    try {
      await client.connect(transport);
      const agentsResult = await client.callTool({
        name: "list_agents",
        arguments: { limit: 100 },
      });
      const agentsText = ((agentsResult.content as Array<{ text?: string }> | undefined)?.[0]?.text) ?? "";
      expect(agentsText).toContain("agents: showing 50 of 55");
      expect(agentsText).toContain("next cursor: 50");
      expect(agentsText).toContain("limit capped at 50");

      const projectsResult = await client.callTool({
        name: "list_projects",
        arguments: { limit: 100 },
      });
      const projectsText = ((projectsResult.content as Array<{ text?: string }> | undefined)?.[0]?.text) ?? "";
      expect(projectsText).toContain("projects: showing 50 of 55");
      expect(projectsText).toContain("next cursor: 50");
      expect(projectsText).toContain("limit capped at 50");

      const statsResult = await client.callTool({ name: "recording_stats", arguments: {} });
      const statsText = ((statsResult.content as Array<{ text?: string }> | undefined)?.[0]?.text) ?? "";
      expect(statsText).toContain("Total: 12");
      expect(statsText).toContain("Hints: 2 more model(s)");
    } finally {
      await client.close();
      closeDatabase();
      resetDatabase();
      if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("recordings buildServer", () => {
  test("registers tools for stdio and HTTP modes", () => {
    expect(buildServer()).toBeDefined();
  });
});
