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

import { DEFAULT_LOG_LINES, program } from "./command-context.js";
import { buildPermissionWarnings, getMacOSAppStatus, getMacOSInstallerPath, resetMacOSPermissions } from "./app-status.js";

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

export const appCommand = program
  .command("app")
  .description("Manage the macOS app installed from this package");

appCommand
  .command("install")
  .description("Install a release or explicitly approved local-only Recordings.app artifact")
  .requiredOption("--artifact <path>", "Finalized Recordings.app ZIP artifact")
  .requiredOption("--manifest <path>", "Artifact provenance manifest")
  .option("--envelope <path>", "Signed release envelope (required for release artifacts)")
  .option("--expected-team-id <team>", "Required Developer ID TeamIdentifier for release artifacts")
  .requiredOption("--manifest-sha256 <sha256>", "Authenticated release-manifest SHA-256")
  .requiredOption("--expected-source-sha <sha>", "Exact approved 40-character source commit")
  .requiredOption("--expected-version <version>", "Exact approved release version")
  .option(
    "--expected-hostname <hostname>",
    "Exact deployment hostname to verify before any install mutation",
  )
  .option("--artifact-policy <policy>", "Artifact policy: release or local-only", "release")
  .option("--approved-target <station>", "Exact approved target; fleet for release artifacts", "fleet")
  .option(
    "--approved-target-identity-kind <kind>",
    "Target identity kind: hardware_uuid_sha256 or tailscale_node_id_sha256",
  )
  .option(
    "--approved-target-identity-sha256 <sha256>",
    "Authenticated SHA-256 of the approved target identity; none for release artifacts",
    "none",
  )
  .option(
    "--acknowledge-local-signing-and-permissions",
    "Acknowledge local-only ad-hoc identity and possible permission reauthorization",
  )
  .option("--expected-old-identity-sha256 <sha256>", "Exact installed identity approved for migration")
  .option("--expected-new-identity-sha256 <sha256>", "Exact candidate identity approved for migration")
  .option(
    "--allow-signing-identity-migration",
    "Allow one reviewed signer change that requires new macOS permission approval",
  )
  // Distinct from --allow-signing-identity-migration, and it has to be reachable here:
  // this is the only install path the README documents, so without it the installer's
  // escape hatch is discoverable only from stderr and usable only by invoking
  // scripts/install_macos_app.sh directly. A local-only repair install of an ad-hoc
  // signed app hits the identity-migration gate every time, because every ad-hoc rebuild
  // changes the CDHash.
  .option(
    "--allow-adhoc-identity-migration",
    "Accept that replacing an ad-hoc signed local-only app voids its Microphone and Accessibility grants",
  )
  .option("--launch", "Launch and verify the canonical app after installation")
  .option("--launch-timeout <seconds>", "Canonical process launch timeout")
  .action((opts: {
    artifact: string;
    manifest: string;
    envelope?: string;
    expectedTeamId?: string;
    manifestSha256: string;
    expectedSourceSha: string;
    expectedVersion: string;
    expectedHostname?: string;
    artifactPolicy: string;
    approvedTarget: string;
    approvedTargetIdentityKind?: string;
    approvedTargetIdentitySha256: string;
    acknowledgeLocalSigningAndPermissions?: boolean;
    expectedOldIdentitySha256?: string;
    expectedNewIdentitySha256?: string;
    allowSigningIdentityMigration?: boolean;
    allowAdhocIdentityMigration?: boolean;
    launch?: boolean;
    launchTimeout?: string;
  }) => {
    if (process.platform !== "darwin") {
      console.error(chalk.red("Recordings.app installation is only supported on macOS"));
      process.exit(1);
    }
    if (opts.artifactPolicy === "release") {
      if (!opts.envelope) {
        console.error(chalk.red("Release installation requires --envelope."));
        process.exit(1);
      }
      let preparedInputs: ReturnType<typeof prepareReleaseInstallInputs>;
      try {
        assertReleaseOnlyOptions(opts);
        if (opts.expectedHostname) {
          const hostnameResult = spawnSync("/bin/hostname", ["-s"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            env: {
              PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
              LC_ALL: "C",
              LANG: "C",
              TZ: "UTC0",
            },
          });
          if (hostnameResult.error || hostnameResult.status !== 0) {
            throw new Error("could not determine the install target hostname");
          }
          assertExpectedReleaseHostname(opts.expectedHostname, hostnameResult.stdout.trim());
        }
        preparedInputs = prepareReleaseInstallInputs({
          artifactPath: opts.artifact,
          manifestPath: opts.manifest,
          envelopePath: opts.envelope,
          manifestSha256: opts.manifestSha256,
          expectedSourceSha: opts.expectedSourceSha,
          expectedVersion: opts.expectedVersion,
          expectedTeamId: opts.expectedTeamId,
        });
      } catch (error) {
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
      const updateClientPath = "/Applications/Recordings.app/Contents/Helpers/recordings-update-client";
      if (!existsSync(updateClientPath)) {
        preparedInputs.cleanup();
        console.error(chalk.red("Root-owned Recordings update broker client is not installed."));
        process.exit(1);
      }
      const result = (() => {
        try {
          return spawnSync(updateClientPath, [
            "install",
            "--artifact",
            opts.artifact,
            "--manifest",
            preparedInputs.manifestPath,
            "--envelope",
            preparedInputs.envelopePath,
          ], {
            stdio: "inherit",
            env: {
              HOME: process.env.HOME ?? "",
              PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
              LC_ALL: "C",
              LANG: "C",
              TZ: "UTC0",
            },
          });
        } finally {
          preparedInputs.cleanup();
        }
      })();
      if (result.error) {
        console.error(chalk.red(result.error.message));
        process.exit(1);
      }
      process.exit(result.status ?? 1);
    }
    if (opts.artifactPolicy !== "local-only" && opts.artifactPolicy !== "local_only") {
      console.error(chalk.red("Artifact policy must be release or local-only."));
      process.exit(1);
    }
    let launchTimeout: string;
    try {
      launchTimeout = parseLaunchTimeout(opts.launchTimeout);
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
    let bunExecutable: string;
    try {
      bunExecutable = resolveInstallBunExecutable(process.env);
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
    const installerPath = getMacOSInstallerPath();
    if (!existsSync(installerPath)) {
      console.error(chalk.red(`App installer missing from package: ${installerPath}`));
      process.exit(1);
    }

    const installerArgs = [
      installerPath,
      "--artifact",
      opts.artifact,
      "--manifest",
      opts.manifest,
      "--manifest-sha256",
      opts.manifestSha256,
      "--expected-source-sha",
      opts.expectedSourceSha,
      "--expected-version",
      opts.expectedVersion,
      "--artifact-policy",
      opts.artifactPolicy,
      "--approved-target",
      opts.approvedTarget,
      "--launch-timeout",
      launchTimeout,
    ];
    if (opts.expectedHostname) {
      installerArgs.push("--expected-hostname", opts.expectedHostname);
    }
    if (opts.approvedTargetIdentityKind) {
      installerArgs.push("--approved-target-identity-kind", opts.approvedTargetIdentityKind);
    }
    installerArgs.push(
      "--approved-target-identity-sha256",
      opts.approvedTargetIdentitySha256,
    );
    if (opts.expectedTeamId) {
      installerArgs.push("--expected-team-id", opts.expectedTeamId);
    }
    if (opts.acknowledgeLocalSigningAndPermissions) {
      installerArgs.push("--acknowledge-local-signing-and-permissions");
    }
    if (opts.allowSigningIdentityMigration) {
      installerArgs.push("--allow-signing-identity-migration");
    }
    if (opts.allowAdhocIdentityMigration) {
      installerArgs.push("--allow-adhoc-identity-migration");
    }
    if (opts.expectedOldIdentitySha256) {
      installerArgs.push("--expected-old-identity-sha256", opts.expectedOldIdentitySha256);
    }
    if (opts.expectedNewIdentitySha256) {
      installerArgs.push("--expected-new-identity-sha256", opts.expectedNewIdentitySha256);
    }
    if (opts.launch) installerArgs.push("--launch");

    const installerEnvironment = createInstallerEnvironment(process.env, bunExecutable);

    const result = spawnSync("/bin/bash", installerArgs, {
      stdio: "inherit",
      env: installerEnvironment,
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
    // An installed, fully permissioned app with a dead trigger dictates nothing, and this
    // command reported the first two and not the third. One line and one additive JSON key,
    // from the same diagnosis `check` renders. Unlike `check` this stays exit 0 whatever it
    // finds: `app status` is a readout, `check` is the gate.
    const trigger = probeTriggerDiagnostics({
      accessibilityPermission:
        process.platform === "darwin" ? status.accessibility_permission : null,
      appLogPath: status.log_path,
    });
    if (program.opts().json) {
      console.log(JSON.stringify({ ...status, trigger }, null, 2));
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
    if (trigger) {
      console.log(
        `Trigger: ${trigger.summary}${trigger.can_fire ? "" : " — NOTHING CAN FIRE"}`,
      );
      console.log(chalk.dim("  'recordings check' reports the trigger in full and exits non-zero when nothing can fire."));
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
      bundle_id: RECORDINGS_BUNDLE_IDENTIFIER,
      installed_app_path: status.installed_app_path,
      // A machine consumer needs the same caveats the text output prints, or it reads the
      // states below as describing installed code that may not exist.
      installed: status.installed,
      legacy_install_paths: status.legacy_install_paths,
      // The grants below belong to this bundle, not to the terminal running this command.
      permission_subject: describeTccAuthorizationSubject(status.installed_app_path),
      microphone: status.microphone_permission,
      accessibility: status.accessibility_permission,
      app_code_hash: status.app_code_hash,
      ad_hoc_signed: status.ad_hoc_signed,
      signing_identifier: status.signing_identifier,
      team_identifier: status.team_identifier,
      designated_requirement: status.designated_requirement,
      // Durability is per service because each service stores its own requirement.
      microphone_grant_durability: status.microphone_grant_durability,
      accessibility_grant_durability: status.accessibility_grant_durability,
      microphone_stored_requirement: status.microphone_stored_requirement,
      accessibility_stored_requirement: status.accessibility_stored_requirement,
      ambiguous_installations: status.ambiguous_installations,
      // The same conditions the text output warns about, as data rather than prose.
      warnings: buildPermissionWarnings(status),
      log_path: status.log_path,
    };
    if (program.opts().json) {
      console.log(JSON.stringify(permissions, null, 2));
      return;
    }
    console.log(`Subject: ${permissions.permission_subject}`);
    console.log(`Microphone: ${permissions.microphone} (${permissions.microphone_grant_durability})`);
    console.log(
      `Accessibility: ${permissions.accessibility} (${permissions.accessibility_grant_durability})`,
    );
    for (const warning of permissions.warnings) {
      console.log(chalk.yellow(`Warning: ${warning}`));
    }
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

    const result = runMacOSPermissionRequest(status.installed_app_path);
    if (result.errorMessage) {
      console.error(chalk.red(result.errorMessage));
    }
    process.exit(result.exitCode);
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


