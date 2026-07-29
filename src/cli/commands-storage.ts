import { Command } from "commander";
import { registerEventsCommands } from "@hasna/events/commander";
import chalk from "chalk";
import { spawnSync } from "child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "fs";
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
import {
  transcribeAudio,
  transcribeAudioStream,
  verifyTranscriptionCredential,
  type CredentialProbeResult,
} from "../lib/transcriber.js";
import {
  probeMicrophoneCapture,
  captureProbeSubject,
  microphoneGrantInstruction,
  classifyPermissionState,
  // RECORDINGS_BUNDLE_IDENTIFIER is imported from ./macos-permissions.js below, which is the
  // ruled canonical name. capture-probe.js re-exports the same symbol from lib/macos-bundle.ts;
  // importing it from both is a duplicate identifier, not a second constant.
  DEFAULT_PROBE_SECONDS,
  MAX_PROBE_SECONDS,
  TCC_UNREADABLE_STATE,
  type CaptureProbeResult,
} from "../lib/capture-probe.js";
import {
  describeActiveStore,
  localStoreIsBehindSchema,
  probeRecordingPersistence,
  renderPersistenceMarker,
  type PersistenceProbeResult,
} from "../lib/persistence-probe.js";
import { enhanceText, processText, resolveTranscriberModel } from "../lib/enhancer.js";
import type { Recording, RecordingFilter } from "../types/index.js";
import { VERSION } from "../version.js";
import { applyEnhancementOptions } from "./options.js";
import { removeCodexServerBlock, upsertCodexStdioBlock } from "./mcp-config.js";
import {
  describeTccAuthorizationSubject,
  RECORDINGS_BUNDLE_IDENTIFIER,
  resolveTccGrant,
  runMacOSPermissionRequest,
  type TccGrantDurability,
  type TccGrantReport,
} from "./macos-permissions.js";
// Blocker 3 resolved here: `RECORDINGS_BUNDLE_ID` is deliberately NOT imported from
// `macos-shortcut.js`. It was a second definition of `RECORDINGS_BUNDLE_IDENTIFIER`, which this
// branch could not depend on before because the constant arrives with #24 — importing it then
// would have left the branch uncompilable rather than merely duplicated. That base now exists, so
// the TODO(rebase) is discharged rather than carried.
import {
  DEFAULT_TOGGLE_RECORDING_CHORD,
  ShortcutParseError,
  TOGGLE_RECORDING_DEFAULTS_KEY,
  TRIGGER_DEFAULTS_EXECUTABLE,
  TRIGGER_GRANT_REQUIREMENTS,
  USE_FN_KEY_DEFAULTS_KEY,
  formatShortcut,
  listBindableKeys,
  parseShortcutChord,
  readTriggerState,
  runningAppBundlePaths,
  writeShortcut,
  writeUseFnKey,
} from "./macos-shortcut.js";
import {
  describeTriggerPickup,
  probeTriggerDiagnostics,
  type TriggerDiagnosis,
} from "./trigger-probe.js";
import { currentMachineId } from "../lib/machine.js";
import { recordingCreateIdentity } from "../lib/recording-create-identity.js";
import {
  createInstallerEnvironment,
  resolveInstallBunExecutable,
} from "../lib/bun-runtime.js";
import {
  assertExpectedReleaseHostname,
  assertReleaseOnlyOptions,
  parseLaunchTimeout,
  prepareReleaseInstallInputs,
} from "../lib/release-install-policy.js";

import { program } from "./command-context.js";
import { formatPageHeader, maybePageJson, pageItems, parseCsvList, printPaginationHints, printRecordingCollection, printRecordingDetail, relativeHint, resolvePagination, truncatePath, truncateText, withoutPagination } from "./formatting.js";

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

export const projectCommand = program
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


