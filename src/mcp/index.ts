#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCloudTools } from "@hasna/cloud";
import { z } from "zod";
import { loadConfig, ensureDataDir } from "../lib/config.js";
import { getDatabase, getAdapter } from "../db/database.js";
import {
  createRecording,
  getRecording,
  listRecordings,
  deleteRecording,
  searchRecordings,
  getRecordingStats,
} from "../db/recordings.js";
import { registerAgent, getAgent, listAgents, heartbeatAgent, setAgentFocus } from "../db/agents.js";
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
  version: "0.0.3",
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function errorResult(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

function compact(r: Recording): string {
  const t = (r.processed_text || r.raw_text).slice(0, 80);
  return `${r.id.slice(0, 8)} | ${r.processing_mode} | ${r.created_at.slice(0, 16)} | ${t}${t.length >= 80 ? "..." : ""}`;
}

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

// ── Full tool schemas for describe_tool ─────────────────────────────────────

const toolDocs: Record<string, string> = {
  transcribe_audio: "Transcribe audio file. Auto-enhances if needed.\nParams: audio_path (string, required): path to wav/mp3/m4a/webm | language (string): ISO code e.g. en/es/fr | no_enhance (bool): skip AI enhancement | tags (string[]): tags | agent_id (string) | project_id (string) | session_id (string)",
  save_recording: "Save text as recording. Auto-enhances if needed.\nParams: text (string, required): text to save | enhance (bool): force enhancement | tags (string[]) | agent_id (string) | project_id (string) | session_id (string) | metadata (object)",
  get_recording: "Get recording by ID or prefix.\nParams: id (string, required): recording ID or prefix",
  list_recordings: "List recordings, compact by default, most recent first.\nParams: limit (number, default 10) | offset (number) | processing_mode ('raw'|'enhanced') | tags (string[]) | search (string): text search | since/until (ISO date) | agent_id | project_id | session_id | full (bool): verbose output",
  search_recordings: "Search recordings by text content.\nParams: query (string, required) | limit (number, default 10) | agent_id | project_id | full (bool): verbose output",
  delete_recording: "Delete recording by ID.\nParams: id (string, required)",
  recording_stats: "Recording count, mode breakdown, duration.\nParams: none",
  detect_enhancement: "Check if text needs AI enhancement.\nParams: text (string, required)",
  register_agent: "Register agent (idempotent). Auto-updates last_seen_at on re-register.\nParams: name (string, required) | description (string) | role (string)",
  list_agents: "List registered agents.\nParams: none",
  get_agent: "Get agent by ID or name.\nParams: id (string, required)",
  heartbeat: "Update last_seen_at to signal agent is active.\nParams: agent_id (string, required): agent ID or name",
  set_focus: "Set active project context for this agent session.\nParams: agent_id (string, required) | project_id (string, nullable): project ID or null to clear",
  register_project: "Register project (idempotent).\nParams: name (string, required) | path (string, required): absolute path | description (string)",
  list_projects: "List registered projects.\nParams: none",
};

// ── Meta Tool ───────────────────────────────────────────────────────────────

server.tool(
  "describe_tool",
  "Get full param docs for any tool.",
  { name: z.string() },
  async (args) => {
    const doc = toolDocs[args.name];
    return doc ? text(doc) : text(`Unknown tool: ${args.name}. Available: ${Object.keys(toolDocs).join(", ")}`);
  }
);

// ── Recording Tools (lean stubs — no param descriptions) ────────────────────

server.tool(
  "transcribe_audio",
  "Transcribe audio file. Auto-enhances if needed.",
  {
    audio_path: z.string(),
    language: z.string().optional(),
    no_enhance: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    session_id: z.string().optional(),
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
    text: z.string(),
    enhance: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    session_id: z.string().optional(),
    goal: z.string().optional().describe("Goal or purpose of this recording session (e.g. 'code review for PR #123')"),
    role: z.string().optional().describe("Agent role for this session (e.g. 'dev agent for connectdev')"),
    task_list_id: z.string().optional().describe("Task list ID to bind this recording to"),
    metadata: z.record(z.unknown()).optional(),
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
        goal: args.goal,
        role: args.role,
        task_list_id: args.task_list_id,
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
  { id: z.string() },
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
  "List recordings. Compact default, recent first.",
  {
    limit: z.number().optional(),
    offset: z.number().optional(),
    processing_mode: z.enum(["raw", "enhanced"]).optional(),
    tags: z.array(z.string()).optional(),
    search: z.string().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    session_id: z.string().optional(),
    full: z.boolean().optional(),
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
  "Search recordings by text.",
  {
    query: z.string(),
    limit: z.number().optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    full: z.boolean().optional(),
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
  "Delete recording by ID.",
  { id: z.string() },
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
  "Recording stats: count, modes, duration.",
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

server.tool(
  "detect_enhancement",
  "Check if text needs AI enhancement.",
  { text: z.string() },
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
  { name: z.string(), description: z.string().optional(), role: z.string().optional() },
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
  { id: z.string() },
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
  { name: z.string(), path: z.string(), description: z.string().optional() },
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

// ── Heartbeat & Focus ───────────────────────────────────────────────────────

server.tool(
  "heartbeat",
  "Update last_seen_at to signal agent is active. Call periodically during long tasks.",
  { agent_id: z.string().describe("Agent ID or name") },
  async (args) => {
    try {
      const agent = heartbeatAgent(args.agent_id);
      if (!agent) return text(`Agent not found: ${args.agent_id}`);
      return text(`${agent.id} | ${agent.name} | last_seen: ${agent.last_seen_at}`);
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "set_focus",
  "Set active project context for this agent session.",
  { agent_id: z.string().describe("Agent ID or name"), project_id: z.string().nullable().optional().describe("Project ID to focus on, or null to clear") },
  async (args) => {
    try {
      const agent = setAgentFocus(args.agent_id, args.project_id ?? null);
      if (!agent) return text(`Agent not found: ${args.agent_id}`);
      return text(args.project_id ? `Focus set: ${args.project_id}` : "Focus cleared");
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "send_feedback",
  "Send feedback about this service",
  {
    message: z.string().describe("Feedback message"),
    email: z.string().optional().describe("Contact email (optional)"),
    category: z.enum(["bug", "feature", "general"]).optional().describe("Feedback category"),
  },
  async (params: { message: string; email?: string; category?: string }) => {
    const adapter = getAdapter();
    const pkg = require("../../package.json");
    adapter.run(
      "INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)",
      params.message, params.email || null, params.category || "general", pkg.version
    );
    return text("Feedback saved. Thank you!");
  }
);

const transport = new StdioServerTransport();
registerCloudTools(server, "recordings");
await server.connect(transport);
