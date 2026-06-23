#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_MCP_HTTP_PORT, isStdioMode, startMcpHttpServer, resolveMcpHttpPort } from "./http.js";
import { z } from "zod";
import {
  loadConfig,
  ensureDataDir,
  normalizePostProcessingConfig,
  normalizePostProcessingMode,
} from "../lib/config.js";
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
import { processText, needsEnhancement, resolveTranscriberModel } from "../lib/enhancer.js";
import type { Recording, RecordingFilter } from "../types/index.js";
import { VERSION } from "../version.js";
import { registerRecordingsStorageTools } from "./storage-tools.js";

// ── Initialize ──────────────────────────────────────────────────────────────

const config = loadConfig();
ensureDataDir(config);
getDatabase(config.db_path);

function runtimeConfig(): typeof config {
  return {
    ...loadConfig(),
    db_path: config.db_path,
    audio_dir: config.audio_dir,
  };
}

export function buildServer(): McpServer {
const server = new McpServer({
  name: "recordings",
  version: VERSION,
});
const registerTool = server.tool.bind(server) as (
  name: string,
  description: string,
  paramsSchema: Record<string, unknown>,
  cb: (args: any) => unknown
) => void;

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

function applyTranscriptionArgs(
  cfg: ReturnType<typeof runtimeConfig>,
  args: {
    language?: string;
    prompt?: string;
    transcription_prompt?: string;
    transcriber_prompt?: string;
    system_prompt?: string;
    post_processing_mode?: "off" | "auto" | "always";
    post_processing?: "off" | "auto" | "always";
    no_enhance?: boolean;
    enhance?: boolean;
    transcriber_model?: string;
    enhancement_model?: string;
  }
): ReturnType<typeof runtimeConfig> {
  if (args.language) cfg.language = args.language;

  const transcriptionPrompt = args.transcription_prompt ?? args.prompt;
  if (transcriptionPrompt !== undefined) {
    cfg.transcription_prompt = transcriptionPrompt;
  }

  const transcriberPrompt = args.transcriber_prompt ?? args.system_prompt;
  if (transcriberPrompt !== undefined) {
    cfg.transcriber_prompt = transcriberPrompt;
  }

  if (args.transcriber_model) {
    cfg.transcriber_model = args.transcriber_model;
  } else if (args.enhancement_model) {
    cfg.enhancement_model = args.enhancement_model;
    cfg.transcriber_model = args.enhancement_model;
  }

  const requestedMode = args.post_processing_mode ?? args.post_processing;
  if (args.no_enhance || args.enhance === false) {
    cfg.post_processing_mode = "off";
    normalizePostProcessingConfig(cfg, true);
  } else if (args.enhance === true) {
    cfg.post_processing_mode = "always";
    normalizePostProcessingConfig(cfg, true);
  } else if (requestedMode) {
    cfg.post_processing_mode = normalizePostProcessingMode(
      requestedMode,
      cfg.post_processing_mode ?? "auto"
    );
    normalizePostProcessingConfig(cfg, true);
  } else {
    normalizePostProcessingConfig(cfg, false);
  }

  return cfg;
}

function buildTranscriptionMetadata(
  cfg: ReturnType<typeof runtimeConfig>,
  processed: Awaited<ReturnType<typeof processText>>,
  sources: {
    transcriptionPromptFromRequest?: boolean;
    transcriberPromptFromRequest?: boolean;
  } = {}
): Record<string, unknown> {
  const transcriptionPromptConfigured = Boolean(cfg.transcription_prompt?.trim());
  const transcriberPromptConfigured = Boolean(cfg.transcriber_prompt?.trim());

  return {
    transcription_prompt: {
      configured: transcriptionPromptConfigured,
      source: sources.transcriptionPromptFromRequest
        ? "request"
        : transcriptionPromptConfigured
          ? "config"
          : "none",
    },
    transcriber_prompt: {
      configured: transcriberPromptConfigured,
      source: sources.transcriberPromptFromRequest
        ? "request"
        : transcriberPromptConfigured
          ? "config"
          : "none",
    },
    post_processing: {
      mode: processed.post_processing_mode,
      applied: processed.mode === "enhanced",
      reason: processed.enhancement_reason,
      model: processed.enhancement_model,
    },
    transcriber_model: resolveTranscriberModel(cfg),
  };
}

function recordingJson(r: Recording): string {
  return JSON.stringify({
    id: r.id,
    raw_text: r.raw_text,
    processed_text: r.processed_text,
    processing_mode: r.processing_mode,
    model_used: r.model_used,
    enhancement_model: r.enhancement_model,
    language: r.language,
    tags: r.tags,
    metadata: r.metadata,
    created_at: r.created_at,
  }, null, 2);
}

async function saveRecordingMemento(args: {
  key: string;
  value: string;
  summary: string;
}): Promise<void> {
  try {
    const proc = Bun.spawn(
      [
        "mementos",
        "save",
        "--scope",
        "shared",
        "--category",
        "history",
        "--importance",
        "5",
        "--tags",
        "recording,transcription",
        "--summary",
        args.summary,
        args.key,
        args.value,
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
      }
    );
    await proc.exited;
  } catch {
    // Memory capture is best-effort; transcription should still succeed.
  }
}

// ── Full tool schemas for describe_tool ─────────────────────────────────────

const toolDocs: Record<string, string> = {
  recordings_status: "Show safe service status for agents.\nParams: none\nReturns: JSON with package version, MCP HTTP defaults, active transcription/enhancement models, language, data paths, key-presence booleans, and recording counts. Never returns secret values.",
  transcribe_audio: "Transcribe audio file and save raw plus optional processed text.\nParams: audio_path (string, required): path to wav/mp3/m4a/webm | language (string): ISO code e.g. en/es/fr | transcription_prompt or prompt (string): STT vocabulary/context only | transcriber_prompt or system_prompt (string): post-transcription cleanup instructions | post_processing_mode ('off'|'auto'|'always') | transcriber_model (string) | no_enhance (bool): alias for post_processing_mode=off | tags (string[]) | agent_id (string) | project_id (string) | session_id (string)\nReturns: JSON recording summary with raw_text, processed_text, processing_mode, and safe metadata.",
  save_recording: "Save text as recording. Auto-enhances if needed.\nParams: text (string, required): text to save | enhance (bool): true forces always, false disables | transcriber_prompt or system_prompt (string): post-processing instructions | post_processing_mode ('off'|'auto'|'always') | tags (string[]) | agent_id (string) | project_id (string) | session_id (string) | metadata (object)",
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

registerTool(
  "describe_tool",
  "Get full param docs for any tool.",
  { name: z.string() },
  async (args) => {
    const doc = toolDocs[args.name];
    return doc ? text(doc) : text(`Unknown tool: ${args.name}. Available: ${Object.keys(toolDocs).join(", ")}`);
  }
);

registerTool(
  "recordings_status",
  "Show safe service status for agents.",
  {},
  async () => {
    try {
      const cfg = runtimeConfig();
      const stats = getRecordingStats();
      return text(JSON.stringify({
        service: "recordings",
        version: VERSION,
        mcp: {
          default_http_port: DEFAULT_MCP_HTTP_PORT,
          endpoint: "/mcp",
        },
        config: {
          transcription_model: cfg.transcription_model,
          realtime_session_model: cfg.realtime_session_model,
          realtime_transcription_model: cfg.realtime_transcription_model,
          enhancement_model: cfg.enhancement_model,
          transcriber_model: resolveTranscriberModel(cfg),
          language: cfg.language,
          auto_enhance: cfg.auto_enhance,
          post_processing_mode: cfg.post_processing_mode,
          transcription_prompt_configured: Boolean(cfg.transcription_prompt?.trim()),
          transcriber_prompt_configured: Boolean(cfg.transcriber_prompt?.trim()),
          max_recording_seconds: cfg.max_recording_seconds,
          db_path: cfg.db_path,
          audio_dir: cfg.audio_dir,
          openai_api_key_configured: Boolean(cfg.openai_api_key),
          enhancement_api_key_configured: Boolean(cfg.enhancement_api_key || cfg.openai_api_key),
          config_warnings: cfg.config_warnings ?? [],
        },
        stats,
      }, null, 2));
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ── Recording Tools (lean stubs — no param descriptions) ────────────────────

registerTool(
  "transcribe_audio",
  "Transcribe audio file. Auto-enhances if needed.",
  {
    audio_path: z.string(),
    language: z.string().optional(),
    transcription_prompt: z.string().optional(),
    prompt: z.string().optional(),
    transcriber_prompt: z.string().optional(),
    system_prompt: z.string().optional(),
    post_processing_mode: z.enum(["off", "auto", "always"]).optional(),
    post_processing: z.enum(["off", "auto", "always"]).optional(),
    transcriber_model: z.string().optional(),
    enhancement_model: z.string().optional(),
    no_enhance: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    session_id: z.string().optional(),
  },
  async (args) => {
    try {
      const cfg = applyTranscriptionArgs({ ...runtimeConfig() }, args);

      const transcription = await transcribeAudio(args.audio_path, cfg);
      const processed = await processText(transcription.text, cfg);
      const metadata = buildTranscriptionMetadata(cfg, processed, {
        transcriptionPromptFromRequest:
          args.transcription_prompt !== undefined || args.prompt !== undefined,
        transcriberPromptFromRequest:
          args.transcriber_prompt !== undefined || args.system_prompt !== undefined,
      });

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
        metadata,
      });

      // Create memory in Open Mementos if agent_id is provided
      if (args.agent_id) {
        await saveRecordingMemento({
          key: `recording-${recording.id}`,
          value: JSON.stringify({
            recording_id: recording.id,
            text: processed.mode === "enhanced" ? processed.text : transcription.text,
            agent_id: args.agent_id,
            project_id: args.project_id,
            session_id: args.session_id,
            created_at: recording.created_at
          }),
          summary: `Recording ${recording.id.slice(0, 8)} for ${args.agent_id}`,
        });
      }

      return text(recordingJson(recording));
    } catch (e) {
      return errorResult(e);
    }
  }
);

registerTool(
  "save_recording",
  "Save text as recording. Auto-enhances if needed.",
  {
    text: z.string(),
    enhance: z.boolean().optional(),
    transcriber_prompt: z.string().optional(),
    system_prompt: z.string().optional(),
    post_processing_mode: z.enum(["off", "auto", "always"]).optional(),
    post_processing: z.enum(["off", "auto", "always"]).optional(),
    transcriber_model: z.string().optional(),
    enhancement_model: z.string().optional(),
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
      const cfg = applyTranscriptionArgs(runtimeConfig(), args);
      let processedText: string | undefined;
      let mode: "raw" | "enhanced" = "raw";
      let enhModel: string | undefined;
      let processed: Awaited<ReturnType<typeof processText>> = {
        text: args.text,
        mode: "raw",
        enhancement_model: null,
        post_processing_mode: cfg.post_processing_mode ?? "auto",
        enhancement_reason: null,
      };

      if (cfg.post_processing_mode !== "off") {
        processed = await processText(args.text, cfg);
      }
      if (processed.mode === "enhanced") {
        processedText = processed.text;
        mode = "enhanced";
        enhModel = processed.enhancement_model || undefined;
      }
      const processingMetadata = buildTranscriptionMetadata(cfg, processed, {
        transcriberPromptFromRequest:
          args.transcriber_prompt !== undefined || args.system_prompt !== undefined,
      });

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
        metadata: {
          ...(args.metadata ?? {}),
          ...processingMetadata,
        },
      });

      return text(recordingJson(recording));
    } catch (e) {
      return errorResult(e);
    }
  }
);

registerTool(
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

registerTool(
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

registerTool(
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

registerTool(
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

registerTool(
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

registerTool(
  "detect_enhancement",
  "Check if text needs AI enhancement.",
  { text: z.string() },
  async (args) => {
    try {
      const r = needsEnhancement(args.text, runtimeConfig());
      return text(`${r.needs ? "Yes" : "No"}: ${r.reason}`);
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ── Agent Tools ─────────────────────────────────────────────────────────────

registerTool(
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

registerTool(
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

registerTool(
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

registerTool(
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

registerTool(
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

registerTool(
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

registerTool(
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

registerTool(
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

registerRecordingsStorageTools(server);
return server;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (isStdioMode(args)) {
    const transport = new StdioServerTransport();
    await buildServer().connect(transport);
    return;
  }
  // Default: shared Streamable HTTP server (one process per MCP, many agents).
  startMcpHttpServer({ name: "recordings", port: resolveMcpHttpPort(args), buildServer });
}

if (import.meta.main) {
  await main();
}
