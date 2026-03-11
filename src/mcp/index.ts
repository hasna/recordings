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
  version: "0.0.1",
});

// ── Helper ──────────────────────────────────────────────────────────────────

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function errorResult(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

function formatRecording(r: Recording): string {
  const lines: string[] = [
    `ID: ${r.id}`,
    `Mode: ${r.processing_mode}`,
    `Model: ${r.model_used}`,
  ];
  if (r.enhancement_model) lines.push(`Enhancement model: ${r.enhancement_model}`);
  if (r.duration_ms) lines.push(`Duration: ${(r.duration_ms / 1000).toFixed(1)}s`);
  if (r.language) lines.push(`Language: ${r.language}`);
  if (r.tags.length > 0) lines.push(`Tags: ${r.tags.join(", ")}`);
  if (r.agent_id) lines.push(`Agent: ${r.agent_id}`);
  if (r.project_id) lines.push(`Project: ${r.project_id}`);
  lines.push(`Created: ${r.created_at}`);
  lines.push("");
  lines.push(`Raw text: ${r.raw_text}`);
  if (r.processed_text && r.processed_text !== r.raw_text) {
    lines.push(`Enhanced text: ${r.processed_text}`);
  }
  return lines.join("\n");
}

function formatRecordingShort(r: Recording): string {
  const output = r.processed_text || r.raw_text;
  const truncated = output.length > 100 ? output.slice(0, 100) + "..." : output;
  return `${r.id.slice(0, 8)} [${r.processing_mode}] ${r.created_at.slice(0, 16)} — ${truncated}`;
}

// ── Recording Tools ─────────────────────────────────────────────────────────

server.tool(
  "transcribe_audio",
  "Transcribe an audio file to text. Automatically detects if the text needs AI enhancement (e.g., 'say it better', instructions to agents). Returns both raw transcription and enhanced text if applicable.",
  {
    audio_path: z.string().describe("Path to audio file (wav, mp3, m4a, webm)"),
    language: z.string().optional().describe("Language code (e.g. en, es, fr)"),
    no_enhance: z.boolean().optional().describe("Skip AI enhancement even if detected"),
    tags: z.array(z.string()).optional().describe("Tags for the recording"),
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

      return text(formatRecording(recording));
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "save_recording",
  "Save a text recording directly (without audio transcription). Useful when text is already available from another source. Automatically detects and enhances if needed.",
  {
    text: z.string().describe("The text to save"),
    enhance: z.boolean().optional().describe("Force enhancement (default: auto-detect)"),
    tags: z.array(z.string()).optional().describe("Tags"),
    agent_id: z.string().optional().describe("Agent ID"),
    project_id: z.string().optional().describe("Project ID"),
    session_id: z.string().optional().describe("Session ID"),
    metadata: z.record(z.unknown()).optional().describe("Custom metadata"),
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

      return text(formatRecording(recording));
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "get_recording",
  "Get a specific recording by ID (supports partial ID prefix match)",
  {
    id: z.string().describe("Recording ID or prefix"),
  },
  async (args) => {
    try {
      const recording = getRecording(args.id);
      if (!recording) return text(`Recording not found: ${args.id}`);
      return text(formatRecording(recording));
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "list_recordings",
  "List recordings with optional filters. Returns most recent first.",
  {
    limit: z.number().optional().describe("Max results (default: 50)"),
    offset: z.number().optional().describe("Skip N results"),
    processing_mode: z.enum(["raw", "enhanced"]).optional().describe("Filter by mode"),
    tags: z.array(z.string()).optional().describe("Filter by tags (AND)"),
    search: z.string().optional().describe("Search text content"),
    since: z.string().optional().describe("After date (ISO)"),
    until: z.string().optional().describe("Before date (ISO)"),
    agent_id: z.string().optional().describe("Filter by agent"),
    project_id: z.string().optional().describe("Filter by project"),
    session_id: z.string().optional().describe("Filter by session"),
  },
  async (args) => {
    try {
      const filter: RecordingFilter = {
        limit: args.limit,
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

      const lines = recordings.map(formatRecordingShort);
      return text(`${recordings.length} recording(s):\n${lines.join("\n")}`);
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "search_recordings",
  "Search recordings by text content (raw or enhanced text)",
  {
    query: z.string().describe("Search query"),
    limit: z.number().optional().describe("Max results (default: 20)"),
    agent_id: z.string().optional().describe("Filter by agent"),
    project_id: z.string().optional().describe("Filter by project"),
  },
  async (args) => {
    try {
      const results = searchRecordings(args.query, {
        limit: args.limit,
        agent_id: args.agent_id,
        project_id: args.project_id,
      });

      if (results.length === 0) return text("No results found.");

      const lines = results.map(formatRecordingShort);
      return text(`${results.length} result(s):\n${lines.join("\n")}`);
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "delete_recording",
  "Delete a recording by ID",
  {
    id: z.string().describe("Recording ID"),
  },
  async (args) => {
    try {
      const deleted = deleteRecording(args.id);
      return text(deleted ? `Deleted recording ${args.id}` : `Recording not found: ${args.id}`);
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "recording_stats",
  "Get recording statistics — total count, mode breakdown, duration, models used",
  {},
  async () => {
    try {
      const stats = getRecordingStats();
      const lines = [
        `Total recordings: ${stats.total}`,
        `Raw: ${stats.raw}`,
        `Enhanced: ${stats.enhanced}`,
        `Total duration: ${(stats.total_duration_ms / 1000).toFixed(1)}s`,
      ];
      if (Object.keys(stats.by_model).length > 0) {
        lines.push("By model:");
        for (const [model, count] of Object.entries(stats.by_model)) {
          lines.push(`  ${model}: ${count}`);
        }
      }
      return text(lines.join("\n"));
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ── Enhancement Detection Tool ──────────────────────────────────────────────

server.tool(
  "detect_enhancement",
  "Analyze text to determine if it needs AI enhancement. Returns whether enhancement is needed, the reason, and extracted instruction.",
  {
    text: z.string().describe("Text to analyze"),
  },
  async (args) => {
    try {
      const result = needsEnhancement(args.text, config);
      return text(
        `Needs enhancement: ${result.needs}\nReason: ${result.reason}\nInstruction: ${result.instruction}`
      );
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ── Agent Tools ─────────────────────────────────────────────────────────────

server.tool(
  "register_agent",
  "Register an agent (idempotent — same name returns existing agent)",
  {
    name: z.string().describe("Agent name"),
    description: z.string().optional().describe("Agent description"),
    role: z.string().optional().describe("Agent role"),
  },
  async (args) => {
    try {
      const agent = registerAgent(args.name, args.description, args.role);
      return text(
        `Agent registered:\nID: ${agent.id}\nName: ${agent.name}\nRole: ${agent.role}\nCreated: ${agent.created_at}\nLast seen: ${agent.last_seen_at}`
      );
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "list_agents",
  "List all registered agents",
  {},
  async () => {
    try {
      const agents = listAgents();
      if (agents.length === 0) return text("No agents registered.");

      const lines = agents.map(
        (a) => `${a.id} | ${a.name} | ${a.role} | last seen ${a.last_seen_at}`
      );
      return text(`${agents.length} agent(s):\n${lines.join("\n")}`);
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "get_agent",
  "Get agent by ID or name",
  {
    id: z.string().describe("Agent ID or name"),
  },
  async (args) => {
    try {
      const agent = getAgent(args.id);
      if (!agent) return text(`Agent not found: ${args.id}`);
      return text(
        `ID: ${agent.id}\nName: ${agent.name}\nRole: ${agent.role}\nCreated: ${agent.created_at}\nLast seen: ${agent.last_seen_at}`
      );
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ── Project Tools ───────────────────────────────────────────────────────────

server.tool(
  "register_project",
  "Register a project (idempotent — same path returns existing project)",
  {
    name: z.string().describe("Project name"),
    path: z.string().describe("Absolute path to project"),
    description: z.string().optional().describe("Project description"),
  },
  async (args) => {
    try {
      const project = registerProject(args.name, args.path, args.description);
      return text(
        `Project registered:\nID: ${project.id}\nName: ${project.name}\nPath: ${project.path}\nCreated: ${project.created_at}`
      );
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "list_projects",
  "List all registered projects",
  {},
  async () => {
    try {
      const projects = listProjects();
      if (projects.length === 0) return text("No projects registered.");

      const lines = projects.map(
        (p) => `${p.id.slice(0, 8)} | ${p.name} | ${p.path}`
      );
      return text(`${projects.length} project(s):\n${lines.join("\n")}`);
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ── Start Server ────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
