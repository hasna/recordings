import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const DEFAULT_MCP_HTTP_PORT = 8873;
export const MCP_HTTP_HOST = "127.0.0.1";

export function isHttpMode(args: string[]): boolean {
  return args.includes("--http") || process.env.MCP_HTTP === "1";
}

export function isStdioMode(args: string[]): boolean {
  return args.includes("--stdio") || process.env.MCP_STDIO === "1";
}

export function resolveMcpHttpPort(args: string[]): number {
  const portIdx = args.indexOf("--port");
  if (portIdx >= 0 && args[portIdx + 1]) {
    return Number(args[portIdx + 1]);
  }
  const envPort = process.env.MCP_HTTP_PORT;
  if (envPort) return Number(envPort);
  return DEFAULT_MCP_HTTP_PORT;
}

export async function handleMcpRequest(
  req: Request,
  buildServer: () => McpServer,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = buildServer();
  await server.connect(transport);
  return transport.handleRequest(req);
}

export function startMcpHttpServer(options: {
  name: string;
  port: number;
  buildServer: () => McpServer;
}): ReturnType<typeof Bun.serve> {
  const { name, port, buildServer } = options;

  const server = Bun.serve({
    hostname: MCP_HTTP_HOST,
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health" && req.method === "GET") {
        return Response.json({ status: "ok", name });
      }
      if (url.pathname === "/mcp") {
        return handleMcpRequest(req, buildServer);
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  console.error(`${name}-mcp HTTP listening on http://${MCP_HTTP_HOST}:${port}/mcp`);
  return server;
}
