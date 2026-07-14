/**
 * Pure helpers for editing an agent's MCP server config.
 *
 * Codex stores MCP servers as TOML tables (`[mcp_servers.<name>]`). A server
 * block can be written in several transport forms — stdio (`command`/`args`)
 * or streamable-HTTP (`url`/`http`, optional `headers`/`env` subtables). The
 * uninstall/upsert logic must treat the whole table (and any of its subtables)
 * as one unit regardless of which keys it holds, instead of matching one
 * hand-written key layout. These functions are exported so the round-trip is
 * unit-tested without touching the real `~/.codex/config.toml`.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True for any TOML table/array-of-tables header line (`[x]` or `[[x]]`). */
function isTableHeader(line: string): boolean {
  return /^\s*\[/.test(line);
}

/**
 * Remove the `[mcp_servers.<name>]` table AND any of its subtables
 * (`[mcp_servers.<name>.env]`, `.headers`, …) with their bodies — whatever the
 * transport form. A block runs from its header until the next table header or
 * end of file. Returns the rewritten content and whether anything was removed.
 */
export function removeCodexServerBlock(
  content: string,
  name: string,
): { content: string; removed: boolean } {
  const headerRe = new RegExp(
    `^\\s*\\[mcp_servers\\.${escapeRegExp(name)}(\\..+)?\\]\\s*$`,
  );
  const lines = content.split("\n");
  const out: string[] = [];
  let skipping = false;
  let removed = false;

  for (const line of lines) {
    if (isTableHeader(line)) {
      // A new header decides whether we start (or stop) skipping.
      skipping = headerRe.test(line);
      if (skipping) {
        removed = true;
        continue;
      }
    }
    if (skipping) continue;
    out.push(line);
  }

  // Collapse the blank-line gap the removed block left behind.
  const normalized = out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "");
  return { content: normalized, removed };
}

/**
 * Ensure exactly one stdio `[mcp_servers.<name>]` block exists, pointing at
 * `mcpCmd`. Any pre-existing block (in any transport form) is replaced, so the
 * install is authoritative and idempotent rather than a silent no-op.
 */
export function upsertCodexStdioBlock(
  content: string,
  name: string,
  mcpCmd: string,
): string {
  const { content: cleaned } = removeCodexServerBlock(content, name);
  const trimmed = cleaned.replace(/\s+$/, "");
  const block = `[mcp_servers.${name}]\ncommand = "${mcpCmd}"\nargs = ["--stdio"]\n`;
  return trimmed.length > 0 ? `${trimmed}\n\n${block}` : block;
}
