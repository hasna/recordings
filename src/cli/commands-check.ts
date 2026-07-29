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
import { getMacOSAppStatus } from "./app-status.js";

// ── check ───────────────────────────────────────────────────────────────────

program
  .command("check")
  .description(
    "Check system dependencies (sox, API keys) and macOS capture permissions. " +
      "Use --probe to exercise the microphone and credential for real."
  )
  .option(
    "--probe",
    "Prove capability instead of reporting presence: record a short sample and assert signal, and make one authenticated API request"
  )
  .option(
    "--probe-seconds <seconds>",
    `Length of the capture probe in seconds (1-${MAX_PROBE_SECONDS})`,
    String(DEFAULT_PROBE_SECONDS)
  )
  .option(
    "--probe-store-write",
    "Allow the persistence probe to write a marker recording to a SHARED API store. Off by default: that store is production for every machine pointed at it"
  )
  .action(async (opts) => {
    const config = loadConfig();
    const parentOpts = program.opts();

    // Check recording deps
    const deps = await checkRecordingDeps();
    const enhKey = config.enhancement_api_key || config.openai_api_key;
    // Two distinct roles with distinct models AND distinct keys. Probing one
    // with the other's credential produces a red tick on a working machine, and
    // a green one on a machine whose transcription model is unavailable.
    const transcriberModel = resolveTranscriberModel(config);
    const transcriptionModel = config.transcription_model;

    // macOS capture permissions are part of "can this machine record at all".
    // Omitting them is why a fully-green `check` could coexist with an app that
    // had no Microphone grant and captured nothing but silence.
    const macStatus = process.platform === "darwin" ? getMacOSAppStatus() : null;

    // And so is the trigger. A machine that can record, holds every grant and has a working
    // credential still dictates nothing if no key starts a recording — which is exactly the
    // state the owner's machine was in for days while this command reported green, because
    // nothing here had ever looked at the trigger. Both reads are cheap: two `defaults` reads
    // of the app's own domain plus a bounded tail of its log. Deliberately NOT the running-
    // bundle scan, which costs ~11.6 s.
    const trigger = probeTriggerDiagnostics({
      accessibilityPermission: macStatus?.accessibility_permission ?? null,
      appLogPath: macStatus?.log_path ?? null,
    });

    // A transcript only counts as recorded once it is stored, and this package
    // has two stores behind one interface. Which one is live is decided by env
    // vars whose mere presence flips the transport, so `check` has to name it:
    // auditing the wrong store is what made two separate reviews conclude that
    // persistence had broken when it had only moved.
    const activeStore = describeActiveStore(config);
    // Sampled here, before any probe runs, so it reflects the store as found.
    const localStoreWasLegacy = localStoreIsBehindSchema(config.db_path);

    let capture: CaptureProbeResult | null = null;
    let credential: CredentialProbeResult | null = null;
    let enhancementCredential: CredentialProbeResult | null = null;
    let persistence: PersistenceProbeResult | null = null;

    if (opts.probe) {
      const parsedSeconds = Number.parseInt(String(opts.probeSeconds), 10);
      // Bounded: an unbounded --probe-seconds blocked the command for as long as
      // the operator mistyped, with no output.
      const seconds = Number.isFinite(parsedSeconds) && parsedSeconds > 0
        ? Math.min(parsedSeconds, MAX_PROBE_SECONDS)
        : DEFAULT_PROBE_SECONDS;

      capture = deps.available
        ? probeMicrophoneCapture(config, { seconds })
        : {
            ok: false,
            tool: null,
            seconds,
            samples: 0,
            peak: 0,
            // The recording tool is not even installed, so nothing was captured and no amplitude
            // was measured. `true` here would report digital silence for a probe that never ran.
            silent: null,
            message: deps.message,
          };
      credential = await verifyTranscriptionCredential(config, transcriptionModel, {
        apiKey: config.openai_api_key,
        role: "transcription",
      });
      enhancementCredential = enhKey
        ? await verifyTranscriptionCredential(config, transcriberModel, {
            apiKey: enhKey,
            role: "enhancement",
          })
        : null;
      persistence = await probeRecordingPersistence({
        allowRemoteWrite: Boolean(opts.probeStoreWrite),
        allowLocalMigration: Boolean(opts.probeStoreWrite),
        localStoreExistedBefore: activeStore.local_db_present,
        // Read before anything in this command could have created the file.
        localStoreIsLegacy: localStoreWasLegacy,
      });
    }

    // `persistence.outcome === "failed"`, NOT `!persistence.ok`. `ok` is now false for a skip as
    // well as for a failure — a deliberate refusal to write to a production store must not turn
    // `check --probe` red, but it must also not be reported as a pass. The exit code answers "did
    // anything actively fail"; the rendered marker answers "was it proved".
    const probeFailed = Boolean(
      opts.probe &&
        ((capture && !capture.ok) ||
          (credential && !credential.ok) ||
          (enhancementCredential && !enhancementCredential.ok) ||
          (persistence && persistence.outcome === "failed"))
    );

    // Extends the existing exit contract rather than inventing a second one: this command
    // already answers "did anything actively fail" in its exit code, and a machine on which no
    // trigger can fire has actively failed. It holds without `--probe` because it needs no
    // probe — it is a storage read, and the silence it replaces was loudest for the operator
    // who runs bare `check` first. `can_fire` is false only when EVERY trigger is a definite
    // no; anything undecidable is a warning and keeps the exit code at 0.
    const triggerFailed = trigger !== null && !trigger.can_fire;

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
        transcriber_model: transcriberModel,
        realtime_session_model: config.realtime_session_model,
        realtime_transcription_model: config.realtime_transcription_model,
        post_processing_mode: config.post_processing_mode,
        transcription_prompt_configured: Boolean(config.transcription_prompt?.trim()),
        transcriber_prompt_configured: Boolean(config.transcriber_prompt?.trim()),
        config_warnings: config.config_warnings ?? [],
        microphone_permission: macStatus?.microphone_permission ?? "unsupported",
        accessibility_permission: macStatus?.accessibility_permission ?? "unsupported",
        active_store: activeStore,
        capture_probe: capture,
        capture_probe_subject: captureProbeSubject(),
        microphone_grant_instruction: macStatus
          ? microphoneGrantInstruction({
              installedAppPath: macStatus.installed_app_path,
              otherAppPaths: macStatus.legacy_install_paths,
              requestState: classifyPermissionState(macStatus.microphone_permission),
            })
          : null,
        credential_probe: credential,
        enhancement_credential_probe: enhancementCredential,
        persistence_probe: persistence,
        // Additive: null on any machine with no app UserDefaults domain to read, exactly as
        // `capture_probe` is null when no probe ran. No existing key changes name or meaning.
        trigger,
      }, null, 2));
      if (probeFailed || triggerFailed) process.exitCode = 1;
      return;
    }

    if (deps.available) {
      console.log(chalk.green(`✓ Recording tool: ${deps.tool}`));
    } else {
      console.log(chalk.red(`✗ ${deps.message}`));
    }

    // Key presence is NOT key validity. Say which one this line means, so the
    // reader does not take it as proof the credential works.
    if (config.openai_api_key) {
      console.log(
        chalk.green(`✓ OpenAI API key present`) +
          chalk.dim(opts.probe ? "" : " (presence only — run 'recordings check --probe' to verify it is accepted)")
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
        chalk.green(`✓ Enhancement API key present (model: ${transcriberModel})`) +
          chalk.dim(opts.probe ? "" : " (presence only — 'recordings check --probe' verifies it is accepted)")
      );
    } else {
      console.log(
        chalk.yellow(`⚠ Enhancement API key not configured — enhancement disabled`)
      );
    }

    // Where a transcript will actually land. Named unconditionally: the failure
    // this prevents is a human reading the wrong dataset, which no probe catches.
    console.log(
      chalk.green("✓") +
        ` Active store: ${activeStore.transport}` +
        (activeStore.base_url ? ` → ${activeStore.base_url}` : ` → ${activeStore.local_db_path}`) +
        chalk.dim(` (selected by ${activeStore.mode_source})`)
    );
    if (activeStore.divergent) {
      console.log(
        chalk.yellow("⚠") +
          ` Two datasets present: ${activeStore.local_db_recordings} recordings sit in ` +
          `${activeStore.local_db_path}, which is NOT the live store.`
      );
    }
    if (activeStore.warning) {
      console.log(chalk.dim(`  ${activeStore.warning}`));
    }

    if (macStatus) {
      const micState = macStatus.microphone_permission;
      // `startsWith("allowed")` covers exactly two of #24's states — `allowed` (stored
      // requirement re-validated against the installed bundle) and `allowed_identity_unverified`
      // (row says allowed, binding undecidable). It deliberately does NOT cover
      // `stale_allowed_for_previous_app_build` or `unverified_no_installed_bundle`, which #24
      // named so that a `grep allowed` or a human skim cannot read them as a pass.
      const micOk = micState.startsWith("allowed");
      const micVerified = micState === "allowed";
      const micStaleGrant = micState === "stale_allowed_for_previous_app_build";
      const micUnreadable = micState === TCC_UNREADABLE_STATE;
      // Three outcomes, three markers. A refused database read is not a denial,
      // and rendering it red-with-instructions told operators to grant a
      // permission that was already granted.
      console.log(
        (micOk ? chalk.green("✓") : micUnreadable ? chalk.yellow("?") : chalk.red("✗")) +
          ` Microphone permission: ${micState}`
      );
      if (micOk) {
        // Rebase note (#24 x #25): this note used to be unconditional for any `allowed*` state
        // and asserted the requirement "was NOT verified". Under #24 that is false for the
        // `allowed` state, which reaches this branch precisely BECAUSE codesign re-validated the
        // grant's stored requirement against the installed bundle. Printing "not verified" over
        // a verified result is the same class of false statement this queue exists to remove, so
        // the two cases now say what actually happened.
        console.log(
          chalk.dim(
            micVerified
              ? `  Note: this is the TCC row for bundle id ${RECORDINGS_BUNDLE_IDENTIFIER}, and its ` +
                  "stored code-signing requirement still validates against the installed bundle — " +
                  "so the grant binds to the app that is installed, not to a previous build."
              : `  Note: this is the TCC row for bundle id ${RECORDINGS_BUNDLE_IDENTIFIER}. The row's ` +
                  "code-signing requirement was NOT verified against the installed bundle, so a " +
                  "bundle re-signed with a different identity can still be denied at runtime. " +
                  "Confirm in the app's log."
          )
        );
      }
      if (micStaleGrant) {
        // A grant exists and reads "allowed", and it is dead: codesign says the stored
        // requirement does not match the installed bundle, so macOS will refuse at runtime while
        // System Settings still shows the toggle on. Without this line the operator sees a red
        // cross plus "grant it" instructions and flips a switch that is already flipped.
        console.log(
          chalk.dim(
            "  The TCC row says allowed, but its stored code-signing requirement does NOT match " +
              "the installed bundle — the grant belongs to a previous build and macOS will deny " +
              "at runtime. Toggling it in System Settings will not fix it; the row must be reset " +
              "(`recordings app reset-permissions`) and re-granted so it binds to the bundle " +
              "that is installed now."
          )
        );
      }
      if (micUnreadable) {
        console.log(
          chalk.dim(
            "  Could not read the TCC database. This is NOT a denial and NOT proof the app never " +
              "asked. Reading it needs Full Disk Access, which is held by the session's " +
              "RESPONSIBLE process and inherited by its children — not granted per-tool: on " +
              "a fleet Mac `bun` is explicitly denied and still reads the database over SSH, " +
              "because it inherits sshd's grant. So re-run from a plain ssh shell rather than " +
              "granting Full Disk Access to tmux or bun, and not under sudo, which changes the " +
              "responsible process. A missing sqlite3, a locked database or a corrupt file " +
              "produce this same state, so the cause is not established either."
          )
        );
      }
      if (!micOk && !micUnreadable) {
        console.log(
          chalk.dim(
            "  Recordings.app cannot capture audio without this. macOS does not error when it is " +
              "missing — it delivers silent audio. This grant CANNOT be set remotely; it needs a " +
              "human at the keyboard:"
          )
        );
        const instruction = microphoneGrantInstruction({
          installedAppPath: macStatus.installed_app_path,
          otherAppPaths: macStatus.legacy_install_paths,
          requestState: classifyPermissionState(macStatus.microphone_permission),
        });
        for (const [index, step] of instruction.steps.entries()) {
          console.log(chalk.dim(`  ${index + 1}. ${step}`));
        }
      }
      console.log(
        (macStatus.accessibility_permission.startsWith("allowed")
          ? chalk.green("✓")
          : chalk.yellow("⚠")) +
          ` Accessibility permission: ${macStatus.accessibility_permission}`
      );
    }

    if (trigger) reportTriggerDiagnosis(trigger);

    if (capture) {
      console.log(
        (capture.ok ? chalk.green("✓") : chalk.red("✗")) +
          ` Microphone capture probe: ${capture.message}`
      );
      // Whose grant this exercised. Without it a green tick here reads as
      // "the app can record", which it never proves.
      const subject = captureProbeSubject();
      console.log(
        chalk.dim(`  subject: ${subject.note}`) +
          (subject.subject_known ? "" : chalk.yellow(" [subject unidentified — inconclusive]"))
      );
    }
    if (credential) {
      console.log(
        (credential.ok ? chalk.green("✓") : chalk.red("✗")) +
          ` Transcription credential (${credential.model}): ${credential.message}`
      );
    }
    if (enhancementCredential) {
      console.log(
        (enhancementCredential.ok ? chalk.green("✓") : chalk.red("✗")) +
          ` Enhancement credential (${enhancementCredential.model}): ${enhancementCredential.message}`
      );
    }
    if (persistence) {
      // Three states, three markers. A green ✓ on the word SKIPPED is what made this check report
      // PASS while writing, reading and deleting nothing — and on a machine pointed at a shared
      // API store that was the DEFAULT path, so the round-trip was never proved there.
      //
      // The mapping lives in the lib beside the outcome it renders, because as an inline ternary
      // here it was unreachable from any test: flipping the `skipped` arm to green survived the
      // full suite with a byte-identical failure set. Only the palette stays local.
      const persistenceMarker = renderPersistenceMarker(persistence.outcome, {
        pass: chalk.green,
        warn: chalk.yellow,
        fail: chalk.red,
      });
      console.log(persistenceMarker + ` Persistence round-trip: ${persistence.message}`);
    }

    if (probeFailed || triggerFailed) process.exitCode = 1;
  });

/**
 * Render one trigger diagnosis. Shared by `check` and `app status` so the two surfaces cannot
 * describe the same trigger differently — and so the summary line is the same string `--json`
 * carries, which is what stops a text/JSON drift of the kind this command has shipped before.
 */
export function reportTriggerDiagnosis(trigger: TriggerDiagnosis): void {
  console.log(
    (trigger.can_fire ? chalk.green("✓") : chalk.red("✗")) +
      ` Recording trigger: ${trigger.summary}`
  );
  for (const failure of trigger.failures) console.log(chalk.red(`  ${failure}`));
  for (const warning of trigger.warnings) console.log(chalk.yellow(`  ⚠ ${warning}`));
  for (const note of trigger.notes) console.log(chalk.dim(`  ${note}`));
}


