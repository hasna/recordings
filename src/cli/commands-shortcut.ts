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

// ── shortcut ────────────────────────────────────────────────────────────────

program
  .command("shortcut")
  .description(
    "Show or change the global recording trigger (macOS). Exits non-zero when a change was " +
      "written while Recordings.app was running, because the running instance keeps the " +
      "trigger it registered with — the write is stored but not armed until it is reopened."
  )
  .option("--set <chord>", 'Set the app hotkey, e.g. "f13" or "ctrl+opt+r"')
  .option("--reset", "Reset the app hotkey to the app's built-in default")
  .option("--fn <state>", "Use fn/Globe as push-to-talk: on|off")
  .option("--keys", "List the key names accepted by --set")
  .option("--script", "Write the app-less toggle script and print its path")
  .option("--raycast", "Generate a Raycast script command (requires Raycast)")
  .option("--karabiner", "Generate a Karabiner-Elements rule (requires Karabiner-Elements)")
  .option("--skhd", "Print an skhd hotkey config (requires skhd)")
  .option("--hammerspoon", "Print a Hammerspoon config (requires Hammerspoon)")
  .action((opts) => {
    const { writeFileSync, mkdirSync, chmodSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const { join: pathJoin } = require("node:path") as typeof import("node:path");
    const { homedir: getHome } = require("node:os") as typeof import("node:os");
    const { spawnSync: runSync } = require("node:child_process") as typeof import("node:child_process");
    const home = getHome();

    const scriptDir = pathJoin(home, ".hasna", "recordings");
    const scriptPath = pathJoin(scriptDir, "record-toggle.sh");
    const pidFile = pathJoin(scriptDir, ".recording.pid");
    const recordingsBin = pathJoin(home, ".bun", "bin", "recordings");
    const audioDir = pathJoin(scriptDir, "audio");

    if (opts.keys) {
      console.log(chalk.bold("Keys accepted by --set (combine with cmd/ctrl/opt/shift):\n"));
      console.log(listBindableKeys().join(" "));
      // fn is deliberately absent above: it has no Carbon key code, so it cannot be part
      // of a chord. Say where it lives instead of leaving its absence to be guessed.
      console.log(
        chalk.dim("\n  fn/Globe is not in this list — it is a separate trigger, not a chord:\n") +
          "    recordings shortcut --fn on",
      );
      return;
    }

    /**
     * What every read and write below actually needs is a reachable app UserDefaults domain,
     * which is what this asks. In production it is exactly the old `process.platform ===
     * "darwin"` test — `TRIGGER_DEFAULTS_EXECUTABLE` is the pinned `/usr/bin/defaults` on
     * macOS and null everywhere else — but stating it as the capability rather than as a
     * `uname` is both more honest and what lets this command's exit contracts be exercised on
     * a Linux host, the only kind of machine in this fleet where they can be tested at all.
     */
    const appDefaultsReachable = TRIGGER_DEFAULTS_EXECUTABLE !== null;

    /**
     * The app's own trigger lives in its UserDefaults, so it can be read and written
     * without launching the app or rebuilding the bundle. Everything below that talks
     * to a third-party launcher is a fallback for people who want a different launcher,
     * not a prerequisite.
     */
    function requireMacOS(what: string): boolean {
      if (appDefaultsReachable) return true;
      console.error(chalk.red(`${what} is only available on macOS`));
      process.exitCode = 1;
      return false;
    }

    /**
     * One running-bundle scan per invocation.
     *
     * `runningAppBundlePaths()` is measured at ~11.6 s on the owner's machine, and
     * `shortcut --fn on` called it twice — once to name the grant target, once to report
     * pickup — so a single command cost roughly 23 seconds. Nothing between those two calls
     * starts or stops an app, so the second call could only ever repeat the first.
     */
    let runningBundlesCache: string[] | null = null;
    function runningBundles(): string[] {
      runningBundlesCache ??= runningAppBundlePaths();
      return runningBundlesCache;
    }

    /**
     * Bundles a TCC grant would have to be given to: the running instance if there is one,
     * otherwise whatever is installed. A grant keys to a bundle, so naming none at all is
     * useless precisely when it matters most — while telling someone to enable a permission.
     */
    function grantTargetPaths(): { paths: string[]; running: boolean } {
      const running = runningBundles();
      if (running.length > 0) return { paths: running, running: true };
      const status = getMacOSAppStatus();
      return {
        paths: [...(status.installed ? [status.installed_app_path] : []), ...status.legacy_install_paths],
        running: false,
      };
    }

    function showState(): void {
      const state = readTriggerState();
      console.log(chalk.bold("Recording trigger\n"));

      if (state.shortcut) {
        console.log(`  Hotkey          ${chalk.cyan(formatShortcut(state.shortcut))}`);
      } else if (state.rawShortcut) {
        console.log(`  Hotkey          ${chalk.yellow(`unreadable (${state.rawShortcut})`)}`);
      } else {
        console.log(
          `  Hotkey          ${chalk.dim("not set — the app writes its default")} ` +
            `${chalk.cyan(DEFAULT_TOGGLE_RECORDING_CHORD.toUpperCase())} ${chalk.dim("on next launch")}`,
        );
      }
      console.log(`  fn/Globe key    ${state.useFnKey ? chalk.cyan("on") : chalk.dim("off")}`);
      console.log();

      /**
       * Name the bundle every grant below applies to, and refuse to imply anything about
       * this process. A CLI launched from a terminal inherits the *terminal's* TCC grants,
       * so "Accessibility is allowed" measured here would describe Ghostty or Terminal, not
       * Recordings.app. Only the bundle that actually runs can hold the app's grant.
       */
      function showGrantTargets(): void {
        const running = runningBundles();
        const status = getMacOSAppStatus();
        const installed = [
          ...(status.installed ? [status.installed_app_path] : []),
          ...status.legacy_install_paths,
        ];

        console.log(chalk.bold("Which bundle the grants apply to\n"));
        if (running.length === 1) {
          console.log(`  Running         ${chalk.cyan(running[0]!)}`);
        } else if (running.length > 1) {
          console.log(`  Running         ${chalk.red(`${running.length} instances — grants are ambiguous`)}`);
          for (const path of running) console.log(`                  ${path}`);
        } else {
          console.log(`  Running         ${chalk.yellow("not running")}`);
        }
        if (installed.length > 0) {
          console.log(`  Installed       ${installed.join("\n                  ")}`);
        }
        if (installed.length > 1) {
          console.log(
            chalk.yellow("  More than one installed copy — a grant given to one does not cover the others."),
          );
        }
        console.log(
          chalk.dim(
            "\n  This command reports the app's stored trigger, not its permission state:\n" +
              "  a CLI inherits the terminal's grants, so it cannot measure the app's.\n" +
              "  Use 'recordings app permissions' for the bundle's actual grants.",
          ),
        );
        console.log();
      }

      showGrantTargets();

      console.log(chalk.bold("Permissions each trigger needs\n"));
      for (const requirement of TRIGGER_GRANT_REQUIREMENTS) {
        const grant = requirement.tccService
          ? chalk.yellow(requirement.tccService.replace(/^kTCCService/, ""))
          : chalk.green("none");
        console.log(`  ${requirement.label.padEnd(15)} ${grant} — ${requirement.mechanism}`);
        if (requirement.settingsPath) {
          console.log(`  ${" ".repeat(15)} ${requirement.settingsPath} > enable Recordings`);
        }
      }
      console.log();

      console.log(chalk.bold("Change it\n"));
      console.log(`  recordings shortcut --set f13`);
      console.log(`  recordings shortcut --set "ctrl+opt+r"`);
      console.log(`  recordings shortcut --fn on`);
      console.log(`  recordings shortcut --reset`);
      console.log(chalk.dim("\n  Or in the app: Settings > Recording Shortcut."));
      console.log(
        chalk.dim("  A changed hotkey is picked up the next time the app launches."),
      );
    }

    /**
     * A write to UserDefaults changes what the *next* launch registers. The running
     * instance keeps the binding it registered with, and its own Settings toggle writes the
     * same keys back — so "it did not work" after a CLI change is nearly always a live
     * instance still holding the old trigger. Say which instance, by path.
     */
    function reportPickup(): void {
      const pickup = describeTriggerPickup(runningBundles());
      if (pickup.armed) {
        console.log(chalk.dim("  Recordings.app is not running; it will register this on next launch."));
        return;
      }
      console.log(
        chalk.yellow("  Recordings.app is running and still holds the previous trigger.") +
          "\n  Quit and reopen it to arm this one:",
      );
      for (const path of pickup.runningBundlePaths) console.log(chalk.dim(`    ${path}`));
      /**
       * The warning above was already truthful and the command still exited 0, so
       * `recordings shortcut --fn on && echo armed` printed "armed" while the trigger was not
       * armed. That is the same false green as a check that reports a dead trigger as fine —
       * this one just told the lie in an exit code, where a script reads it and a human does
       * not.
       *
       * Non-zero rather than a `--restart` flag, deliberately. Quitting and relaunching the
       * app is a side effect on the owner's running session — it would drop an in-progress
       * dictation and re-trigger permission prompts — and a diagnostic surface earns trust by
       * not doing that behind a flag nobody passed. The write did succeed, so this is not an
       * error in the write; it is a refusal to claim the trigger is live when it is not.
       * `recordings check` reports the same disagreement between stored and armed state.
       */
      console.log(
        chalk.dim(
          "  Exiting non-zero: the value was written, but the trigger that fires right now is " +
            "still the old one.",
        ),
      );
      process.exitCode = 1;
    }

    if (opts.set !== undefined) {
      if (!requireMacOS("Setting the app hotkey")) return;
      let shortcut;
      try {
        shortcut = parseShortcutChord(String(opts.set));
      } catch (error) {
        if (error instanceof ShortcutParseError) {
          console.error(chalk.red(error.message));
          process.exitCode = 1;
          return;
        }
        throw error;
      }
      writeShortcut(shortcut);
      console.log(chalk.green(`Hotkey set to ${formatShortcut(shortcut)}`));
      console.log(chalk.dim(`  ${RECORDINGS_BUNDLE_IDENTIFIER} ${TOGGLE_RECORDING_DEFAULTS_KEY}`));
      reportPickup();
      return;
    }

    if (opts.reset) {
      if (!requireMacOS("Resetting the app hotkey")) return;
      const shortcut = parseShortcutChord(DEFAULT_TOGGLE_RECORDING_CHORD);
      writeShortcut(shortcut);
      console.log(chalk.green(`Hotkey reset to ${formatShortcut(shortcut)}`));
      console.log(chalk.dim(`  ${RECORDINGS_BUNDLE_IDENTIFIER} ${TOGGLE_RECORDING_DEFAULTS_KEY}`));
      reportPickup();
      return;
    }

    if (opts.fn !== undefined) {
      if (!requireMacOS("Changing the fn/Globe trigger")) return;
      const raw = String(opts.fn).toLowerCase();
      const enable = raw === "on" || raw === "true" || raw === "yes" || raw === "1";
      const disable = raw === "off" || raw === "false" || raw === "no" || raw === "0";
      if (!enable && !disable) {
        console.error(chalk.red(`--fn expects on or off, got "${opts.fn}"`));
        process.exitCode = 1;
        return;
      }
      writeUseFnKey(enable);
      console.log(chalk.green(`fn/Globe trigger ${enable ? "enabled" : "disabled"}`));
      console.log(chalk.dim(`  ${RECORDINGS_BUNDLE_IDENTIFIER} ${USE_FN_KEY_DEFAULTS_KEY}`));
      if (enable) {
        const fnGrant = TRIGGER_GRANT_REQUIREMENTS.find((entry) => entry.id === "fn");
        if (fnGrant?.settingsPath) {
          console.log(
            `\n  fn is a ${fnGrant.mechanism}, so it needs ` +
              `${fnGrant.tccService?.replace(/^kTCCService/, "") ?? "no"} permission:\n` +
              `    ${fnGrant.settingsPath} > enable Recordings`,
          );
          // The grant keys to a bundle, so name the one that has to appear in that list.
          const target = grantTargetPaths();
          if (target.paths.length === 0) {
            console.log(chalk.dim("    (no installed Recordings.app found to grant it to)"));
          }
          for (const path of target.paths) {
            console.log(
              chalk.dim(`    grant it to: ${path}${target.running ? "" : " (not running — installed copy)"}`),
            );
          }
        }
        console.log(
          chalk.dim(
            "\n  While enabled the app swallows fn, so fn stops reaching other apps\n" +
              "  (emoji picker, input-source switching). Turn it off with --fn off.",
          ),
        );
      }
      console.log();
      reportPickup();
      return;
    }

    const wantsExternalLauncher =
      Boolean(opts.script) ||
      Boolean(opts.raycast) ||
      Boolean(opts.karabiner) ||
      Boolean(opts.skhd) ||
      Boolean(opts.hammerspoon);

    if (!wantsExternalLauncher) {
      if (!requireMacOS("Reading the app hotkey")) return;
      showState();
      return;
    }

    /**
     * The toggle script is a deliberately app-less path: it shells out to `rec` and the
     * `recordings` CLI, so it works for people driving Recordings from a third-party
     * launcher instead of the menu bar app. It is only written when one of those
     * launchers is actually being configured — reading the trigger must not have side
     * effects, and it records into the same audio directory as the app.
     */
    function writeToggleScript(): void {
      mkdirSync(scriptDir, { recursive: true });
      const script = `#!/bin/bash
# Toggle recording on/off. Run this from a global hotkey.
# Each press toggles: start recording -> stop + transcribe + copy to clipboard
#
# This is the app-less path. If Recordings.app is running, prefer its own hotkey
# ("recordings shortcut --set ..."): the app streams transcription and pastes into
# the focused field, which this script cannot do.
set -e

PID_FILE="${pidFile}"
RECORDINGS="${recordingsBin}"

if [ -f "$PID_FILE" ]; then
  # Stop recording
  PID=$(cat "$PID_FILE")
  kill -INT "$PID" 2>/dev/null || true
  rm -f "$PID_FILE"

  # Find the most recent audio file
  AUDIO_DIR="${audioDir}"
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
    fi
  fi

  # Notification
  osascript -e 'display notification "Recording saved and copied to clipboard" with title "Recordings"' 2>/dev/null || true
else
  # Start recording in background
  mkdir -p "${audioDir}"
  rec -r 16000 -c 1 -b 16 "${audioDir}/recording-$(date +%Y%m%dT%H%M%S).wav" trim 0 300 &
  echo $! > "$PID_FILE"

  # Notification
  osascript -e 'display notification "Recording started..." with title "Recordings"' 2>/dev/null || true
fi
`;
      writeFileSync(scriptPath, script, "utf-8");
      chmodSync(scriptPath, 0o755);
    }

    /**
     * Refuse rather than emit a config for a launcher that is not installed. A generated
     * file for an absent launcher reads like success but can never fire a hotkey.
     */
    function launcherMissing(label: string, present: boolean, install: string): boolean {
      if (present) return false;
      console.error(chalk.red(`${label} is not installed — nothing would fire this hotkey.`));
      console.error(chalk.dim(`  Install it with: ${install}`));
      console.error(
        chalk.dim(
          "  Or use the app's own hotkey, which needs no extra software:\n" +
            "    recordings shortcut --set f13",
        ),
      );
      process.exitCode = 1;
      return true;
    }

    if (opts.karabiner) {
      if (!requireMacOS("Karabiner-Elements setup")) return;
      // The app has a native fn path (`--fn on`) that needs no driver. Karabiner installs
      // a virtual-HID system extension that sits in the input stream for every app and
      // needs a reboot, so it is never the cheap answer for fn.
      console.log(
        chalk.yellow("The app can use fn/Globe natively — no driver, no reboot:") +
          "\n  recordings shortcut --fn on\n",
      );
      if (
        launcherMissing(
          "Karabiner-Elements",
          existsSync("/Applications/Karabiner-Elements.app"),
          "brew install --cask karabiner-elements",
        )
      ) {
        return;
      }
      const karabinerDir = pathJoin(home, ".config", "karabiner", "assets", "complex_modifications");
      mkdirSync(karabinerDir, { recursive: true });
      writeToggleScript();

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

      console.log(chalk.green("Karabiner-Elements rule written:"));
      console.log(chalk.dim(`  ${karabinerPath}\n`));
      console.log("It does nothing until you enable it:");
      console.log("  1. Open Karabiner-Elements");
      console.log("  2. Go to Complex Modifications tab");
      console.log("  3. Click Add Predefined Rule");
      console.log('  4. Enable "Fn key toggles speech recording"');
      return;
    }

    if (opts.raycast) {
      if (!requireMacOS("Raycast setup")) return;
      if (
        launcherMissing("Raycast", existsSync("/Applications/Raycast.app"), "brew install --cask raycast")
      ) {
        return;
      }
      writeToggleScript();
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
      console.log(chalk.green("Raycast script command written:"));
      console.log(chalk.dim(`  ${raycastPath}`));
      console.log(chalk.dim("  Raycast > Script Commands > reload, then assign a hotkey."));
      return;
    }

    if (opts.skhd) {
      if (!requireMacOS("skhd setup")) return;
      const skhdPresent = runSync("/usr/bin/env", ["which", "skhd"], { encoding: "utf8" }).status === 0;
      if (launcherMissing("skhd", skhdPresent, "brew install koekeishiya/formulae/skhd")) return;
      writeToggleScript();
      console.log(chalk.bold("Add to ~/.skhdrc:\n"));
      console.log(chalk.cyan(`  fn - space : ${scriptPath}`));
      console.log(chalk.dim("\n  Then reload: skhd --restart-service"));
      return;
    }

    if (opts.hammerspoon) {
      if (!requireMacOS("Hammerspoon setup")) return;
      if (
        launcherMissing(
          "Hammerspoon",
          existsSync("/Applications/Hammerspoon.app"),
          "brew install --cask hammerspoon",
        )
      ) {
        return;
      }
      writeToggleScript();
      console.log(chalk.bold("Add to ~/.hammerspoon/init.lua:\n"));
      console.log(chalk.cyan(`  hs.hotkey.bind({"ctrl"}, "space", function()
    hs.execute("${scriptPath}")
  end)`));
      console.log(chalk.dim("\n  Then reload Hammerspoon config"));
      return;
    }

    // --script: write the app-less toggle script and print where it landed.
    writeToggleScript();
    console.log(scriptPath);
  });


