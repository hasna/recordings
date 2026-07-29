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
import { buildTranscriptionMetadata, readSaveTextInput } from "./formatting.js";

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
  .option("--transcription-model <model>", "Model for bounded audio transcription")
  .option("--transcriber-model <model>", "Model for post-transcription cleanup")
  .option("--enhancement-model <model>", "Enhancement model fallback")
  .option("--enhance-triggers-json <json>", "Frozen JSON string array of enhancement triggers")
  .option("--keyword-transforms-json <json>", "Frozen JSON string map of keyword transforms")
  .option("-l, --language <lang>", "Language code (e.g. en, es, fr)")
  .option("--recording-id <id>", "Stable recording ID for idempotent retries")
  .action(async (file, opts) => {
    const recordingId = recordingCreateIdentity({
      id: opts.recordingId,
      raw_text: "",
    }).input.id;
    const config = loadConfig();
    ensureDataDir(config);
    if (opts.language) config.language = opts.language;
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
      id: recordingId,
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
    }, recordingId);

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
  .option("--transcription-model <model>", "Model for bounded audio transcription")
  .option("--transcriber-model <model>", "Model for post-transcription cleanup")
  .option("--enhancement-model <model>", "Enhancement model fallback")
  .option("--enhance-triggers-json <json>", "Frozen JSON string array of enhancement triggers")
  .option("--keyword-transforms-json <json>", "Frozen JSON string map of keyword transforms")
  .option("--recording-id <id>", "Stable recording ID for idempotent retries")
  .action(async (text: string | undefined, opts) => {
    const recordingId = recordingCreateIdentity({
      id: opts.recordingId,
      raw_text: "",
    }).input.id;
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
      id: recordingId,
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
    }, recordingId);

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
  .option("--prompt <prompt>", "Frozen transcription vocabulary/context prompt")
  .option("--transcriber-prompt <prompt>", "Frozen post-transcription instructions")
  .option("--system-prompt <prompt>", "Alias for --transcriber-prompt")
  .option("--post-processing <mode>", "Frozen post-processing mode")
  .option("--language <lang>", "Frozen transcription language")
  .option("--transcription-model <model>", "Frozen transcription model")
  .option("--transcriber-model <model>", "Frozen rewrite model")
  .option("--enhancement-model <model>", "Frozen enhancement fallback model")
  .option("--enhance-triggers-json <json>", "Frozen JSON string array of enhancement triggers")
  .option("--keyword-transforms-json <json>", "Frozen JSON string map of keyword transforms")
  .action(async (text, opts) => {
    const config = loadConfig();
    if (opts.language !== undefined) config.language = opts.language;
    if (opts.prompt !== undefined) config.transcription_prompt = opts.prompt;
    applyEnhancementOptions(config, opts);
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


