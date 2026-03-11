#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, ensureDataDir } from "../lib/config.js";
import { getDatabase } from "../db/database.js";
import {
  createRecording,
  getRecording,
  listRecordings,
  deleteRecording,
  searchRecordings,
  getRecordingStats,
} from "../db/recordings.js";
import { registerAgent, getAgent, listAgents } from "../db/agents.js";
import {
  registerProject,
  getProject,
  listProjects,
} from "../db/projects.js";
import { transcribeAudio, transcribeBuffer } from "../lib/transcriber.js";
import { processText, needsEnhancement } from "../lib/enhancer.js";
import type { Recording, RecordingFilter } from "../types/index.js";

// ── Initialize ──────────────────────────────────────────────────────────────

const config = loadConfig();
ensureDataDir(config);
getDatabase(config.db_path);

const server = new McpServer({
  name: "recordings",
  version: "0.0.2",
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function errorResult(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

/** Compact single-line format: id | mode | date | text preview */
function compact(r: Recording): string {
  const t = (r.processed_text || r.raw_text).slice(0, 80);
  return `${r.id.slice(0, 8)} | ${r.processing_mode} | ${r.created_at.slice(0, 16)} | ${t}${t.length >= 80 ? "..." : ""}`;
}

/** Full format — only non-null fields */
function full(r: Recording): string {
  const lines: string[] = [`ID: ${r.id}`, `Mode: ${r.processing_mode}`, `Model: ${r.model_used}`];
  if (r.enhancement_model) lines.push(`Enhanced by: ${r.enhancement_model}`);
  if (r.duration_ms) lines.push(`Duration: ${(r.duration_ms / 1000).toFixed(1)}s`);
  if (r.language) lines.push(`Language: ${r.language}`);
  if (r.tags.length > 0) lines.push(`Tags: ${r.tags.join(", ")}`);
  if (r.agent_id) lines.push(`Agent: ${r.agent_id}`);
  if (r.project_id) lines.push(`Project: ${r.project_id}`);
  if (r.session_id) lines.push(`Session: ${r.session_id}`);
  lines.push(`Created: ${r.created_at}`);
  lines.push(`Text: ${r.raw_text}`);
  if (r.processed_text && r.processed_text !== r.raw_text) {
    lines.push(`Enhanced: ${r.processed_text}`);
  }
  return lines.join("\n");
}

// ── Recording Tools ─────────────────────────────────────────────────────────

server.tool(
  "transcribe_audio",
  "Transcribe audio file. Auto-enhances if needed.",
  {
    audio_path: z.string().describe("Audio file path"),
    language: z.string().optional().describe("Language code"),
    no_enhance: z.boolean().optional().describe("Skip enhancement"),
    tags: z.array(z.string()).optional().describe("Tags"),
    agent_id: z.string().optional().describe("Agent ID"),
    project_id: z.string().optional().describe("Project ID"),
    session_id: z.string().optional().describe("Session ID"),
  },
  async (args) => {
    try {
      const cfg = { ...config };
      if (args.language) cfg.language = args.language;
      if (args.no_enhance) cfg.auto_enhance = false;

      const transcription = await transcribeAudio(args.audio_path, cfg);
      const processed = await processText(transcription.text, cfg);

      const recording = createRecording({
        audio_path: args.audio_path,
        raw_text: transcription.text,
        processed_text: processed.mode === "enhanced" ? processed.text : undefined,
        processing_mode: processed.mode,
        model_used: transcription.model,
        enhancement_model: processed.enhancement_model || undefined,
        duration_ms: transcription.duration_ms,
        language: transcription.language || undefined,
        tags: args.tags,
        agent_id: args.agent_id,
        project_id: args.project_id,
        session_id: args.session_id,
      });

      // Compact output: just the text + id
      const output = processed.mode === "enhanced" ? processed.text : transcription.text;
      return text(`${recording.id.slice(0, 8)} | ${processed.mode} | ${output}`);
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "save_recording",
  "Save text as recording. Auto-enhances if needed.",
  {
    text: z.string().describe("Text to save"),
    enhance: z.boolean().optional().describe("Force enhancement"),
    tags: z.array(z.string()).optional().describe("Tags"),
    agent_id: z.string().optional().describe("Agent ID"),
    project_id: z.string().optional().describe("Project ID"),
    session_id: z.string().optional().describe("Session ID"),
    metadata: z.record(z.unknown()).optional().describe("Metadata"),
  },
  async (args) => {
    try {
      let processedText: string | undefined;
      let mode: "raw" | "enhanced" = "raw";
      let enhModel: string | undefined;

      if (args.enhance !== false) {
        const processed = await processText(args.text, config);
        if (processed.mode === "enhanced") {
          processedText = processed.text;
          mode = "enhanced";
          enhModel = processed.enhancement_model || undefined;
        }
      }

      const recording = createRecording({
        raw_text: args.text,
        processed_text: processedText,
        processing_mode: mode,
        model_used: "direct-input",
        enhancement_model: enhModel,
        tags: args.tags,
        agent_id: args.agent_id,
        project_id: args.project_id,
        session_id: args.session_id,
        metadata: args.metadata,
      });

      const output = processedText || args.text;
      return text(`${recording.id.slice(0, 8)} | ${mode} | ${output}`);
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "get_recording",
  "Get recording by ID or prefix.",
  {
    id: z.string().describe("Recording ID or prefix"),
  },
  async (args) => {
    try {
      const r = getRecording(args.id);
      if (!r) return text(`Not found: ${args.id}`);
      return text(full(r));
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "list_recordings",
  "List recordings. Compact by default, most recent first.",
  {
    limit: z.number().optional().describe("Max results (default: 10)"),
    offset: z.number().optional().describe("Skip N"),
    processing_mode: z.enum(["raw", "enhanced"]).optional().describe("Filter by mode"),
    tags: z.array(z.string()).optional().describe("Filter tags"),
    search: z.string().optional().describe("Search text"),
    since: z.string().optional().describe("After date"),
    until: z.string().optional().describe("Before date"),
    agent_id: z.string().optional().describe("Agent filter"),
    project_id: z.string().optional().describe("Project filter"),
    session_id: z.string().optional().describe("Session filter"),
    full: z.boolean().optional().describe("Full output per recording"),
  },
  async (args) => {
    try {
      const filter: RecordingFilter = {
        limit: args.limit || 10,
        offset: args.offset,
        processing_mode: args.processing_mode,
        tags: args.tags,
        search: args.search,
        since: args.since,
        until: args.until,
        agent_id: args.agent_id,
        project_id: args.project_id,
        session_id: args.session_id,
      };

      const recordings = listRecordings(filter);
      if (recordings.length === 0) return text("No recordings found.");

      const fmt = args.full ? full : compact;
      const sep = args.full ? "\n---\n" : "\n";
      return text(`${recordings.length} recording(s):${sep}${recordings.map(fmt).join(sep)}`);
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "search_recordings",
  "Search recordings by text content.",
  {
    query: z.string().describe("Search query"),
    limit: z.number().optional().describe("Max results (default: 10)"),
    agent_id: z.string().optional().describe("Agent filter"),
    project_id: z.string().optional().describe("Project filter"),
    full: z.boolean().optional().describe("Full output"),
  },
  async (args) => {
    try {
      const results = searchRecordings(args.query, {
        limit: args.limit || 10,
        agent_id: args.agent_id,
        project_id: args.project_id,
      });

      if (results.length === 0) return text("No results.");

      const fmt = args.full ? full : compact;
      const sep = args.full ? "\n---\n" : "\n";
      return text(`${results.length} result(s):${sep}${results.map(fmt).join(sep)}`);
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "delete_recording",
  "Delete a recording by ID.",
  { id: z.string().describe("Recording ID") },
  async (args) => {
    try {
      return text(deleteRecording(args.id) ? `Deleted ${args.id}` : `Not found: ${args.id}`);
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "recording_stats",
  "Recording count, mode breakdown, duration stats.",
  {},
  async () => {
    try {
      const s = getRecordingStats();
      let out = `Total: ${s.total} | Raw: ${s.raw} | Enhanced: ${s.enhanced} | Duration: ${(s.total_duration_ms / 1000).toFixed(1)}s`;
      if (Object.keys(s.by_model).length > 0) {
        out += "\n" + Object.entries(s.by_model).map(([m, c]) => `${m}: ${c}`).join(", ");
      }
      return text(out);
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ── Enhancement Detection ───────────────────────────────────────────────────

server.tool(
  "detect_enhancement",
  "Check if text needs AI enhancement.",
  { text: z.string().describe("Text to analyze") },
  async (args) => {
    try {
      const r = needsEnhancement(args.text, config);
      return text(`${r.needs ? "Yes" : "No"}: ${r.reason}`);
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ── Agent Tools ─────────────────────────────────────────────────────────────

server.tool(
  "register_agent",
  "Register agent (idempotent).",
  {
    name: z.string().describe("Agent name"),
    description: z.string().optional().describe("Description"),
    role: z.string().optional().describe("Role"),
  },
  async (args) => {
    try {
      const a = registerAgent(args.name, args.description, args.role);
      return text(`${a.id} | ${a.name} | ${a.role}`);
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "list_agents",
  "List registered agents.",
  {},
  async () => {
    try {
      const agents = listAgents();
      if (agents.length === 0) return text("None.");
      return text(agents.map((a) => `${a.id} | ${a.name} | ${a.role}`).join("\n"));
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "get_agent",
  "Get agent by ID or name.",
  { id: z.string().describe("Agent ID or name") },
  async (args) => {
    try {
      const a = getAgent(args.id);
      if (!a) return text(`Not found: ${args.id}`);
      return text(`${a.id} | ${a.name} | ${a.role} | ${a.last_seen_at}`);
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ── Project Tools ───────────────────────────────────────────────────────────

server.tool(
  "register_project",
  "Register project (idempotent).",
  {
    name: z.string().describe("Project name"),
    path: z.string().describe("Absolute path"),
    description: z.string().optional().describe("Description"),
  },
  async (args) => {
    try {
      const p = registerProject(args.name, args.path, args.description);
      return text(`${p.id.slice(0, 8)} | ${p.name} | ${p.path}`);
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "list_projects",
  "List registered projects.",
  {},
  async () => {
    try {
      const projects = listProjects();
      if (projects.length === 0) return text("None.");
      return text(projects.map((p) => `${p.id.slice(0, 8)} | ${p.name} | ${p.path}`).join("\n"));
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ── Start Server ────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
