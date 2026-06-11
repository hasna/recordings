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

function errorText(error: unknown) {
  return {
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export function registerRecordingsStorageTools(server: McpServer): void {
  server.tool(
    "recordings_storage_status",
    "Show recordings local database and storage sync status",
    {},
    async () => {
      try {
        return text(getStorageStatus());
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
