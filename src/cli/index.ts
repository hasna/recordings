#!/usr/bin/env bun
import { Command } from "commander";
import { registerEventsCommands } from "@hasna/events/commander";
import chalk from "chalk";
import { spawnSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join as pathJoin } from "path";
import { fileURLToPath } from "url";
import { loadConfig, ensureDataDir } from "../lib/config.js";
import { countStoreRecordings, getStore } from "../store.js";
import {
  startRecording,
  stopRecording,
  isRecording,
  checkRecordingDeps,
  recordDuration,
} from "../lib/recorder.js";
import { transcribeAudio, transcribeAudioStream } from "../lib/transcriber.js";
import { enhanceText, processText, resolveTranscriberModel } from "../lib/enhancer.js";
import type { Recording, RecordingFilter } from "../types/index.js";
import { VERSION } from "../version.js";
import { applyEnhancementOptions } from "./options.js";
import { removeCodexServerBlock, upsertCodexStdioBlock } from "./mcp-config.js";
import { currentMachineId } from "../lib/machine.js";

const program = new Command();

program
  .name("recordings")
  .description(
    "Speech-to-text recording tool — record, transcribe, and enhance with AI"
  )
  .version(VERSION)
  .option("--json", "Output as JSON")
  .option("--agent <name>", "Agent name or ID")
  .option("--project <name>", "Project name or ID")
  .option("--session <id>", "Session ID");

registerEventsCommands(program, { source: "recordings" });

const DEFAULT_LIST_LIMIT = 20;
const MAX_HUMAN_LIST_LIMIT = 50;
const DEFAULT_LOG_LINES = 40;

// ── record ──────────────────────────────────────────────────────────────────

program
  .command("record")
  .description("Record from microphone, transcribe, and optionally enhance")
  .option("-d, --duration <seconds>", "Record for specific duration")
  .option("--no-enhance", "Skip AI enhancement")
  .option("--post-processing <mode>", "Post-processing mode: off, auto, or always")
  .option("--prompt <prompt>", "Vocabulary/context prompt for transcription")
  .option("--transcriber-prompt <prompt>", "Instructions for post-transcription cleanup")
  .option("--system-prompt <prompt>", "Alias for --transcriber-prompt")
  .option("--transcriber-model <model>", "Model for post-transcription cleanup")
  .option("-t, --tags <tags>", "Comma-separated tags")
  .option("-l, --language <lang>", "Language code (e.g. en, es, fr)")
  .action(async (opts) => {
    const config = loadConfig();
    ensureDataDir(config);
    const parentOpts = program.opts();

    if (opts.language) config.language = opts.language;
    if (opts.prompt !== undefined) config.transcription_prompt = opts.prompt;
    applyEnhancementOptions(config, opts);

    // Check dependencies
    const deps = await checkRecordingDeps();
    if (!deps.available) {
      console.error(chalk.red(`Error: ${deps.message}`));
      process.exit(1);
    }

    let audioPath: string;

    if (opts.duration) {
      // Fixed duration recording
      const seconds = parseInt(opts.duration, 10);
      if (!parentOpts.json) {
        console.log(chalk.blue(`Recording for ${seconds} seconds...`));
      }
      audioPath = await recordDuration(seconds, config);
      if (!parentOpts.json) {
        console.log(chalk.green("Recording complete."));
      }
    } else {
      // Interactive recording — press Enter to stop
      if (!parentOpts.json) {
        console.log(
          chalk.blue("Recording... Press") +
            chalk.yellow(" Enter ") +
            chalk.blue("to stop.")
        );
      }
      audioPath = startRecording(config);

      // Wait for Enter key
      await new Promise<void>((resolve) => {
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.once("data", () => {
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          resolve();
        });
      });

      stopRecording();
      if (!parentOpts.json) {
        console.log(chalk.green("Recording stopped."));
      }
    }

    // Transcribe
    if (!parentOpts.json) {
      console.log(chalk.blue("Transcribing..."));
    }
    const transcription = await transcribeAudio(audioPath, config);
    if (!parentOpts.json) {
      console.log(chalk.dim(`Raw: ${transcription.text}`));
    }

    // Process (detect & enhance if needed)
    const processed = await processText(transcription.text, config);

    if (!parentOpts.json && processed.mode === "enhanced") {
      console.log(chalk.green("\nEnhanced output:"));
      console.log(processed.text);
    } else if (!parentOpts.json) {
      console.log(chalk.green("\nOutput:"));
      console.log(transcription.text);
    }

    // Save to database
    const tags = opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : [];

    const recording = await getStore().createRecording({
      audio_path: audioPath,
      raw_text: transcription.text,
      processed_text: processed.mode === "enhanced" ? processed.text : undefined,
      processing_mode: processed.mode,
      model_used: transcription.model,
      enhancement_model: processed.enhancement_model || undefined,
      duration_ms: transcription.duration_ms,
      language: transcription.language || undefined,
      tags,
      agent_id: parentOpts.agent || undefined,
      project_id: parentOpts.project || undefined,
      session_id: parentOpts.session || undefined,
      machine_id: currentMachineId(),
      metadata: buildTranscriptionMetadata(config, processed, {
        transcriptionPromptFromRequest: opts.prompt !== undefined,
        transcriberPromptFromRequest:
          opts.transcriberPrompt !== undefined || opts.systemPrompt !== undefined,
      }),
    });

    if (parentOpts.json) {
      console.log(JSON.stringify(recording, null, 2));
    } else {
      console.log(
        chalk.dim(`\nSaved as ${recording.id.slice(0, 8)}`)
      );
    }
  });

// ── transcribe ──────────────────────────────────────────────────────────────

program
  .command("transcribe <file>")
  .description("Transcribe an existing audio file")
  .option("--no-enhance", "Skip AI enhancement")
  .option("--stream", "Stream transcription deltas while the file is processed")
  .option("-t, --tags <tags>", "Comma-separated tags")
  .option("--prompt <prompt>", "Vocabulary/context prompt for transcription")
  .option("--transcriber-prompt <prompt>", "Instructions for post-transcription cleanup")
  .option("--system-prompt <prompt>", "Alias for --transcriber-prompt")
  .option("--post-processing <mode>", "Post-processing mode: off, auto, or always")
  .option("--transcriber-model <model>", "Model for post-transcription cleanup")
  .action(async (file, opts) => {
    const config = loadConfig();
    ensureDataDir(config);
    if (opts.prompt !== undefined) config.transcription_prompt = opts.prompt;
    applyEnhancementOptions(config, opts);

    const parentOpts = program.opts();
    if (!parentOpts.json) {
      console.log(chalk.blue("Transcribing..."));
    }
    const transcription = opts.stream
      ? await transcribeAudioStream(file, config, {
          onDelta: parentOpts.json ? undefined : (delta) => process.stdout.write(delta),
        })
      : await transcribeAudio(file, config);
    if (opts.stream && !parentOpts.json) {
      process.stdout.write("\n");
    }

    const processed = await processText(transcription.text, config);
    const tags = opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : [];

    const recording = await getStore().createRecording({
      audio_path: file,
      raw_text: transcription.text,
      processed_text: processed.mode === "enhanced" ? processed.text : undefined,
      processing_mode: processed.mode,
      model_used: transcription.model,
      enhancement_model: processed.enhancement_model || undefined,
      duration_ms: transcription.duration_ms,
      language: transcription.language || undefined,
      tags,
      agent_id: parentOpts.agent || undefined,
      project_id: parentOpts.project || undefined,
      session_id: parentOpts.session || undefined,
      machine_id: currentMachineId(),
      metadata: buildTranscriptionMetadata(config, processed, {
        transcriptionPromptFromRequest: opts.prompt !== undefined,
        transcriberPromptFromRequest:
          opts.transcriberPrompt !== undefined || opts.systemPrompt !== undefined,
      }),
    });

    if (parentOpts.json) {
      console.log(JSON.stringify(recording, null, 2));
    } else if (processed.mode === "enhanced") {
      console.log(chalk.green("Enhanced:"));
      console.log(processed.text);
    } else {
      console.log(chalk.green("Transcription:"));
      console.log(transcription.text);
    }

    if (!parentOpts.json) {
      console.log(chalk.dim(`Saved as ${recording.id.slice(0, 8)}`));
    }
  });

