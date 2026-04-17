#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, ensureDataDir } from "../lib/config.js";
import { getDatabase, getAdapter } from "../db/database.js";
import {
  createRecording,
  getRecording,
  listRecordings,
  deleteRecording,
  searchRecordings,
  getRecordingStats,
} from "../db/recordings.js";
import { registerAgent, getAgent, listAgents } from "../db/agents.js";
import {
  registerProject,
  listProjects,
} from "../db/projects.js";
import {
  startRecording,
  stopRecording,
  isRecording,
  checkRecordingDeps,
  recordDuration,
} from "../lib/recorder.js";
import { transcribeAudio } from "../lib/transcriber.js";
import { processText, needsEnhancement } from "../lib/enhancer.js";
import type { Recording } from "../types/index.js";

const program = new Command();

program
  .name("recordings")
  .description(
    "Speech-to-text recording tool — record, transcribe, and enhance with AI"
  )
  .version("0.0.3")
  .option("--json", "Output as JSON")
  .option("--agent <name>", "Agent name or ID")
  .option("--project <name>", "Project name or ID")
  .option("--session <id>", "Session ID");

// ── record ──────────────────────────────────────────────────────────────────

program
  .command("record")
  .description("Record from microphone, transcribe, and optionally enhance")
  .option("-d, --duration <seconds>", "Record for specific duration")
  .option("--no-enhance", "Skip AI enhancement")
  .option("-t, --tags <tags>", "Comma-separated tags")
  .option("-l, --language <lang>", "Language code (e.g. en, es, fr)")
  .action(async (opts) => {
    const config = loadConfig();
    ensureDataDir(config);

    if (opts.language) config.language = opts.language;
    if (opts.noEnhance === false) config.auto_enhance = false;

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
      console.log(
        chalk.blue(`Recording for ${seconds} seconds...`)
      );
      audioPath = await recordDuration(seconds, config);
      console.log(chalk.green("Recording complete."));
    } else {
      // Interactive recording — press Enter to stop
      console.log(
        chalk.blue("Recording... Press") +
          chalk.yellow(" Enter ") +
          chalk.blue("to stop.")
      );
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
      console.log(chalk.green("Recording stopped."));
    }

    // Transcribe
    console.log(chalk.blue("Transcribing..."));
    const transcription = await transcribeAudio(audioPath, config);
    console.log(chalk.dim(`Raw: ${transcription.text}`));

    // Process (detect & enhance if needed)
    const processed = await processText(transcription.text, config);

    if (processed.mode === "enhanced") {
      console.log(chalk.green("\nEnhanced output:"));
      console.log(processed.text);
    } else {
      console.log(chalk.green("\nOutput:"));
      console.log(transcription.text);
    }

    // Save to database
    const tags = opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : [];
    const parentOpts = program.opts();

    const recording = createRecording({
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
  .option("-t, --tags <tags>", "Comma-separated tags")
  .option("--system-prompt <prompt>", "System prompt for enhancement context")
  .action(async (file, opts) => {
    const config = loadConfig();
    ensureDataDir(config);
    if (opts.noEnhance === false) config.auto_enhance = false;

    console.log(chalk.blue("Transcribing..."));
    const transcription = await transcribeAudio(file, config);

    const processed = await processText(transcription.text, config, opts.systemPrompt);
    const parentOpts = program.opts();
    const tags = opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : [];

    const recording = createRecording({
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
    });

    if (processed.mode === "enhanced") {
      console.log(chalk.green("Enhanced:"));
      console.log(processed.text);
    } else {
      console.log(chalk.green("Transcription:"));
      console.log(transcription.text);
    }

    if (parentOpts.json) {
      console.log(JSON.stringify(recording, null, 2));
    } else {
      console.log(chalk.dim(`Saved as ${recording.id.slice(0, 8)}`));
    }
  });

// ── list ────────────────────────────────────────────────────────────────────

program
  .command("list")
  .description("List recordings")
  .option("-n, --limit <n>", "Max results", "20")
  .option("--mode <mode>", "Filter by mode: raw or enhanced")
  .option("-t, --tags <tags>", "Filter by tags")
  .option("--since <date>", "After date (ISO)")
  .option("--until <date>", "Before date (ISO)")
  .action((opts) => {
    const config = loadConfig();
    getDatabase(config.db_path);
    const parentOpts = program.opts();

    const recordings = listRecordings({
      limit: parseInt(opts.limit, 10),
      processing_mode: opts.mode,
      tags: opts.tags ? opts.tags.split(",") : undefined,
      since: opts.since,
      until: opts.until,
      agent_id: parentOpts.agent,
      project_id: parentOpts.project,
      session_id: parentOpts.session,
    });

    if (parentOpts.json) {
      console.log(JSON.stringify(recordings, null, 2));
      return;
    }

    if (recordings.length === 0) {
      console.log(chalk.dim("No recordings found."));
      return;
    }

    console.log(
      chalk.bold(`${recordings.length} recording(s):\n`)
    );
    for (const r of recordings) {
      console.log(formatRecordingLine(r));
    }
  });

// ── show ────────────────────────────────────────────────────────────────────

program
  .command("show <id>")
  .description("Show recording details")
  .action((id) => {
    const config = loadConfig();
    getDatabase(config.db_path);
    const parentOpts = program.opts();

    const recording = getRecording(id);
    if (!recording) {
      console.error(chalk.red(`Recording not found: ${id}`));
      process.exit(1);
    }

    if (parentOpts.json) {
      console.log(JSON.stringify(recording, null, 2));
      return;
    }

    console.log(formatRecordingDetail(recording));
  });

// ── search ──────────────────────────────────────────────────────────────────

program
  .command("search <query>")
  .description("Search recordings by text content")
  .option("-n, --limit <n>", "Max results", "20")
  .action((query, opts) => {
    const config = loadConfig();
    getDatabase(config.db_path);
    const parentOpts = program.opts();

    const results = searchRecordings(query, {
      limit: parseInt(opts.limit, 10),
      agent_id: parentOpts.agent,
      project_id: parentOpts.project,
    });

    if (parentOpts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (results.length === 0) {
      console.log(chalk.dim("No results."));
      return;
    }

    console.log(chalk.bold(`${results.length} result(s):\n`));
    for (const r of results) {
      console.log(formatRecordingLine(r));
    }
  });

// ── delete ──────────────────────────────────────────────────────────────────

program
  .command("delete <id>")
  .description("Delete a recording")
  .action((id) => {
    const config = loadConfig();
    getDatabase(config.db_path);

    const deleted = deleteRecording(id);
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
  .action(() => {
    const config = loadConfig();
    getDatabase(config.db_path);
    const parentOpts = program.opts();

    const stats = getRecordingStats();

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
    if (Object.keys(stats.by_model).length > 0) {
      console.log(`  By model:`);
      for (const [model, count] of Object.entries(stats.by_model)) {
        console.log(`    ${model}: ${count}`);
      }
    }
  });

// ── agents ──────────────────────────────────────────────────────────────────

program
  .command("agents")
  .description("List registered agents")
  .action(() => {
    const config = loadConfig();
    getDatabase(config.db_path);
    const parentOpts = program.opts();

    const agents = listAgents();

    if (parentOpts.json) {
      console.log(JSON.stringify(agents, null, 2));
      return;
    }

    if (agents.length === 0) {
      console.log(chalk.dim("No agents registered."));
      return;
    }

    for (const a of agents) {
      console.log(
        `${chalk.cyan(a.id)} ${chalk.bold(a.name)} (${a.role}) — last seen ${a.last_seen_at}`
      );
    }
  });

// ── projects ────────────────────────────────────────────────────────────────

program
  .command("projects")
  .description("List registered projects")
  .action(() => {
    const config = loadConfig();
    getDatabase(config.db_path);
    const parentOpts = program.opts();

    const projects = listProjects();

    if (parentOpts.json) {
      console.log(JSON.stringify(projects, null, 2));
      return;
    }

    if (projects.length === 0) {
      console.log(chalk.dim("No projects registered."));
      return;
    }

    for (const p of projects) {
      console.log(
        `${chalk.cyan(p.id.slice(0, 8))} ${chalk.bold(p.name)} — ${p.path}`
      );
    }
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
        transcription_model: "gpt-4o-mini-transcribe",
        enhancement_model: "gpt-4o",
        language: "en",
        auto_enhance: true,
      };
      writeFileSync(configFile, JSON.stringify(defaultConf, null, 2));
    }

    console.log(chalk.green("Initialized .recordings/ directory"));
    console.log(chalk.dim("  config: .recordings/config.json"));
    console.log(chalk.dim("  audio:  .recordings/audio/"));
    console.log(chalk.dim("  db:     .recordings/recordings.db"));
  });

// ── check ───────────────────────────────────────────────────────────────────

program
  .command("check")
  .description("Check system dependencies (sox, API keys)")
  .action(async () => {
    const config = loadConfig();

    // Check recording deps
    const deps = await checkRecordingDeps();
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
    const enhKey = config.enhancement_api_key || config.openai_api_key;
    if (enhKey) {
      console.log(
        chalk.green(`✓ Enhancement API key configured (model: ${config.enhancement_model})`)
      );
    } else {
      console.log(
        chalk.yellow(`⚠ Enhancement API key not configured — enhancement disabled`)
      );
    }
  });

// ── start ───────────────────────────────────────────────────────────────────

program
  .command("start")
  .description("Launch the menu bar helper app (F5 to toggle recording)")
  .option("--login", "Also add to Login Items so it starts automatically")
  .action(async (opts) => {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const { join: pathJoin } = require("node:path") as typeof import("node:path");
    const { homedir: getHome } = require("node:os") as typeof import("node:os");
    const { existsSync: fileExists } = require("node:fs") as typeof import("node:fs");
    const home = getHome();

    const appPath = pathJoin(home, ".hasna", "recordings", "RecordingsHelper.app");
    const oldAppPath = pathJoin(home, ".recordings", "RecordingsHelper.app");

    if (!fileExists(appPath) && !fileExists(oldAppPath)) {
      console.error(chalk.red("RecordingsHelper.app not found. Run: recordings shortcut --install"));
      process.exit(1);
    }

    const resolvedAppPath = fileExists(appPath) ? appPath : oldAppPath;

    // Kill existing instance
    try { execSync("pkill -f RecordingsHelper", { stdio: "pipe" }); } catch { /* not running */ }

    // Launch
    execSync(`open "${resolvedAppPath}"`, { stdio: "pipe" });
    console.log(chalk.green("Recordings helper launched — press F5 to record"));

    if (opts.login) {
      try {
        execSync(
          `osascript -e 'tell application "System Events" to make login item at end with properties {path:"${resolvedAppPath}", hidden:true}'`,
          { stdio: "pipe" }
        );
        console.log(chalk.green("Added to Login Items — will start on boot"));
      } catch {
        console.log(chalk.yellow("Could not add to Login Items — add manually in System Settings > General > Login Items"));
      }
    }
  });

// ── stop ────────────────────────────────────────────────────────────────────

program
  .command("stop")
  .description("Stop the menu bar helper app")
  .action(() => {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    try {
      execSync("pkill -f RecordingsHelper", { stdio: "pipe" });
      console.log(chalk.green("Recordings helper stopped"));
    } catch {
      console.log(chalk.dim("Not running"));
    }
  });

// ── listen ───────────────────────────────────────────────────────────────────

program
  .command("listen")
  .description("Push-to-talk mode — press Space to start/stop recording, Esc to quit")
  .option("-t, --tags <tags>", "Comma-separated tags for all recordings")
  .option("--no-enhance", "Skip AI enhancement")
  .option("-l, --language <lang>", "Language code")
  .option("--copy", "Copy output to clipboard")
  .option("--paste", "Copy output to clipboard AND paste into frontmost app")
  .action(async (opts) => {
    const config = loadConfig();
    ensureDataDir(config);
    if (opts.language) config.language = opts.language;
    if (opts.noEnhance === false) config.auto_enhance = false;

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
            createRecording({
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
  .option("--install", "Set up F5 global shortcut via macOS Services (no extra installs)")
  .option("--karabiner", "Set up Fn key via Karabiner-Elements")
  .option("--skhd", "Generate skhd hotkey config")
  .option("--hammerspoon", "Generate Hammerspoon config")
  .option("--script", "Just output the shell script path")
  .action((opts) => {
    const { writeFileSync, mkdirSync, chmodSync, existsSync: fileExists } = require("node:fs") as typeof import("node:fs");
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

    if (opts.install) {
      // Install the native menu bar app — no config needed, just works with F5
      const { execSync: exec } = require("node:child_process") as typeof import("node:child_process");

      const appPath = pathJoin(home, ".hasna", "recordings", "RecordingsHelper.app");
      const srcSwift = pathJoin(__dirname, "..", "native", "RecordingsHelper.swift");
      const distApp = pathJoin(__dirname, "..", "RecordingsHelper.app");

      // Copy pre-built app if available, otherwise compile
      if (fileExists(pathJoin(distApp, "Contents", "MacOS", "RecordingsHelper"))) {
        exec(`rm -rf "${appPath}" && cp -R "${distApp}" "${appPath}"`, { stdio: "pipe", shell: "/bin/bash" });
      } else if (fileExists(srcSwift)) {
        // Compile from source
        console.log(chalk.blue("Compiling native helper app..."));
        const appDir = pathJoin(home, ".hasna", "recordings", "RecordingsHelper.app", "Contents", "MacOS");
        mkdirSync(appDir, { recursive: true });

        const plistDir = pathJoin(home, ".hasna", "recordings", "RecordingsHelper.app", "Contents");
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>RecordingsHelper</string>
<key>CFBundleIdentifier</key><string>com.hasna.recordings-helper</string>
<key>CFBundleName</key><string>Recordings</string>
<key>LSUIElement</key><true/>
<key>NSMicrophoneUsageDescription</key><string>Recordings needs microphone access for speech transcription.</string>
</dict></plist>`;
        writeFileSync(pathJoin(plistDir, "Info.plist"), plist, "utf-8");

        try {
          exec(
            `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun swiftc -O -o "${appDir}/RecordingsHelper" "${srcSwift}" -framework Cocoa -framework Carbon`,
            { stdio: "pipe" }
          );
        } catch {
          // Fallback to default toolchain
          exec(
            `swiftc -O -o "${appDir}/RecordingsHelper" "${srcSwift}" -framework Cocoa -framework Carbon`,
            { stdio: "pipe" }
          );
        }
      } else {
        console.error(chalk.red("Cannot find RecordingsHelper. Run from the project directory or rebuild."));
        process.exit(1);
      }

      // Kill existing instance and launch
      try { exec("pkill -f RecordingsHelper", { stdio: "pipe" }); } catch { /* not running */ }
      exec(`open "${appPath}"`, { stdio: "pipe" });

      // Add to Login Items
      try {
        exec(
          `osascript -e 'tell application "System Events" to make login item at end with properties {path:"${appPath}", hidden:true}'`,
          { stdio: "pipe" }
        );
      } catch { /* already exists or no permission */ }

      console.log(chalk.green("\nRecordings helper installed and running!\n"));
      console.log(`  ${chalk.yellow("F5")}     Start/stop recording`);
      console.log(`  ${chalk.dim("🎙")}      Menu bar icon (click for options)`);
      console.log(`  ${chalk.dim("Auto")}   Starts on login\n`);
      console.log(chalk.dim("  Press F5 → speak → F5 → text is pasted where your cursor is."));
      return;
    }

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

    console.log(chalk.bold("  macOS built-in") + chalk.dim(" (no extra installs — recommended)"));
    console.log(`    recordings shortcut --install\n`);

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

// ── Formatting helpers ──────────────────────────────────────────────────────

function formatRecordingLine(r: Recording): string {
  const id = chalk.cyan(r.id.slice(0, 8));
  const mode =
    r.processing_mode === "enhanced"
      ? chalk.green("enhanced")
      : chalk.dim("raw");
  const text = (r.processed_text || r.raw_text).slice(0, 80);
  const date = chalk.dim(r.created_at.slice(0, 16));
  const tags =
    r.tags.length > 0
      ? chalk.yellow(` [${r.tags.join(", ")}]`)
      : "";

  return `${id} ${mode} ${date}${tags}\n  ${text}${text.length >= 80 ? "..." : ""}`;
}

function formatRecordingDetail(r: Recording): string {
  const lines: string[] = [
    chalk.bold(`Recording ${r.id.slice(0, 8)}`),
    "",
    `  Mode:     ${r.processing_mode === "enhanced" ? chalk.green("enhanced") : chalk.dim("raw")}`,
    `  Model:    ${r.model_used}`,
  ];

  if (r.enhancement_model) {
    lines.push(`  Enhanced: ${r.enhancement_model}`);
  }
  if (r.duration_ms) {
    lines.push(`  Duration: ${(r.duration_ms / 1000).toFixed(1)}s`);
  }
  if (r.language) {
    lines.push(`  Language: ${r.language}`);
  }
  if (r.audio_path) {
    lines.push(`  Audio:    ${r.audio_path}`);
  }
  if (r.tags.length > 0) {
    lines.push(`  Tags:     ${r.tags.join(", ")}`);
  }

  lines.push(`  Created:  ${r.created_at}`);
  lines.push("");
  lines.push(chalk.bold("Raw text:"));
  lines.push(r.raw_text);

  if (r.processed_text && r.processed_text !== r.raw_text) {
    lines.push("");
    lines.push(chalk.bold("Enhanced text:"));
    lines.push(r.processed_text);
  }

  return lines.join("\n");
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
              `claude mcp add --transport stdio --scope user recordings -- ${mcpCmd}`,
              { stdio: "pipe" }
            );
          }
          console.log(chalk.green(`${action} Claude Code (user scope in ~/.claude.json)`));
        }

        if (target === "codex") {
          const configPath = pathJoin(home, ".codex", "config.toml");
          if (fileExists(configPath)) {
            let content = readFileSync(configPath, "utf-8");
            if (opts.uninstall) {
              content = content.replace(/\n\[mcp_servers\.recordings\]\ncommand = "[^"]*"\nargs = \[\]\n?/g, "\n");
            } else if (!content.includes("[mcp_servers.recordings]")) {
              content += `\n[mcp_servers.recordings]\ncommand = "${mcpCmd}"\nargs = []\n`;
            }
            writeFileSync(configPath, content, "utf-8");
            console.log(chalk.green(`${action} Codex: ${configPath}`));
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
            servers["recordings"] = { command: mcpCmd, args: [] };
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
  .action((id: string) => {
    const deleted = deleteRecording(id);
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
  .action((message: string, opts: { email?: string; category?: string }) => {
    const adapter = getAdapter();
    const pkg = require("../../package.json");
    adapter.run(
      "INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)",
      message, opts.email || null, opts.category || "general", pkg.version
    );
    console.log(chalk.green("Feedback saved. Thank you!"));
  });

// ── Run ─────────────────────────────────────────────────────────────────────

program.parse();
