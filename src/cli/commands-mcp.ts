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


