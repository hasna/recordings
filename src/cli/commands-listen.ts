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
import { buildTranscriptionMetadata } from "./formatting.js";

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


