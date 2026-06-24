import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAdapter } from "../db/database.js";
import {
  getStorageStatus,
  parseStorageTables,
  pullStorageChanges,
  pushStorageChanges,
  syncStorageChanges,
} from "../db/storage-sync.js";

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function plainText(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function errorText(error: unknown) {
  return {
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export function registerRecordingsStorageTools(server: McpServer): void {
  server.tool(
    "recordings_storage_status",
    "Show compact recordings local database and storage sync status",
    {
      verbose: z.boolean().optional().describe("Return full JSON storage status"),
    },
    async ({ verbose }) => {
      try {
        const status = getStorageStatus();
        if (verbose) return text(status);
        const totalRows = status.tables.reduce((sum, table) => sum + table.rows, 0);
        const tables = status.tables.map((table) => `${table.table}:${table.rows}`).join(", ");
        return plainText(
          `Storage: ${status.mode} (${status.enabled ? "enabled" : "local only"}) | tables: ${status.tables.length} | rows: ${totalRows}\n` +
          `Tables: ${tables}\n` +
          "Use verbose=true for db path and full status JSON."
        );
      } catch (error) {
        return errorText(error);
      }
    }
  );

  server.tool(
    "recordings_storage_push",
    "Push local recordings data to PostgreSQL",
    {
      tables: z.string().optional().describe("Comma-separated table names"),
    },
    async ({ tables }) => {
      try {
        return text(await pushStorageChanges(parseStorageTables(tables)));
      } catch (error) {
        return errorText(error);
      }
    }
  );

  server.tool(
    "recordings_storage_pull",
    "Pull PostgreSQL recordings data into the local database",
    {
      tables: z.string().optional().describe("Comma-separated table names"),
    },
    async ({ tables }) => {
      try {
        return text(await pullStorageChanges(parseStorageTables(tables)));
      } catch (error) {
        return errorText(error);
      }
    }
  );

  server.tool(
    "recordings_storage_sync",
    "Push local changes, then pull remote changes",
    {
      tables: z.string().optional().describe("Comma-separated table names"),
    },
    async ({ tables }) => {
      try {
        return text(await syncStorageChanges(parseStorageTables(tables)));
      } catch (error) {
        return errorText(error);
      }
    }
  );

  server.tool(
    "recordings_storage_feedback",
    "Save feedback for recordings",
    {
      message: z.string(),
      email: z.string().optional(),
      category: z.enum(["bug", "feature", "general"]).optional(),
    },
    async ({ message, email, category }) => {
      try {
        const adapter = getAdapter();
        adapter.run(
          "INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)",
          message,
          email || null,
          category || "general",
          "recordings"
        );
        return text({ saved: true });
      } catch (error) {
        return errorText(error);
      }
    }
  );
}