// ── save-text ───────────────────────────────────────────────────────────────

program
  .command("save-text [text]")
  .description("Save already-transcribed text as a recording")
  .option("--text-file <path>", "Read transcript text from a UTF-8 file")
  .option("--stdin", "Read transcript text from stdin")
  .option("--audio-path <path>", "Audio file path associated with this transcript")
  .option("--model-used <model>", "Model/source used to produce the raw transcript")
  .option("--source <source>", "Transcript source label for metadata", "direct_text")
  .option("--duration-ms <ms>", "Recording duration in milliseconds")
  .option("-l, --language <lang>", "Language code")
  .option("-t, --tags <tags>", "Comma-separated tags")
  .option("--no-enhance", "Skip AI enhancement")
  .option("--post-processing <mode>", "Post-processing mode: off, auto, or always")
  .option("--transcriber-prompt <prompt>", "Instructions for post-transcription cleanup")
  .option("--system-prompt <prompt>", "Alias for --transcriber-prompt")
  .option("--transcriber-model <model>", "Model for post-transcription cleanup")
  .action(async (text: string | undefined, opts) => {
    const rawText = await readSaveTextInput(text, opts);
    const config = loadConfig();
    ensureDataDir(config);
    if (opts.language) config.language = opts.language;
    applyEnhancementOptions(config, opts);

    const processed = await processText(rawText, config);
    const tags = opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : [];
    const parentOpts = program.opts();
    const metadata = {
      ...buildTranscriptionMetadata(config, processed, {
        transcriberPromptFromRequest:
          opts.transcriberPrompt !== undefined || opts.systemPrompt !== undefined,
      }),
      transcription_source: opts.source || "direct_text",
      realtime: {
        fast_path: opts.source === "realtime_fast_path",
        model: opts.modelUsed || config.realtime_transcription_model || "direct-input",
        bounded_fallback: false,
      },
    };

    const recording = await getStore().createRecording({
      audio_path: opts.audioPath || undefined,
      raw_text: rawText,
      processed_text: processed.mode === "enhanced" ? processed.text : undefined,
      processing_mode: processed.mode,
      model_used: opts.modelUsed || "direct-input",
      enhancement_model: processed.enhancement_model || undefined,
      duration_ms: opts.durationMs ? parseInt(opts.durationMs, 10) : 0,
      language: opts.language || undefined,
      tags,
      agent_id: parentOpts.agent || undefined,
      project_id: parentOpts.project || undefined,
      session_id: parentOpts.session || undefined,
      machine_id: currentMachineId(),
      metadata,
    });

    if (parentOpts.json) {
      console.log(JSON.stringify(recording, null, 2));
    } else if (processed.mode === "enhanced") {
      console.log(processed.text);
    } else {
      console.log(rawText);
    }
  });

// ── rewrite ────────────────────────────────────────────────────────────────

