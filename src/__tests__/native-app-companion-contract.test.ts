import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Subprocess } from "bun";
import packageJson from "../../package.json";

let compiledCompanionDirectory = "";
let compiledCompanion = "";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function stopAndReap(process: Subprocess | undefined, label: string): Promise<void> {
  if (!process) return;
  if (process.exitCode === null) process.kill("SIGTERM");
  try {
    await withTimeout(process.exited, 2_000, `${label} termination`);
  } catch {
    if (process.exitCode === null) process.kill("SIGKILL");
    await withTimeout(process.exited, 2_000, `${label} forced termination`);
  }
}

beforeAll(() => {
  compiledCompanionDirectory = mkdtempSync(join(tmpdir(), "recordings-companion-fixture-"));
  compiledCompanion = join(compiledCompanionDirectory, "recordings");
  const build = spawnSync("bash", ["scripts/build_companion_cli.sh", compiledCompanion], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(build.error, build.stderr).toBeUndefined();
  expect(build.status, build.stderr).toBe(0);
}, 60_000);

afterAll(() => {
  if (compiledCompanionDirectory) {
    rmSync(compiledCompanionDirectory, { recursive: true, force: true });
  }
});

describe("native app companion contract", () => {
  test("build embeds a self-contained recordings CLI and runtime prefers it", () => {
    const build = readFileSync("src/native/Recordings/build.sh", "utf8");
    const companionBuild = readFileSync("scripts/build_companion_cli.sh", "utf8");
    const runner = readFileSync(
      "src/native/Recordings/RecordingsLib/RecordingEngine.swift",
      "utf8",
    );

    expect(build).toContain('HELPERS="$CONTENTS/Helpers"');
    expect(build).toContain("build_companion_cli.sh");
    expect(companionBuild).toContain("--compile");
    expect(companionBuild).toContain('COMPILE_DIR="$(mktemp -d)"');
    expect(companionBuild).toContain('trap cleanup EXIT');
    expect(runner).toContain("Contents/Helpers/recordings");
  });

  test("compiled companion exposes the app-required version and commands", () => {
    const directory = mkdtempSync(join(tmpdir(), "recordings-companion-runtime-"));
    try {
      const run = (...args: string[]) =>
        spawnSync(compiledCompanion, args, { encoding: "utf8", timeout: 10_000 });
      expect(run("--version").stdout.trim()).toBe(packageJson.version);
      expect(run("project", "register", "--help").status).toBe(0);
      expect(run("save-text", "--help").status).toBe(0);
      const rootHelp = run("--help").stdout;
      expect(rootHelp).toContain("--json");
      expect(rootHelp).toContain("--project");
      const registrationHelp = run("project", "register", "--help").stdout;
      expect(registrationHelp).toContain("--name");
      expect(registrationHelp).toContain("--path");
      expect(registrationHelp).toContain("--description");
      const listHelp = run("list", "--help").stdout;
      expect(listHelp).toContain("-n, --limit");
      expect(listHelp).toContain("--limit");
      expect(listHelp).toContain("--offset");
      const searchHelp = run("search", "--help").stdout;
      expect(searchHelp).toContain("-n, --limit");
      expect(searchHelp).toContain("--limit");
      const transcribeHelp = run("transcribe", "--help").stdout;
      expect(transcribeHelp).toContain("--post-processing");
      expect(transcribeHelp).toContain("--transcriber-prompt");
      expect(transcribeHelp).toContain("--language");
      expect(transcribeHelp).toContain("--recording-id");
      expect(transcribeHelp).toContain("--transcription-model");
      expect(transcribeHelp).toContain("--enhance-triggers-json");
      expect(transcribeHelp).toContain("--keyword-transforms-json");
      const saveTextHelp = run("save-text", "--help").stdout;
      for (const flag of [
        "--text-file",
        "--source",
        "--model-used",
        "--post-processing",
        "--audio-path",
        "--duration-ms",
        "--language",
        "--transcriber-prompt",
        "--recording-id",
        "--transcription-model",
        "--transcriber-model",
        "--enhancement-model",
        "--enhance-triggers-json",
        "--keyword-transforms-json",
      ]) {
        expect(saveTextHelp).toContain(flag);
      }
      expect(run("rewrite", "--help").stdout).toContain("--instruction");

      const registration = spawnSync(
        compiledCompanion,
        [
          "--json",
          "project",
          "register",
          "--name",
          "Native Contract",
          "--path",
          "recordings-app://projects/native-contract",
        ],
        {
          cwd: directory,
          encoding: "utf8",
          timeout: 10_000,
          env: {
            HOME: join(directory, "home"),
            PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
            HASNA_RECORDINGS_STORAGE_MODE: "local",
            RECORDINGS_STORAGE_MODE: "local",
            HASNA_RECORDINGS_DB_PATH: join(directory, "recordings.db"),
            RECORDINGS_AUDIO_DIR: join(directory, "audio"),
          },
        },
      );
      expect(registration.status, registration.stderr).toBe(0);
      expect(JSON.parse(registration.stdout)).toMatchObject({
        name: "Native Contract",
        path: "recordings-app://projects/native-contract",
      });
      expect(existsSync(join(directory, "recordings.db"))).toBeTrue();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("compiled rewrite keeps frozen A config and option-like text over ambient B config", async () => {
    const directory = mkdtempSync(join(tmpdir(), "recordings-rewrite-contract-"));
    const requestPath = join(directory, "request.json");
    const home = join(directory, "home");
    let server: Subprocess | undefined;
    let rewrite: Subprocess | undefined;
    try {
      const configDirectory = join(home, ".hasna", "recordings");
      mkdirSync(configDirectory, { recursive: true });
      writeFileSync(join(configDirectory, "config.json"), JSON.stringify({
        openai_api_key: "ambient-b-key",
        transcription_prompt: "Project B vocabulary",
        transcriber_prompt: "Project B rewrite policy",
        post_processing_mode: "off",
        language: "en",
        transcription_model: "whisper-b",
        transcriber_model: "gpt-command-b",
        enhancement_model: "gpt-fallback-b",
        enhance_triggers: ["rewrite b"],
        keyword_transforms: { "open ai": "OpenAI B" },
      }));

      server = Bun.spawn([
        process.execPath,
        "-e",
        `
          const requestPath = process.argv[1];
          let watchdog;
          const server = Bun.serve({
            port: 0,
            async fetch(request) {
              await Bun.write(requestPath, await request.text());
              clearTimeout(watchdog);
              setTimeout(() => server.stop(true), 10);
              return Response.json({ choices: [{ message: { content: "Frozen A result" } }] });
            },
          });
          console.log(server.port);
          watchdog = setTimeout(() => server.stop(true), 10000);
        `,
        requestPath,
      ], { stdout: "pipe", stderr: "pipe" });
      const portReader = server.stdout.getReader();
      const portChunk = await withTimeout(portReader.read(), 5_000, "rewrite fixture server startup");
      portReader.releaseLock();
      const port = Number(new TextDecoder().decode(portChunk.value).trim());
      expect(port).toBeGreaterThan(0);

      rewrite = Bun.spawn([
        compiledCompanion,
        "rewrite",
        "--instruction", "instruction A",
        "--post-processing", "always",
        "--language", "es",
        "--prompt", "Project A vocabulary",
        "--transcriber-prompt", "Project A rewrite policy",
        "--transcription-model", "whisper-a",
        "--transcriber-model", "gpt-command-a",
        "--enhancement-model", "gpt-fallback-a",
        "--enhance-triggers-json", '["rewrite a"]',
        "--keyword-transforms-json", '{"code with":"Codewith A"}',
        "--",
        "--help",
      ], {
        cwd: directory,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          HOME: home,
          PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
          OPENAI_BASE_URL: `http://127.0.0.1:${port}`,
        },
      });
      const [status, stdout, stderr] = await withTimeout(Promise.all([
        rewrite.exited,
        new Response(rewrite.stdout).text(),
        new Response(rewrite.stderr).text(),
      ]), 10_000, "compiled rewrite");
      expect(status, stderr).toBe(0);
      expect(stdout.trim()).toBe("Frozen A result");
      await withTimeout(server.exited, 2_000, "rewrite fixture server shutdown");

      const request = JSON.parse(readFileSync(requestPath, "utf8"));
      expect(request.model).toBe("gpt-command-a");
      const messages = JSON.stringify(request.messages);
      for (const expected of [
        "--help",
        "instruction A",
        "Project A rewrite policy",
        "Codewith A",
      ]) {
        expect(messages).toContain(expected);
      }
      for (const forbidden of [
        "Project B rewrite policy",
        "gpt-command-b",
        "OpenAI B",
      ]) {
        expect(messages).not.toContain(forbidden);
      }
    } finally {
      const cleanup = await Promise.allSettled([
        stopAndReap(rewrite, "compiled rewrite"),
        stopAndReap(server, "rewrite fixture server"),
      ]);
      rmSync(directory, { recursive: true, force: true });
      const failedCleanup = cleanup.find((result) => result.status === "rejected");
      if (failedCleanup?.status === "rejected") throw failedCleanup.reason;
    }
  }, 20_000);

  test("normal app launch declares a menu bar surface", () => {
    const app = readFileSync("src/native/Recordings/App/RecordingsApp.swift", "utf8");

    expect(app).toContain("MenuBarExtra(isInserted: menuBarInsertion)");
    expect(app).toContain(
      "get: { state.declaresMenuBar && (state.store != nil || state.runtimeSmokeProbe != nil) }",
    );
    expect(app).not.toContain("if state.declaresMenuBar");
    expect(app).toContain("if plan.isRuntimeSmoke");
    expect(app).toContain("else if plan.requestsAccessibilityPrompt");
    const launchInitialization = app.slice(
      app.indexOf("init() {"),
      app.indexOf("@SceneBuilder var body"),
    );
    expect(launchInitialization).not.toContain("AXIsProcessTrustedWithOptions");
  });

  test("Accessibility prompting is process-gated and runtime smoke reports prompt calls", () => {
    const app = readFileSync("src/native/Recordings/App/RecordingsApp.swift", "utf8");
    const engine = readFileSync(
      "src/native/Recordings/RecordingsLib/RecordingEngine.swift",
      "utf8",
    );
    const gate = readFileSync(
      "src/native/Recordings/RecordingsLib/AccessibilityPromptGate.swift",
      "utf8",
    );
    expect(app).toContain("AccessibilityPromptGate.processShared.requestExplicitly");
    expect(app).toContain("AccessibilityPromptGate.processShared.promptRequestCount");
    expect(app).not.toContain("AXIsProcessTrustedWithOptions");
    expect(engine).toContain("AccessibilityPromptGate.processShared");
    expect(engine).not.toContain("AXIsProcessTrustedWithOptions");
    expect(engine).not.toContain("lastAccessibilityPromptAt");
    expect(engine).not.toContain("timeIntervalSince(lastAccessibilityPromptAt)");
    expect(gate.match(/AXIsProcessTrustedWithOptions/g)).toHaveLength(1);
  });

  test("command rewrite retains and revalidates the exact AX element and selection", () => {
    const engine = readFileSync(
      "src/native/Recordings/RecordingsLib/RecordingEngine.swift",
      "utf8",
    );

    expect(engine).toContain("AccessibilitySelectionToken");
    expect(engine).toContain("CFEqual(element, currentElement)");
    expect(engine).toContain("matchesCurrentSelection(for: app.processIdentifier)");
    expect(engine).toContain("selectionToken:");
    expect(engine.match(/targetIsReady\(\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(engine).not.toContain("activateIgnoringOtherApps");
  });

  test("recording capture is not gated on project synchronization readiness", () => {
    const engine = readFileSync(
      "src/native/Recordings/RecordingsLib/RecordingEngine.swift",
      "utf8",
    );
    const start = engine.indexOf("public func startRecording(");
    const permissionSwitch = engine.indexOf("switch microphoneAuthorization()", start);
    expect(permissionSwitch).toBeGreaterThan(start);
    const startBody = engine.slice(start, permissionSwitch);

    expect(startBody).not.toContain("guard store.isReadyForRecording");
    expect(startBody).toContain("continuing capture");
    expect(engine).toContain("displayProjectId: projectStore?.settings.activeProjectId");
    expect(engine).toContain(
      "canonicalProjectId: projectStore?.activeCanonicalProjectIdForRecording",
    );
    expect(engine).toContain("activeProjectId: canonicalProjectId");
    expect(engine).toContain("activeProjectId: activeProjectId");
  });

  test("recorder start never waits on Accessibility IPC; the frozen context is generation-bound", () => {
    const engine = readFileSync(
      "src/native/Recordings/RecordingsLib/RecordingEngine.swift",
      "utf8",
    );
    const start = engine.indexOf("public func startRecording(");
    const permissionSwitch = engine.indexOf("switch microphoneAuthorization()", start);
    const startBody = engine.slice(start, permissionSwitch);

    // The AX snapshot (selection token + window title) resolves on a detached task and the
    // pipeline awaits it only after the recorder stopped.
    expect(startBody).toContain("Task.detached(priority: .userInitiated)");
    expect(startBody).not.toContain("AccessibilitySelectionToken.capture(for:");
    expect(engine).toContain("await captureConfiguration.startContext.value");
    expect(engine).toContain("generation == self.recordingGeneration");
  });

  test("fail-closed routes paste the raw transcript and the rewrite helper is tightly bounded", () => {
    const engine = readFileSync(
      "src/native/Recordings/RecordingsLib/RecordingEngine.swift",
      "utf8",
    );
    const intent = readFileSync(
      "src/native/Recordings/RecordingsLib/SpeechIntent.swift",
      "utf8",
    );

    expect(intent).toContain("literalRawTranscript: true");
    expect(engine).toContain("literalRawTranscript ? rawTranscript : text");
    expect(engine).toContain("commandRewriteTimeout: TimeInterval = 10");
    expect(engine).toContain("runCLI(rewriteArguments, homePath, Self.commandRewriteTimeout)");

    // The 10 s rewrite ceiling is *observable* wall time: the production closure reserves
    // a return margin (spawn setup, waitid poll granularity, capture shutdown, task hop)
    // and hands CLIRunner a total deadline meaningfully below the ceiling; CLIRunner still
    // reserves its cleanup (termination grace, kill grace, pipe drain) inside that deadline.
    expect(engine).toContain("commandRewriteReturnMargin: TimeInterval = 1");
    expect(engine).toContain("let cliDeadline = ceiling - RecordingEngine.commandRewriteReturnMargin");
    expect(engine).toContain(
      "CLIRunner.run(args, home: home, timeout: cliDeadline, totalWallClockBudget: cliDeadline)",
    );
    expect(engine).toContain("static let wallClockCleanupReserve: TimeInterval = 1");
    expect(engine).toContain("totalWallClockBudget > wallClockCleanupReserve");
    expect(engine).toContain("public func cancelIntentProcessing()");
    expect(engine).toContain("shouldAbandonDelivery");

    // Every no-selection command fallback is literal: the local screen must never hand a
    // command-shaped utterance to the enhancer just because it missed the clear-edit shape.
    expect(intent).toContain('reason: "No selection for an edit — dictating literally"');
    const literalDecisions = intent.match(/literalTranscript: true/g) ?? [];
    expect(literalDecisions.length).toBeGreaterThanOrEqual(3);
  });

  test("pending intent phases retain the transcript in Recent and paste settlement is observable", () => {
    const engine = readFileSync(
      "src/native/Recordings/RecordingsLib/RecordingEngine.swift",
      "utf8",
    );

    // Cancel promises "transcript saved to Recent" — every route that can be pending
    // (Deciding, Answering, Rewriting) inserts before its pending phase begins.
    expect(engine).toContain("transcriptRetainedInRecent");
    expect(engine).toContain("attachProcessedTextToRecentTranscription");

    // The paste coordinator's settlement back to idle must publish, or canStartRecording
    // never recomputes and the menu bar stays busy after a completed paste.
    expect(engine).toContain("var pendingTransactionWillChange: (@MainActor () -> Void)?");
    expect(engine).toContain("coordinator.pendingTransactionWillChange = { [weak self] in");
    expect(engine).toContain("self?.objectWillChange.send()");
  });

  test("Reduce Transparency renders chrome on an opaque surface, never a translucent material", () => {
    const chrome = readFileSync(
      "src/native/Recordings/RecordingsLib/ChromeSurface.swift",
      "utf8",
    );
    const workspace = readFileSync("src/native/Recordings/App/RecordWorkspaceView.swift", "utf8");
    const theme = readFileSync("src/native/Recordings/App/Theme.swift", "utf8");

    expect(chrome).toContain("reduceTransparency ? .opaque : .liquidGlass");
    expect(workspace).toContain("ChromeSurface.forReducedTransparency(reduceTransparency)");
    expect(theme).toContain("ChromeSurface.forReducedTransparency(reduceTransparency)");
    expect(workspace).not.toContain("ultraThinMaterial");
    expect(theme).not.toContain("ultraThinMaterial");
    expect(workspace).toContain("Color(NSColor.windowBackgroundColor)");
    expect(theme).toContain("Color(NSColor.windowBackgroundColor)");
  });

  test("the menu bar reports the true start gate and the Record hero is dimensionally stable", () => {
    const presentation = readFileSync(
      "src/native/Recordings/RecordingsLib/MenuBarPresentation.swift",
      "utf8",
    );
    const menuView = readFileSync("src/native/Recordings/App/MenuBarStatusView.swift", "utf8");
    const workspace = readFileSync("src/native/Recordings/App/RecordWorkspaceView.swift", "utf8");

    expect(presentation).toContain("canStartRecording: Bool");
    expect(menuView).toContain("canStartRecording: store.engine.canStartRecording");
    expect(menuView).toContain(".disabled(!presentation.primaryActionEnabled)");
    expect(workspace).toContain("heroSizingTemplate");
    expect(workspace).toContain("liveTextReservation");
    expect(workspace).toContain("engine.cancelIntentProcessing()");
  });

  test("showing either a new or retained main window activates the app", () => {
    const app = readFileSync("src/native/Recordings/App/RecordingsApp.swift", "utf8");
    const menu = readFileSync("src/native/Recordings/App/MenuBarStatusView.swift", "utf8");
    const openRecordings = app.slice(
      app.indexOf("func openRecordings()"),
      app.indexOf("\n    }\n}\n\n@main", app.indexOf("func openRecordings()")),
    );

    expect(openRecordings).toContain("NSApplication.shared.setActivationPolicy(.regular)");
    expect(openRecordings).toContain("NSRunningApplication.current.activate");
    expect(menu).toContain("Button(action: openRecordings)");
    expect(app.match(/self\.openRecordings\(\)/g)?.length).toBeGreaterThanOrEqual(2);

    const smoke = readFileSync("scripts/smoke_macos_app.sh", "utf8");
    expect(smoke).toContain('open -n -g -W "$APP_PATH"');
    expect(smoke).toContain("applicationActivationPolicy !== 0");
    expect(smoke).toContain("mainWindowCanBecomeKey");
    expect(smoke).toContain("!result.applicationIsActive || !result.mainWindowIsKey");
    expect(smoke).toContain('result.accessibilityObservationStatus !== "absent"');
    expect(smoke).not.toContain("accessibilityMenuBarItemCount > 0");
    expect(smoke).toContain('SMOKE_APP_PID="$(find_smoke_app_pid "$output")"');
    expect(smoke).toContain('SMOKE_APP_PID" != "$result_pid"');
  });

  test("AX smoke distinguishes authoritative absence from unavailable children", () => {
    const runtimeSmoke = readFileSync("src/native/Recordings/App/RuntimeSmoke.swift", "utf8");
    const childLookup = runtimeSmoke.slice(runtimeSmoke.indexOf("let childrenError"));

    expect(childLookup).toContain(
      "childrenError == .noValue || childrenError == .attributeUnsupported",
    );
    expect(childLookup).toContain("status: .unavailable, itemCount: -1");
    expect(childLookup).toContain("status: children.isEmpty ? .absent : .available");
  });
});
