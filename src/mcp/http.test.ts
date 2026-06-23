import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildServer } from "./index.js";
import { handleMcpRequest, resolveMcpHttpPort, DEFAULT_MCP_HTTP_PORT } from "./http.js";

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
        transcriber_model: string;
        post_processing_mode: string;
        transcription_prompt_configured: boolean;
        transcriber_prompt_configured: boolean;
        openai_api_key_configured: boolean;
      };
      stats: { total: number };
    };
    expect(status.service).toBe("recordings");
    expect(status.mcp.default_http_port).toBe(8873);
    expect(status.mcp.endpoint).toBe("/mcp");
    expect(status.config.transcription_model).toBe("gpt-4o-transcribe");
    expect(status.config.transcriber_model).toBe("gpt-4o");
    expect(status.config.post_processing_mode).toBe("auto");
    expect(typeof status.config.transcription_prompt_configured).toBe("boolean");
    expect(typeof status.config.transcriber_prompt_configured).toBe("boolean");
    expect(typeof status.config.openai_api_key_configured).toBe("boolean");
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
});

describe("recordings buildServer", () => {
  test("registers tools for stdio and HTTP modes", () => {
    expect(buildServer()).toBeDefined();
  });
});