program
  .command("rewrite <text>")
  .description("Rewrite provided text using an instruction")
  .requiredOption("-i, --instruction <instruction>", "Rewrite instruction")
  .action(async (text, opts) => {
    const config = loadConfig();
    const parentOpts = program.opts();
    const instruction = `Instruction: ${opts.instruction}\n\nText:\n${text}`;

    try {
      const result = await enhanceText(text, instruction, config);
      if (parentOpts.json) {
        console.log(
          JSON.stringify(
            {
              raw_text: text,
              processed_text: result.enhanced,
              model_used: result.model,
            },
            null,
            2
          )
        );
      } else {
        console.log(result.enhanced);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

// ── save ────────────────────────────────────────────────────────────────────

program
  .command("save <text>")
  .description("Save raw text as a recording (no audio). Routes to the self_hosted API when configured, else local.")
  .option("-t, --tags <tags>", "Comma-separated tags")
  .option("--enhance", "Enhance the text via the configured model before saving")
  .option("--model <model>", "Value for model_used", "direct-input")
  .action(async (rawText, opts) => {
    const parentOpts = program.opts();
    let processedText: string | undefined;
    let mode: "raw" | "enhanced" = "raw";
    let enhModel: string | undefined;

    try {
      if (opts.enhance) {
        const config = loadConfig();
        const processed = await processText(rawText, config, undefined, { force: true });
        if (processed.mode === "enhanced") {
          processedText = processed.text;
          mode = "enhanced";
          enhModel = processed.enhancement_model || undefined;
        }
      }

      const tags = opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : [];

      const recording = await getStore().createRecording({
        raw_text: rawText,
        processed_text: processedText,
        processing_mode: mode,
        model_used: opts.model,
        enhancement_model: enhModel,
        tags,
        agent_id: parentOpts.agent,
        project_id: parentOpts.project,
        session_id: parentOpts.session,
        machine_id: currentMachineId(),
      });

      if (parentOpts.json) {
        console.log(JSON.stringify(recording, null, 2));
      } else {
        console.log(chalk.green(`✓ Saved recording ${recording.id}`));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

// ── list ────────────────────────────────────────────────────────────────────

program
  .command("list")
  .description("List recordings in compact form")
  .option("-n, --limit <n>", "Max results", "20")
  .option("--offset <n>", "Skip this many results")
  .option("--cursor <n>", "Pagination cursor alias for --offset")
  .option("--mode <mode>", "Filter by mode: raw or enhanced")
  .option("-t, --tags <tags>", "Filter by tags")
  .option("--since <date>", "After date (ISO)")
  .option("--until <date>", "Before date (ISO)")
  .option("--verbose", "Show more metadata per row without dumping full text")
  .action(async (opts) => {
    const parentOpts = program.opts();
    const pagination = resolvePagination(opts, parentOpts);

    const filter: RecordingFilter = {
      limit: pagination.limit,
      processing_mode: opts.mode,
      tags: parseCsvList(opts.tags),
      since: opts.since,
      until: opts.until,
      offset: pagination.offset,
      agent_id: parentOpts.agent,
      project_id: parentOpts.project,
      session_id: parentOpts.session,
    };
    const store = getStore();
    const recordings = await store.listRecordings(filter);

    if (parentOpts.json) {
      console.log(JSON.stringify(recordings, null, 2));
      return;
    }
    const total = await countStoreRecordings(store, withoutPagination(filter));

    printRecordingCollection("recordings", recordings, {
      total,
      offset: pagination.offset,
      limit: pagination.limit,
      verbose: Boolean(opts.verbose),
      capped: pagination.capped,
      empty: "No recordings found.",
    });
  });

// ── show ────────────────────────────────────────────────────────────────────

program
  .command("show <id>")
  .description("Show recording details")
  .action((id) => printRecordingDetail(id));

program
  .command("inspect <id>")
  .description("Inspect recording details (alias for show)")
  .action((id) => printRecordingDetail(id));

// ── search ──────────────────────────────────────────────────────────────────

program
  .command("search <query>")
  .description("Search recordings by text content in compact form")
  .option("-n, --limit <n>", "Max results", "20")
  .option("--offset <n>", "Skip this many results")
  .option("--cursor <n>", "Pagination cursor alias for --offset")
  .option("--mode <mode>", "Filter by mode: raw or enhanced")
  .option("-t, --tags <tags>", "Filter by tags")
  .option("--since <date>", "After date (ISO)")
  .option("--until <date>", "Before date (ISO)")
  .option("--session <id>", "Filter by session ID")
  .option("--verbose", "Show more metadata per row without dumping full text")
  .action(async (query, opts) => {
    const parentOpts = program.opts();
    const pagination = resolvePagination(opts, parentOpts);

    const filter: RecordingFilter = {
      limit: pagination.limit,
      offset: pagination.offset,
      processing_mode: opts.mode,
      tags: parseCsvList(opts.tags),
      since: opts.since,
      until: opts.until,
      agent_id: parentOpts.agent,
      project_id: parentOpts.project,
      session_id: opts.session || parentOpts.session,
    };
    const store = getStore();
    const results = await store.searchRecordings(query, filter);

    if (parentOpts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    const total = await countStoreRecordings(store, withoutPagination({ ...filter, search: query }));

    printRecordingCollection("results", results, {
      total,
      offset: pagination.offset,
      limit: pagination.limit,
      verbose: Boolean(opts.verbose),
      capped: pagination.capped,
      empty: "No results.",
    });
  });

// ── delete ──────────────────────────────────────────────────────────────────

program
  .command("delete <id>")
  .description("Delete a recording")
  .action(async (id) => {
    const deleted = await getStore().deleteRecording(id);
    if (deleted) {
      console.log(chalk.green(`Deleted recording ${id}`));
    } else {
      console.error(chalk.red(`Recording not found: ${id}`));
      process.exit(1);
    }
  });

// ── stats ───────────────────────────────────────────────────────────────────

program
  .command("stats")
  .description("Show recording statistics")
  .action(async () => {
    const parentOpts = program.opts();

    const stats = await getStore().getRecordingStats();

    if (parentOpts.json) {
      console.log(JSON.stringify(stats, null, 2));
      return;
    }

    console.log(chalk.bold("Recording Statistics\n"));
    console.log(`  Total:      ${stats.total}`);
    console.log(`  Raw:        ${stats.raw}`);
    console.log(`  Enhanced:   ${stats.enhanced}`);
    console.log(
      `  Duration:   ${(stats.total_duration_ms / 1000).toFixed(1)}s`
    );
    const modelEntries = Object.entries(stats.by_model).sort((a, b) => b[1] - a[1]);
    if (modelEntries.length > 0) {
      console.log(`  By model:`);
      for (const [model, count] of modelEntries.slice(0, 10)) {
        console.log(`    ${truncateText(model, 80)}: ${count}`);
      }
      if (modelEntries.length > 10) {
        console.log(chalk.dim(`    ...${modelEntries.length - 10} more model(s). Use --json for the full breakdown.`));
      }
    }
  });

// ── agents ──────────────────────────────────────────────────────────────────

program
  .command("agents")
  .description("List registered agents")
  .option("-n, --limit <n>", "Max results")
  .option("--offset <n>", "Skip this many results")
  .option("--cursor <n>", "Pagination cursor alias for --offset")
  .option("--verbose", "Show descriptions and timestamps")
  .action(async (opts) => {
    const parentOpts = program.opts();
    const pagination = resolvePagination(opts, parentOpts);

    const agents = await getStore().listAgents();
    const page = parentOpts.json
      ? maybePageJson(agents, pagination, opts)
      : pageItems(agents, pagination);

    if (parentOpts.json) {
      console.log(JSON.stringify(page, null, 2));
      return;
    }

    if (page.length === 0) {
      console.log(chalk.dim(agents.length === 0 ? "No agents registered." : "No agents at this cursor."));
      if (agents.length > 0) console.log(chalk.dim("Try a lower --cursor."));
      return;
    }

    console.log(formatPageHeader("agents", page.length, agents.length, pagination.offset, pagination.limit));
    for (const a of page) {
      const line = `${chalk.cyan(truncateText(a.id, 80))} ${chalk.bold(truncateText(a.name, 80))} (${truncateText(a.role, 40)})`;
      if (opts.verbose) {
        console.log(`${line}\n  last seen: ${truncateText(a.last_seen_at, 40)}${a.description ? `\n  ${truncateText(a.description, 140)}` : ""}`);
      } else {
        console.log(`${line} — ${truncateText(relativeHint(a.last_seen_at), 40)}`);
      }
    }
    printPaginationHints(page.length, agents.length, pagination);
  });

// ── projects ────────────────────────────────────────────────────────────────

const projectCommand = program
  .command("project")
  .description("Manage registered projects");

projectCommand
  .command("register")
  .description("Register a project in the active Store")
  .requiredOption("--name <name>", "Project name")
  .requiredOption("--path <path>", "Stable project path or URI")
  .option("--description <description>", "Project description")
  .action(async (opts) => {
    const parentOpts = program.opts();
    const project = await getStore().registerProject(opts.name, opts.path, opts.description);
    if (parentOpts.json) {
      console.log(JSON.stringify(project, null, 2));
      return;
    }
    console.log(`${chalk.cyan(truncateText(project.id, 80))} ${chalk.bold(truncateText(project.name, 80))} — ${truncatePath(project.path, 120)}`);
  });

program
  .command("projects")
  .description("List registered projects")
  .option("-n, --limit <n>", "Max results")
  .option("--offset <n>", "Skip this many results")
  .option("--cursor <n>", "Pagination cursor alias for --offset")
  .option("--verbose", "Show descriptions and timestamps")
  .action(async (opts) => {
    const parentOpts = program.opts();
    const pagination = resolvePagination(opts, parentOpts);

    const projects = await getStore().listProjects();
    const page = parentOpts.json
      ? maybePageJson(projects, pagination, opts)
      : pageItems(projects, pagination);

    if (parentOpts.json) {
      console.log(JSON.stringify(page, null, 2));
      return;
    }

    if (page.length === 0) {
      console.log(chalk.dim(projects.length === 0 ? "No projects registered." : "No projects at this cursor."));
      if (projects.length > 0) console.log(chalk.dim("Try a lower --cursor."));
      return;
    }

    console.log(formatPageHeader("projects", page.length, projects.length, pagination.offset, pagination.limit));
    for (const p of page) {
      const line = `${chalk.cyan(truncateText(p.id, 8))} ${chalk.bold(truncateText(p.name, 80))}`;
      if (opts.verbose) {
        console.log(`${line}\n  path: ${truncatePath(p.path, 120)}\n  updated: ${truncateText(p.updated_at, 40)}${p.description ? `\n  ${truncateText(p.description, 140)}` : ""}`);
      } else {
        console.log(`${line} — ${truncatePath(p.path, 96)}`);
      }
    }
    printPaginationHints(page.length, projects.length, pagination);
  });

// ── init ────────────────────────────────────────────────────────────────────

program
  .command("init")
  .description("Initialize .recordings/ in current directory")
  .action(() => {
    const { mkdirSync, writeFileSync, existsSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");

    const dir = join(process.cwd(), ".recordings");
    const audioDir = join(dir, "audio");
    const configFile = join(dir, "config.json");

    mkdirSync(audioDir, { recursive: true });

    if (!existsSync(configFile)) {
      const defaultConf = {
        transcription_model: "gpt-4o-transcribe",
        realtime_session_model: "gpt-realtime",
        realtime_transcription_model: "gpt-realtime-whisper",
        enhancement_model: "gpt-4o",
        transcriber_model: "gpt-4o",
        language: "en",
        transcription_prompt: "",
        transcriber_prompt: "",
        post_processing_mode: "auto",
        auto_enhance: true,
      };
      writeFileSync(configFile, JSON.stringify(defaultConf, null, 2));
    }

    console.log(chalk.green("Initialized .recordings/ directory"));
    console.log(chalk.dim("  config: .recordings/config.json"));
    console.log(chalk.dim("  audio:  .recordings/audio/"));
    console.log(chalk.dim("  db:     .recordings/recordings.db"));
  });

// ── app ─────────────────────────────────────────────────────────────────────

const appCommand = program
  .command("app")
  .description("Manage the macOS app installed from this package");

appCommand
  .command("install")
  .description("Build and install Recordings.app from the installed package")
  .option("--mode <mode>", "Swift build mode: debug or release", "release")
  .action((opts: { mode: string }) => {
    const status = getMacOSAppStatus();
    if (!status.installer_available) {
      console.error(chalk.red(`App installer missing from package: ${status.installer_path}`));
      process.exit(1);
    }

    const result = spawnSync("bash", [status.installer_path, "--mode", opts.mode], {
      stdio: "inherit",
      env: process.env,
    });
    if (result.error) {
      console.error(chalk.red(result.error.message));
      process.exit(1);
    }
    process.exit(result.status ?? 1);
  });

appCommand
  .command("status")
  .description("Show installed Recordings.app status")
  .option("--verbose", "Show package paths, code hash, and log path")
  .action((opts: { verbose?: boolean }) => {
    const status = getMacOSAppStatus();
    if (program.opts().json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    console.log(chalk.bold("Recordings.app"));
    console.log(`Installed: ${status.installed ? "yes" : "no"}`);
    console.log(`Executable: ${status.executable ? "available" : "missing"}`);
    console.log(`Installer: ${status.installer_available ? "available" : "missing"}`);
    console.log(`Native sources: ${status.native_sources_available ? "available" : "missing"}`);
    console.log(`Legacy duplicates: ${status.legacy_install_paths.length}`);
    if (process.platform === "darwin") {
      console.log(`Microphone: ${status.microphone_permission}`);
      console.log(`Accessibility: ${status.accessibility_permission}`);
    }
    if (opts.verbose) {
      console.log(`Package: ${status.package_root}`);
      console.log(`Installed app: ${status.installed ? status.installed_app_path : "missing"}`);
      console.log(`Executable path: ${status.executable_path}`);
      for (const legacyPath of status.legacy_install_paths) {
        console.log(`Legacy app: ${legacyPath}`);
      }
      console.log(`Signing identifier: ${status.signing_identifier ?? "unavailable"}`);
      console.log(`Team identifier: ${status.team_identifier ?? "unavailable"}`);
      console.log(`Designated requirement: ${status.designated_requirement ?? "unavailable"}`);
      console.log(`Code hash: ${status.app_code_hash ?? "unavailable"}`);
      console.log(`Log: ${status.log_path}`);
    } else {
      console.log(chalk.dim("Use --verbose for paths/code hash/log, or --json for the full status object."));
    }
  });

appCommand
  .command("permissions")
  .description("Show macOS permission state for Recordings.app")
  .action(() => {
    const status = getMacOSAppStatus();
    const permissions = {
      platform: status.platform,
      bundle_id: "com.hasna.recordings",
      installed_app_path: status.installed_app_path,
      legacy_install_paths: status.legacy_install_paths,
      microphone: status.microphone_permission,
      accessibility: status.accessibility_permission,
      app_code_hash: status.app_code_hash,
      ad_hoc_signed: status.ad_hoc_signed,
      signing_identifier: status.signing_identifier,
      team_identifier: status.team_identifier,
      designated_requirement: status.designated_requirement,
      log_path: status.log_path,
    };
    if (program.opts().json) {
      console.log(JSON.stringify(permissions, null, 2));
      return;
    }
    console.log(`Microphone: ${permissions.microphone}`);
    console.log(`Accessibility: ${permissions.accessibility}`);
    console.log(`Log: ${permissions.log_path}`);
  });

appCommand
  .command("reset-permissions")
  .description("Reset macOS Microphone and Accessibility permissions for Recordings.app")
  .action(() => {
    if (process.platform !== "darwin") {
      console.error(chalk.red("Permission reset is only available on macOS"));
      process.exit(1);
    }
    resetMacOSPermissions();
  });

appCommand
  .command("request-permissions")
  .description("Open Recordings.app and trigger macOS Microphone and Accessibility permission prompts")
  .option("--reset", "Reset existing Microphone and Accessibility decisions before requesting")
  .action((opts: { reset?: boolean }) => {
    if (process.platform !== "darwin") {
      console.error(chalk.red("Permission prompts are only available on macOS"));
      process.exit(1);
    }

    const status = getMacOSAppStatus();
    if (!status.installed) {
      console.error(chalk.red("Recordings.app is not installed. Run: recordings app install"));
      process.exit(1);
    }

    if (opts.reset) {
      resetMacOSPermissions();
    }

    const result = spawnSync("open", [
      "-n",
      status.installed_app_path,
      "--args",
      "--request-permissions",
      "--open-permission-settings",
    ], { stdio: "inherit" });
    if (result.error) {
      console.error(chalk.red(result.error.message));
      process.exit(1);
    }
    process.exit(result.status ?? 1);
  });

appCommand
  .command("log")
  .description("Show the Recordings.app diagnostic log")
  .option("-n, --lines <lines>", "Number of lines to print", String(DEFAULT_LOG_LINES))
  .action((opts: { lines: string }) => {
    const status = getMacOSAppStatus();
    if (!existsSync(status.log_path)) {
      console.log("");
      return;
    }
    const lines = Math.max(1, parseInt(opts.lines, 10) || DEFAULT_LOG_LINES);
    const result = spawnSync("tail", ["-n", String(lines), status.log_path], {
      encoding: "utf8",
    });
    if (result.error) {
      console.error(chalk.red(result.error.message));
      process.exit(1);
    }
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  });

appCommand
  .command("open")
  .description("Open the installed Recordings.app")
  .action(() => {
    const status = getMacOSAppStatus();
    if (process.platform !== "darwin") {
      console.error(chalk.red("Recordings.app can only be opened on macOS"));
      process.exit(1);
    }
    if (!status.installed) {
      console.error(chalk.red("Recordings.app is not installed. Run: recordings app install"));
      process.exit(1);
    }

    const result = spawnSync("open", [status.installed_app_path], { stdio: "inherit" });
    if (result.error) {
      console.error(chalk.red(result.error.message));
      process.exit(1);
    }
    process.exit(result.status ?? 1);
  });

// ── check ───────────────────────────────────────────────────────────────────

program
  .command("check")
  .description("Check system dependencies (sox, API keys)")
  .action(async () => {
    const config = loadConfig();
    const parentOpts = program.opts();

    // Check recording deps
    const deps = await checkRecordingDeps();
    const enhKey = config.enhancement_api_key || config.openai_api_key;

    if (parentOpts.json) {
      console.log(JSON.stringify({
        recording: {
          available: deps.available,
          tool: deps.tool,
          message: deps.message,
        },
        openai_api_key_configured: Boolean(config.openai_api_key),
        enhancement_api_key_configured: Boolean(enhKey),
        enhancement_model: config.enhancement_model,
        transcriber_model: resolveTranscriberModel(config),
        realtime_session_model: config.realtime_session_model,
        realtime_transcription_model: config.realtime_transcription_model,
        post_processing_mode: config.post_processing_mode,
        transcription_prompt_configured: Boolean(config.transcription_prompt?.trim()),
        transcriber_prompt_configured: Boolean(config.transcriber_prompt?.trim()),
        config_warnings: config.config_warnings ?? [],
      }, null, 2));
      return;
    }

    if (deps.available) {
      console.log(chalk.green(`✓ Recording tool: ${deps.tool}`));
    } else {
      console.log(chalk.red(`✗ ${deps.message}`));
    }

    // Check API key
    if (config.openai_api_key) {
      console.log(
        chalk.green(`✓ OpenAI API key configured`)
      );
    } else {
      console.log(
        chalk.red(
          `✗ OpenAI API key not found. Set OPENAI_API_KEY env var or add to ~/.secrets`
        )
      );
    }

    // Check enhancement key
    if (enhKey) {
      console.log(
        chalk.green(`✓ Enhancement API key configured (model: ${resolveTranscriberModel(config)})`)
      );
    } else {
      console.log(
        chalk.yellow(`⚠ Enhancement API key not configured — enhancement disabled`)
      );
    }
  });

// ── listen ───────────────────────────────────────────────────────────────────

program
  .command("listen")
  .description("Push-to-talk mode — press Space to start/stop recording, Esc to quit")
  .option("-t, --tags <tags>", "Comma-separated tags for all recordings")
  .option("--no-enhance", "Skip AI enhancement")
  .option("--post-processing <mode>", "Post-processing mode: off, auto, or always")
  .option("--prompt <prompt>", "Vocabulary/context prompt for transcription")
  .option("--transcriber-prompt <prompt>", "Instructions for post-transcription cleanup")
  .option("--system-prompt <prompt>", "Alias for --transcriber-prompt")
  .option("--transcriber-model <model>", "Model for post-transcription cleanup")
  .option("-l, --language <lang>", "Language code")
  .option("--copy", "Copy output to clipboard")
  .option("--paste", "Copy output to clipboard AND paste into frontmost app")
  .action(async (opts) => {
    const config = loadConfig();
    ensureDataDir(config);
    if (opts.language) config.language = opts.language;
    if (opts.prompt !== undefined) config.transcription_prompt = opts.prompt;
    applyEnhancementOptions(config, opts);

    const deps = await checkRecordingDeps();
    if (!deps.available) {
      console.error(chalk.red(`Error: ${deps.message}`));
      process.exit(1);
    }

    if (!config.openai_api_key) {
      console.error(chalk.red("Error: OpenAI API key not configured."));
      process.exit(1);
    }

    const tags = opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : [];
    const parentOpts = program.opts();

    console.log(chalk.bold("\n  Recordings — Push-to-Talk\n"));
    console.log(`  ${chalk.yellow("Space")}  Start/stop recording`);
    console.log(`  ${chalk.yellow("Esc")}    Quit\n`);

    let recording = false;
    let audioPath: string | null = null;

    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const cleanup = () => {
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
    };

    process.stdin.on("data", async (key: string) => {
      // Esc
      if (key === "\u001b") {
        if (recording) {
          stopRecording();
        }
        cleanup();
        console.log(chalk.dim("\nBye."));
        process.exit(0);
      }

      // Ctrl+C
      if (key === "\u0003") {
        if (recording) {
          stopRecording();
        }
        cleanup();
        process.exit(0);
      }

      // Space
      if (key === " ") {
        if (!recording) {
          // Start recording
          try {
            audioPath = startRecording(config);
            recording = true;
            process.stdout.write(chalk.red("  ● Recording... ") + chalk.dim("(Space to stop)"));
          } catch (e) {
            console.error(chalk.red(`\n  Error: ${e instanceof Error ? e.message : e}`));
          }
        } else {
          // Stop recording
          stopRecording();
          recording = false;
          process.stdout.write("\r" + " ".repeat(60) + "\r");

          if (!audioPath) return;

          process.stdout.write(chalk.blue("  Transcribing..."));

          try {
            const transcription = await transcribeAudio(audioPath, config);
            const processed = await processText(transcription.text, config);

            const output = processed.mode === "enhanced" ? processed.text : transcription.text;

            // Save to DB
            await getStore().createRecording({
              audio_path: audioPath,
              raw_text: transcription.text,
              processed_text: processed.mode === "enhanced" ? processed.text : undefined,
              processing_mode: processed.mode,
              model_used: transcription.model,
              enhancement_model: processed.enhancement_model || undefined,
              duration_ms: transcription.duration_ms,
              language: transcription.language || undefined,
              tags,
              agent_id: parentOpts.agent || undefined,
              project_id: parentOpts.project || undefined,
              session_id: parentOpts.session || undefined,
              machine_id: currentMachineId(),
              metadata: buildTranscriptionMetadata(config, processed, {
                transcriptionPromptFromRequest: opts.prompt !== undefined,
                transcriberPromptFromRequest:
                  opts.transcriberPrompt !== undefined || opts.systemPrompt !== undefined,
              }),
            });

            // Clear line and show output
            process.stdout.write("\r" + " ".repeat(60) + "\r");
            const modeLabel = processed.mode === "enhanced"
              ? chalk.green("  [enhanced] ")
              : chalk.dim("  [raw] ");
            console.log(modeLabel + output);

            // Copy to clipboard / paste
            if (opts.copy || opts.paste) {
              try {
                const { execSync } = require("node:child_process") as typeof import("node:child_process");
                execSync("pbcopy", { input: output, stdio: ["pipe", "pipe", "pipe"] });
                if (opts.paste) {
                  // Small delay then Cmd+V via osascript
                  execSync(
                    `osascript -e 'delay 0.1' -e 'tell application "System Events" to keystroke "v" using command down'`,
                    { stdio: "pipe" }
                  );
                }
              } catch {
                // Clipboard not available
              }
            }

            console.log("");
          } catch (e) {
            process.stdout.write("\r" + " ".repeat(60) + "\r");
            console.error(chalk.red(`  Error: ${e instanceof Error ? e.message : e}\n`));
          }
          audioPath = null;
        }
      }
    });
  });

// ── shortcut ────────────────────────────────────────────────────────────────

program
  .command("shortcut")
  .description("Set up a global keyboard shortcut for recording (macOS)")
  .option("--raycast", "Generate Raycast script command")
  .option("--karabiner", "Set up Fn key via Karabiner-Elements")
  .option("--skhd", "Generate skhd hotkey config")
  .option("--hammerspoon", "Generate Hammerspoon config")
  .option("--script", "Just output the shell script path")
  .action((opts) => {
    const { writeFileSync, mkdirSync, chmodSync } = require("node:fs") as typeof import("node:fs");
    const { join: pathJoin } = require("node:path") as typeof import("node:path");
    const { homedir: getHome } = require("node:os") as typeof import("node:os");
    const home = getHome();

    const scriptDir = pathJoin(home, ".hasna", "recordings");
    mkdirSync(scriptDir, { recursive: true });

    const scriptPath = pathJoin(scriptDir, "record-toggle.sh");
    const pidFile = pathJoin(scriptDir, ".recording.pid");
    const recordingsBin = pathJoin(home, ".bun", "bin", "recordings");

    // Write the toggle script
    const script = `#!/bin/bash
# Toggle recording on/off. Run this from a global hotkey.
# Each press toggles: start recording -> stop + transcribe + copy to clipboard
set -e

PID_FILE="${pidFile}"
RECORDINGS="${recordingsBin}"

if [ -f "$PID_FILE" ]; then
  # Stop recording
  PID=$(cat "$PID_FILE")
  kill -INT "$PID" 2>/dev/null || true
  rm -f "$PID_FILE"

  # Find the most recent audio file
  AUDIO_DIR="${pathJoin(scriptDir, "audio")}"
  LATEST=$(ls -t "$AUDIO_DIR"/*.wav 2>/dev/null | head -1)

  if [ -n "$LATEST" ]; then
    # Transcribe and copy to clipboard
    OUTPUT=$("$RECORDINGS" transcribe "$LATEST" --json 2>/dev/null)
    TEXT=$(echo "$OUTPUT" | grep -o '"processed_text":"[^"]*"' | head -1 | cut -d'"' -f4)
    if [ -z "$TEXT" ]; then
      TEXT=$(echo "$OUTPUT" | grep -o '"raw_text":"[^"]*"' | head -1 | cut -d'"' -f4)
    fi
    if [ -n "$TEXT" ]; then
      echo -n "$TEXT" | pbcopy
      # Optional: paste into frontmost app
      # osascript -e 'delay 0.1' -e 'tell application "System Events" to keystroke "v" using command down'
    fi
  fi

  # Notification
  osascript -e 'display notification "Recording saved and copied to clipboard" with title "Recordings"' 2>/dev/null || true
else
  # Start recording in background
  mkdir -p "${pathJoin(scriptDir, "audio")}"
  rec -r 16000 -c 1 -b 16 "${pathJoin(scriptDir, "audio")}/recording-$(date +%Y%m%dT%H%M%S).wav" trim 0 300 &
  echo $! > "$PID_FILE"

  # Notification
  osascript -e 'display notification "Recording started..." with title "Recordings"' 2>/dev/null || true
fi
`;
    writeFileSync(scriptPath, script, "utf-8");
    chmodSync(scriptPath, 0o755);

    if (opts.karabiner) {
      const karabinerDir = pathJoin(home, ".config", "karabiner", "assets", "complex_modifications");
      mkdirSync(karabinerDir, { recursive: true });

      const rule = {
        title: "Recordings — Fn key to toggle recording",
        rules: [
          {
            description: "Fn key toggles speech recording (open-recordings)",
            manipulators: [
              {
                type: "basic",
                from: {
                  key_code: "fn",
                  modifiers: { optional: ["any"] },
                },
                to: [
                  {
                    shell_command: scriptPath,
                  },
                ],
              },
            ],
          },
        ],
      };

      const karabinerPath = pathJoin(karabinerDir, "recordings-fn.json");
      writeFileSync(karabinerPath, JSON.stringify(rule, null, 2) + "\n", "utf-8");

      console.log(chalk.green("Karabiner-Elements rule created!"));
      console.log(chalk.dim(`  ${karabinerPath}\n`));
      console.log("To activate:");
      console.log("  1. Open Karabiner-Elements");
      console.log("  2. Go to Complex Modifications tab");
      console.log("  3. Click Add Predefined Rule");
      console.log('  4. Enable "Fn key toggles speech recording"');
      console.log(chalk.dim("\n  Press Fn to start recording, Fn again to stop + copy to clipboard"));
      return;
    }

    if (opts.raycast) {
      const raycastDir = pathJoin(home, ".config", "raycast", "script-commands");
      mkdirSync(raycastDir, { recursive: true });
      const raycastScript = `#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Toggle Recording
# @raycast.mode silent
# @raycast.packageName Recordings

# Optional parameters:
# @raycast.icon 🎙️

${scriptPath}
`;
      const raycastPath = pathJoin(raycastDir, "toggle-recording.sh");
      writeFileSync(raycastPath, raycastScript, "utf-8");
      chmodSync(raycastPath, 0o755);
      console.log(chalk.green("Raycast script command created!"));
      console.log(chalk.dim(`  ${raycastPath}`));
      console.log(chalk.dim("  Open Raycast > Script Commands > reload to see it"));
      console.log(chalk.dim("  Then assign a hotkey in Raycast preferences"));
      return;
    }

    if (opts.skhd) {
      console.log(chalk.bold("Add to ~/.skhdrc:\n"));
      console.log(chalk.cyan(`  fn - space : ${scriptPath}`));
      console.log(chalk.dim("\n  Then reload: skhd --restart-service"));
      return;
    }

    if (opts.hammerspoon) {
      console.log(chalk.bold("Add to ~/.hammerspoon/init.lua:\n"));
      console.log(chalk.cyan(`  hs.hotkey.bind({"ctrl"}, "space", function()
    hs.execute("${scriptPath}")
  end)`));
      console.log(chalk.dim("\n  Then reload Hammerspoon config"));
      return;
    }

    // Default: show all options
    console.log(chalk.bold("Global shortcut script created:"));
    console.log(chalk.cyan(`  ${scriptPath}\n`));
    console.log("Bind it to a hotkey using any of these:\n");

    console.log(chalk.bold("  Karabiner-Elements") + chalk.dim(" (for Fn key specifically)"));
    console.log(`    brew install --cask karabiner-elements`);
    console.log(`    recordings shortcut --karabiner\n`);

    console.log(chalk.bold("  Raycast"));
    console.log(`    recordings shortcut --raycast\n`);

    console.log(chalk.bold("  skhd"));
    console.log(`    recordings shortcut --skhd\n`);

    console.log(chalk.bold("  Hammerspoon"));
    console.log(`    recordings shortcut --hammerspoon\n`);

    console.log(chalk.bold("  macOS Automator"));
    console.log(`    1. Open Automator > Quick Action`);
    console.log(`    2. Add "Run Shell Script" action`);
    console.log(`    3. Paste: ${scriptPath}`);
    console.log(`    4. Save as "Toggle Recording"`);
    console.log(`    5. System Settings > Keyboard > Shortcuts > Services`);
    console.log(`    6. Assign a shortcut to "Toggle Recording"\n`);

    console.log(chalk.bold("  Alfred"));
    console.log(`    Create a workflow with a Hotkey trigger → Run Script: ${scriptPath}\n`);
  });

// ── Transcription metadata ──────────────────────────────────────────────────

function buildTranscriptionMetadata(
  config: ReturnType<typeof loadConfig>,
  processed: Awaited<ReturnType<typeof processText>>,
  sources: {
    transcriptionPromptFromRequest?: boolean;
    transcriberPromptFromRequest?: boolean;
  } = {}
): Record<string, unknown> {
  const transcriptionPromptConfigured = Boolean(config.transcription_prompt?.trim());
  const transcriberPromptConfigured = Boolean(config.transcriber_prompt?.trim());

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
    transcriber_model: resolveTranscriberModel(config),
  };
}

async function readSaveTextInput(
  text: string | undefined,
  opts: { textFile?: string; stdin?: boolean }
): Promise<string> {
  const sourceCount = [
    text !== undefined,
    opts.textFile !== undefined,
    Boolean(opts.stdin),
  ].filter(Boolean).length;

  if (sourceCount !== 1) {
    throw new Error("Provide transcript text as an argument, --text-file, or --stdin");
  }

  let rawText: string;
  if (opts.textFile !== undefined) {
    rawText = readFileSync(opts.textFile, "utf8");
  } else if (opts.stdin) {
    rawText = await Bun.stdin.text();
  } else {
    rawText = text ?? "";
  }

  if (!rawText.trim()) {
    throw new Error("Transcript text is empty");
  }

  return rawText;
}

// ── Formatting helpers ──────────────────────────────────────────────────────

type PaginationOptions = {
  limit?: string;
  offset?: string;
  cursor?: string;
};

type ResolvedPagination = {
  limit: number;
  offset: number;
  capped: boolean;
};

function resolvePagination(
  opts: PaginationOptions,
  parentOpts: { json?: boolean },
  defaultLimit = DEFAULT_LIST_LIMIT
): ResolvedPagination {
  const parsedLimit = parseNonNegativeInt(opts.limit, defaultLimit);
  const requestedLimit = Math.min(Math.max(parsedLimit || defaultLimit, 1), 500);
  const offset = parseNonNegativeInt(opts.cursor ?? opts.offset, 0);
  const humanLimit = Math.min(requestedLimit, MAX_HUMAN_LIST_LIMIT);
  return {
    limit: parentOpts.json ? requestedLimit : humanLimit,
    offset,
    capped: !parentOpts.json && requestedLimit > humanLimit,
  };
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function parseCsvList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function withoutPagination(filter: RecordingFilter): RecordingFilter {
  const { limit: _limit, offset: _offset, ...rest } = filter;
  return rest;
}

function maybePageJson<T>(
  items: T[],
  pagination: ResolvedPagination,
  opts: PaginationOptions
): T[] {
  if (opts.limit === undefined && opts.offset === undefined && opts.cursor === undefined) {
    return items;
  }
  return pageItems(items, pagination);
}

function pageItems<T>(items: T[], pagination: ResolvedPagination): T[] {
  return items.slice(pagination.offset, pagination.offset + pagination.limit);
}

function formatPageHeader(
  label: string,
  shown: number,
  total: number,
  offset: number,
  limit: number
): string {
  const start = total === 0 ? 0 : offset + 1;
  const end = offset + shown;
  return chalk.bold(`${label}: showing ${shown} of ${total} (${start}-${end}, limit ${limit})\n`);
}

function printPaginationHints(
  shown: number,
  total: number,
  pagination: ResolvedPagination
): void {
  const next = pagination.offset + shown;
  if (pagination.capped) {
    console.log(chalk.dim(`Limit capped at ${pagination.limit} for terminal output; use --json for larger machine-readable exports.`));
  }
  if (next < total) {
    console.log(chalk.dim(`Next page: add --cursor ${next}`));
  }
}

function printRecordingCollection(
  label: string,
  recordings: Recording[],
  options: {
    total: number;
    offset: number;
    limit: number;
    verbose: boolean;
    capped: boolean;
    empty: string;
  }
): void {
  if (recordings.length === 0) {
    console.log(chalk.dim(options.empty));
    if (options.total > 0) {
      console.log(chalk.dim("Try a lower --cursor or remove filters."));
    }
    return;
  }

  const total = Math.max(options.total, options.offset + recordings.length);
  console.log(formatPageHeader(label, recordings.length, total, options.offset, options.limit));
  for (const recording of recordings) {
    console.log(options.verbose ? formatRecordingVerboseLine(recording) : formatRecordingLine(recording));
  }
  console.log("");
  printPaginationHints(recordings.length, total, {
    limit: options.limit,
    offset: options.offset,
    capped: options.capped,
  });
  console.log(chalk.dim("Details: recordings show <id> or inspect <id>. Use --verbose for metadata, --json for raw records."));
}

async function printRecordingDetail(id: string): Promise<void> {
  const parentOpts = program.opts();
  const recording = await getStore().getRecording(id);
  if (!recording) {
    console.error(chalk.red(`Recording not found: ${id}`));
    process.exitCode = 1;
    return;
  }

  if (parentOpts.json) {
    console.log(JSON.stringify(recording, null, 2));
    return;
  }

  console.log(formatRecordingDetail(recording));
}

function formatRecordingLine(r: Recording): string {
  const id = chalk.cyan(truncateText(r.id, 8));
  const mode =
    r.processing_mode === "enhanced"
      ? chalk.green("enhanced")
      : chalk.dim("raw");
  const text = truncateText(r.processed_text || r.raw_text, 100);
  const date = chalk.dim(truncateText(r.created_at, 16));
  const tags =
    r.tags.length > 0
      ? chalk.yellow(` [${summarizeTags(r.tags)}]`)
      : "";

  return `${id} ${mode} ${date}${tags}\n  ${text}`;
}

function formatRecordingVerboseLine(r: Recording): string {
  const lines = [formatRecordingLine(r)];
  const model = r.enhancement_model
    ? `${truncateText(r.model_used, 80)} -> ${truncateText(r.enhancement_model, 80)}`
    : truncateText(r.model_used, 80);
  lines.push(`  model: ${model}`);
  if (r.duration_ms) lines.push(`  duration: ${(r.duration_ms / 1000).toFixed(1)}s`);
  if (r.language) lines.push(`  language: ${truncateText(r.language, 20)}`);
  if (r.audio_path) lines.push(`  audio: ${truncatePath(r.audio_path, 120)}`);
  const scopes = [
    r.agent_id ? `agent=${truncateText(r.agent_id, 80)}` : null,
    r.project_id ? `project=${truncateText(r.project_id, 80)}` : null,
    r.session_id ? `session=${truncateText(r.session_id, 80)}` : null,
  ].filter(Boolean);
  if (scopes.length > 0) lines.push(`  scope: ${scopes.join(" ")}`);
  return lines.join("\n");
}

function formatRecordingDetail(r: Recording): string {
  const lines: string[] = [
    chalk.bold(`Recording ${truncateText(r.id, 8)}`),
    "",
    `  Mode:     ${r.processing_mode === "enhanced" ? chalk.green("enhanced") : chalk.dim("raw")}`,
    `  Model:    ${truncateText(r.model_used, 80)}`,
  ];

  if (r.enhancement_model) {
    lines.push(`  Enhanced: ${truncateText(r.enhancement_model, 80)}`);
  }
  if (r.duration_ms) {
    lines.push(`  Duration: ${(r.duration_ms / 1000).toFixed(1)}s`);
  }
  if (r.language) {
    lines.push(`  Language: ${truncateText(r.language, 20)}`);
  }
  if (r.audio_path) {
    lines.push(`  Audio:    ${truncatePath(r.audio_path, 240)}`);
  }
  if (r.tags.length > 0) {
    lines.push(`  Tags:     ${r.tags.map((tag) => truncateText(tag, 80)).join(", ")}`);
  }

  lines.push(`  Created:  ${truncateText(r.created_at, 40)}`);
  lines.push("");
  lines.push(chalk.bold("Raw text:"));
  lines.push(stripTerminalControls(r.raw_text));

  if (r.processed_text && r.processed_text !== r.raw_text) {
    lines.push("");
    lines.push(chalk.bold("Enhanced text:"));
    lines.push(stripTerminalControls(r.processed_text));
  }

  return lines.join("\n");
}

function truncateText(value: string, max: number): string {
  const normalized = sanitizeInline(value);
  const prefix: string[] = [];
  for (const point of normalized) {
    if (prefix.length === max) {
      return `${prefix.slice(0, Math.max(0, max - 3)).join("")}...`;
    }
    prefix.push(point);
  }
  return normalized;
}

function stripTerminalControls(value: string): string {
  return value
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g, "")
    .replace(/(?:\u001b[PX^_]|\u0090|\u0098|\u009e|\u009f)[\s\S]*?(?:\u001b\\|\u009c)/g, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function sanitizeInline(value: string): string {
  return stripTerminalControls(value).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function summarizeTags(tags: string[]): string {
  const shown = tags.slice(0, 3).map((tag) => truncateText(tag, 20));
  if (tags.length > shown.length) shown.push(`+${tags.length - shown.length}`);
  return shown.join(", ");
}

function truncatePath(value: string, max: number): string {
  const normalized = sanitizeInline(value);
  const keep = Math.max(8, max - 15);
  const tail: string[] = [];
  let length = 0;
  for (const point of normalized) {
    length += 1;
    if (tail.length === keep) tail.shift();
    tail.push(point);
  }
  return length <= max ? normalized : `...${tail.join("")}`;
}

function relativeHint(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ── mcp ─────────────────────────────────────────────────────────────────────

program
  .command("mcp")
  .description("Install recordings MCP server into Claude Code, Codex, or Gemini")
  .option("--claude", "Install into Claude Code (via `claude mcp add`)")
  .option("--codex", "Install into Codex (~/.codex/config.toml)")
  .option("--gemini", "Install into Gemini (~/.gemini/settings.json)")
  .option("--all", "Install into all supported agents")
  .option("--uninstall", "Remove recordings MCP from config")
  .action(async (opts: { claude?: boolean; codex?: boolean; gemini?: boolean; all?: boolean; uninstall?: boolean }) => {
    const { readFileSync, writeFileSync, existsSync: fileExists } = require("node:fs") as typeof import("node:fs");
    const { join: pathJoin } = require("node:path") as typeof import("node:path");
    const { homedir: getHome } = require("node:os") as typeof import("node:os");
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const home = getHome();

    const mcpCmd = process.argv[0]?.includes("bun")
      ? pathJoin(home, ".bun", "bin", "recordings-mcp")
      : "recordings-mcp";

    const targets = opts.all
      ? ["claude", "codex", "gemini"]
      : [
          opts.claude ? "claude" : null,
          opts.codex ? "codex" : null,
          opts.gemini ? "gemini" : null,
        ].filter(Boolean) as string[];

    if (targets.length === 0) {
      console.log(chalk.yellow("Specify a target: --claude, --codex, --gemini, or --all"));
      console.log(chalk.gray("Example: recordings mcp --all"));
      return;
    }

    const action = opts.uninstall ? "Removed from" : "Installed into";

    for (const target of targets) {
      try {
        // Claude Code: use `claude mcp add/remove` — stores in ~/.claude.json (user scope)
        if (target === "claude") {
          if (opts.uninstall) {
            execSync("claude mcp remove recordings", { stdio: "pipe" });
          } else {
            // Remove first if it exists, then add fresh
            try { execSync("claude mcp remove recordings", { stdio: "pipe" }); } catch { /* ignore if not found */ }
            execSync(
              `claude mcp add --transport stdio --scope user recordings -- ${mcpCmd} --stdio`,
              { stdio: "pipe" }
            );
          }
          console.log(chalk.green(`${action} Claude Code (user scope in ~/.claude.json)`));
        }

        if (target === "codex") {
          const configPath = pathJoin(home, ".codex", "config.toml");
          if (fileExists(configPath)) {
            const content = readFileSync(configPath, "utf-8");
            if (opts.uninstall) {
              // Remove the whole [mcp_servers.recordings] table (and subtables)
              // regardless of transport form (stdio command/args OR http url).
              const { content: next, removed } = removeCodexServerBlock(content, "recordings");
              writeFileSync(configPath, next, "utf-8");
              console.log(
                removed
                  ? chalk.green(`Removed from Codex: ${configPath}`)
                  : chalk.yellow(`Codex: no recordings MCP block found in ${configPath}`),
              );
            } else {
              // Authoritative install: replace any existing block with a fresh
              // stdio block so a stale http-transport block is converted, not
              // silently kept.
              const next = upsertCodexStdioBlock(content, "recordings", mcpCmd);
              writeFileSync(configPath, next, "utf-8");
              console.log(chalk.green(`Installed into Codex: ${configPath}`));
            }
          } else {
            console.log(chalk.yellow(`Codex config not found: ${configPath}`));
          }
        }

        if (target === "gemini") {
          const configPath = pathJoin(home, ".gemini", "settings.json");
          let config: Record<string, unknown> = {};
          if (fileExists(configPath)) {
            config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
          }
          const servers = (config["mcpServers"] || {}) as Record<string, unknown>;
          if (opts.uninstall) {
            delete servers["recordings"];
          } else {
            servers["recordings"] = { command: mcpCmd, args: ["--stdio"] };
          }
          config["mcpServers"] = servers;
          writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
          console.log(chalk.green(`${action} Gemini: ${configPath}`));
        }
      } catch (e) {
        console.error(chalk.red(`Failed for ${target}: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
  });

// ── remove/uninstall ─────────────────────────────────────────────────────────

program
  .command("remove <id>")
  .alias("rm")
  .alias("uninstall")
  .description("Delete a recording by ID")
  .action(async (id: string) => {
    const deleted = await getStore().deleteRecording(id);
    if (deleted) {
      console.log(chalk.green(`✓ Recording ${id} deleted`));
    } else {
      console.error(chalk.red(`Recording not found: ${id}`));
      process.exit(1);
    }
  });

// ── Feedback ────────────────────────────────────────────────────────────────

program
  .command("feedback <message>")
  .description("Send feedback")
  .option("--email <email>", "Contact email")
  .option("--category <category>", "Category: bug, feature, general")
  .action(async (message: string, opts: { email?: string; category?: string }) => {
    await getStore().saveFeedback({
      message,
      email: opts.email || null,
      category: opts.category || "general",
      version: VERSION,
    });
    console.log(chalk.green("Feedback saved. Thank you!"));
  });

type MacOSAppStatus = {
  platform: string;
  package_root: string;
  installer_path: string;
  installer_available: boolean;
  native_sources_path: string;
  native_sources_available: boolean;
  installed_app_path: string;
  legacy_install_paths: string[];
  installed: boolean;
  executable_path: string;
  executable: boolean;
  app_code_hash: string | null;
  ad_hoc_signed: boolean;
  signing_identifier: string | null;
  team_identifier: string | null;
  designated_requirement: string | null;
  signature_authorities: string[];
  microphone_permission: string;
  accessibility_permission: string;
  log_path: string;
};

function getMacOSAppStatus(): MacOSAppStatus {
  const packageRoot = findPackageRoot();
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const installedAppPath = pathJoin(home, "Applications", "Recordings.app");
  const executablePath = pathJoin(installedAppPath, "Contents", "MacOS", "Recordings");
  const logPath = pathJoin(home, ".hasna", "recordings", "Recordings.log");
  const installerPath = pathJoin(packageRoot, "scripts", "install_macos_app.sh");
  const nativeSourcesPath = pathJoin(packageRoot, "src", "native", "Recordings");
  const signingInfo = getCodeSigningInfo(installedAppPath);
  const legacyInstallPaths = findLegacyMacOSAppPaths(home, installedAppPath);
  const permissionStatus = legacyInstallPaths.length > 0
    ? "ambiguous_multiple_installations"
    : null;

  return {
    platform: process.platform,
    package_root: packageRoot,
    installer_path: installerPath,
    installer_available: existsSync(installerPath),
    native_sources_path: nativeSourcesPath,
    native_sources_available: existsSync(pathJoin(nativeSourcesPath, "Package.swift")),
    installed_app_path: installedAppPath,
    legacy_install_paths: legacyInstallPaths,
    installed: existsSync(installedAppPath),
    executable_path: executablePath,
    executable: existsSync(executablePath),
    app_code_hash: signingInfo.cdHash,
    ad_hoc_signed: signingInfo.adHoc,
    signing_identifier: signingInfo.identifier,
    team_identifier: signingInfo.teamIdentifier,
    designated_requirement: signingInfo.designatedRequirement,
    signature_authorities: signingInfo.authorities,
    microphone_permission: permissionStatus ?? getTccPermission("kTCCServiceMicrophone", home),
    accessibility_permission: permissionStatus ?? getTccPermission("kTCCServiceAccessibility", home),
    log_path: logPath,
  };
}

function findLegacyMacOSAppPaths(home: string, canonicalPath: string): string[] {
  const candidates = [
    pathJoin(home, ".hasna", "recordings", "Recordings.app"),
    pathJoin("/", "Applications", "Recordings.app"),
  ];
  const userApplications = pathJoin(home, "Applications");
  if (existsSync(userApplications)) {
    for (const entry of readdirSync(userApplications, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("Recordings.app.")) {
        candidates.push(pathJoin(userApplications, entry.name));
      }
    }
  }
  return [...new Set(candidates)]
    .filter((candidate) => candidate !== canonicalPath && existsSync(candidate))
    .sort();
}

function resetMacOSPermissions(): void {
  const services = ["Microphone", "Accessibility"];
  for (const service of services) {
    const result = spawnSync("tccutil", ["reset", service, "com.hasna.recordings"], {
      stdio: "inherit",
    });
    if (result.error) {
      console.error(chalk.red(result.error.message));
      process.exit(1);
    }
  }
}

function getCodeSigningInfo(appPath: string): {
  cdHash: string | null;
  adHoc: boolean;
  identifier: string | null;
  teamIdentifier: string | null;
  designatedRequirement: string | null;
  authorities: string[];
} {
  if (process.platform !== "darwin" || !existsSync(appPath)) {
    return {
      cdHash: null,
      adHoc: false,
      identifier: null,
      teamIdentifier: null,
      designatedRequirement: null,
      authorities: [],
    };
  }
  const result = spawnSync("codesign", ["-d", "-r-", "--verbose=4", appPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const cdHash = output.match(/^CDHash=([a-fA-F0-9]+)/m)?.[1]?.toLowerCase() ?? null;
  const adHoc = /Signature=adhoc/.test(output);
  const identifier = output.match(/^Identifier=(.+)$/m)?.[1]?.trim() ?? null;
  const teamIdentifier = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() ?? null;
  const designatedRequirement = output.match(/^designated => (.+)$/m)?.[1]?.trim() ?? null;
  const authorities = [...output.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1]!.trim());
  return { cdHash, adHoc, identifier, teamIdentifier, designatedRequirement, authorities };
}

function getTccPermission(service: string, home: string): string {
  if (process.platform !== "darwin") return "unsupported";

  const dbPaths = [
    pathJoin(home, "Library", "Application Support", "com.apple.TCC", "TCC.db"),
    pathJoin("/", "Library", "Application Support", "com.apple.TCC", "TCC.db"),
  ];
  const sql =
    "select auth_value from access where service = '" +
    service.replace(/'/g, "''") +
    "' and client = 'com.hasna.recordings' order by last_modified desc limit 1;";

  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) continue;
    const result = spawnSync("sqlite3", [dbPath, sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const value = result.stdout.trim();
    if (!value) continue;
    return `${tccAuthValueLabel(value)}_identity_unverified`;
  }

  return "not_determined";
}

function tccAuthValueLabel(value: string): string {
  switch (value) {
    case "0":
      return "denied";
    case "1":
      return "unknown";
    case "2":
      return "allowed";
    case "3":
      return "limited";
    default:
      return `unknown(${value})`;
  }
}

function findPackageRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));

  while (true) {
    const packagePath = pathJoin(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: string };
        if (pkg.name === "@hasna/recordings") {
          return current;
        }
      } catch {
        // Keep walking upward.
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return process.cwd();
    }
    current = parent;
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

program.parseAsync().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: ${msg}`);
  process.exit(1);
});
