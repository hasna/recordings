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

import { DEFAULT_LIST_LIMIT, MAX_HUMAN_LIST_LIMIT, program } from "./command-context.js";

// ── Transcription metadata ──────────────────────────────────────────────────

export function buildTranscriptionMetadata(
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

export async function readSaveTextInput(
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

export type PaginationOptions = {
  limit?: string;
  offset?: string;
  cursor?: string;
};

export type ResolvedPagination = {
  limit: number;
  offset: number;
  capped: boolean;
};

export function resolvePagination(
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

export function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function parseCsvList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

export function withoutPagination(filter: RecordingFilter): RecordingFilter {
  const { limit: _limit, offset: _offset, ...rest } = filter;
  return rest;
}

export function maybePageJson<T>(
  items: T[],
  pagination: ResolvedPagination,
  opts: PaginationOptions
): T[] {
  if (opts.limit === undefined && opts.offset === undefined && opts.cursor === undefined) {
    return items;
  }
  return pageItems(items, pagination);
}

export function pageItems<T>(items: T[], pagination: ResolvedPagination): T[] {
  return items.slice(pagination.offset, pagination.offset + pagination.limit);
}

export function formatPageHeader(
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

export function printPaginationHints(
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

export function printRecordingCollection(
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

export async function printRecordingDetail(id: string): Promise<void> {
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

export function formatRecordingLine(r: Recording): string {
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

export function formatRecordingVerboseLine(r: Recording): string {
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

export function formatRecordingDetail(r: Recording): string {
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

export function truncateText(value: string, max: number): string {
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

export function stripTerminalControls(value: string): string {
  return value
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g, "")
    .replace(/(?:\u001b[PX^_]|\u0090|\u0098|\u009e|\u009f)[\s\S]*?(?:\u001b\\|\u009c)/g, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

export function sanitizeInline(value: string): string {
  return stripTerminalControls(value).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

export function summarizeTags(tags: string[]): string {
  const shown = tags.slice(0, 3).map((tag) => truncateText(tag, 20));
  if (tags.length > shown.length) shown.push(`+${tags.length - shown.length}`);
  return shown.join(", ");
}

export function truncatePath(value: string, max: number): string {
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

export function relativeHint(value: string): string {
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


