import { describe, expect, test } from "bun:test";
import { removeCodexServerBlock, upsertCodexStdioBlock } from "../cli/mcp-config.js";

const STDIO_BLOCK = `[mcp_servers.recordings]
command = "recordings-mcp"
args = ["--stdio"]
`;

const HTTP_BLOCK = `[mcp_servers.recordings]
url = "https://recordings.hasna.xyz/mcp"
[mcp_servers.recordings.env]
HASNA_RECORDINGS_API_KEY = "x"
`;

const OTHER = `[mcp_servers.other]
command = "other-mcp"
args = []
`;

describe("removeCodexServerBlock", () => {
  test("removes a stdio-form recordings block (the form the CLI installs)", () => {
    const { content, removed } = removeCodexServerBlock(`${OTHER}\n${STDIO_BLOCK}`, "recordings");
    expect(removed).toBe(true);
    expect(content).not.toContain("[mcp_servers.recordings]");
    expect(content).toContain("[mcp_servers.other]");
  });

  test("removes an http-transport recordings block + its subtable (the bug)", () => {
    const { content, removed } = removeCodexServerBlock(`${OTHER}\n${HTTP_BLOCK}`, "recordings");
    expect(removed).toBe(true);
    expect(content).not.toContain("[mcp_servers.recordings]");
    expect(content).not.toContain("recordings.hasna.xyz");
    expect(content).not.toContain("[mcp_servers.recordings.env]");
    expect(content).not.toContain("HASNA_RECORDINGS_API_KEY");
    // Sibling server is untouched.
    expect(content).toContain("[mcp_servers.other]");
    expect(content).toContain("other-mcp");
  });

  test("reports removed=false when no recordings block exists", () => {
    const { content, removed } = removeCodexServerBlock(OTHER, "recordings");
    expect(removed).toBe(false);
    expect(content).toContain("[mcp_servers.other]");
  });
});

describe("upsertCodexStdioBlock", () => {
  test("adds a stdio block to a config that lacks one", () => {
    const next = upsertCodexStdioBlock(OTHER, "recordings", "recordings-mcp");
    expect(next).toContain(`[mcp_servers.recordings]\ncommand = "recordings-mcp"\nargs = ["--stdio"]`);
    expect(next).toContain("[mcp_servers.other]");
  });

  test("replaces a pre-existing http block instead of no-oping (authoritative)", () => {
    const next = upsertCodexStdioBlock(HTTP_BLOCK, "recordings", "recordings-mcp");
    expect(next).not.toContain("recordings.hasna.xyz");
    expect(next).not.toContain("[mcp_servers.recordings.env]");
    expect(next).toContain(`command = "recordings-mcp"`);
    // Exactly one recordings table header remains.
    expect(next.match(/^\[mcp_servers\.recordings\]$/gm)?.length).toBe(1);
  });

  test("install -> uninstall round-trips back to the original", () => {
    const installed = upsertCodexStdioBlock(OTHER, "recordings", "recordings-mcp");
    const { content } = removeCodexServerBlock(installed, "recordings");
    expect(content.trimEnd()).toBe(OTHER.trimEnd());
  });
});
