import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import packageJson from "../../package.json";

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
    expect(runner).toContain("Contents/Helpers/recordings");
  });

  test("compiled companion exposes the app-required version and commands", () => {
    const directory = mkdtempSync(join(tmpdir(), "recordings-companion-"));
    const executable = join(directory, "recordings");
    try {
      const build = spawnSync("bash", ["scripts/build_companion_cli.sh", executable], {
        encoding: "utf8",
      });
      expect(build.status, build.stderr).toBe(0);

      const run = (...args: string[]) =>
        spawnSync(executable, args, { encoding: "utf8" });
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
      ]) {
        expect(saveTextHelp).toContain(flag);
      }
      expect(run("rewrite", "--help").stdout).toContain("--instruction");

      const registration = spawnSync(
        executable,
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

  test("recording capture is not gated on project synchronization readiness", () => {
    const engine = readFileSync(
      "src/native/Recordings/RecordingsLib/RecordingEngine.swift",
      "utf8",
    );
    const start = engine.indexOf("public func startRecording(");
    const permissionSwitch = engine.indexOf("switch AVCaptureDevice.authorizationStatus", start);
    const startBody = engine.slice(start, permissionSwitch);

    expect(startBody).not.toContain("guard store.isReadyForRecording");
    expect(startBody).toContain("continuing capture");
    expect(engine).toContain("let activeProjectId = projectStore?.settings.activeProjectId");
    expect(engine).toContain(
      "let canonicalProjectId = projectStore?.activeCanonicalProjectIdForRecording",
    );
    expect(engine).toContain("activeProjectId: canonicalProjectId");
    expect(engine).toContain("activeProjectId: activeProjectId");
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
