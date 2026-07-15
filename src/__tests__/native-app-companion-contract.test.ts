import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
          encoding: "utf8",
          env: { ...process.env, HOME: join(directory, "home") },
        },
      );
      expect(registration.status, registration.stderr).toBe(0);
      expect(JSON.parse(registration.stdout)).toMatchObject({
        name: "Native Contract",
        path: "recordings-app://projects/native-contract",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("normal app launch declares a menu bar surface", () => {
    const app = readFileSync("src/native/Recordings/App/RecordingsApp.swift", "utf8");

    expect(app).toContain("MenuBarExtra");
    expect(app).toContain("declaresMenuBar");
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
    const showMainWindow = app.slice(
      app.indexOf("func showMainWindow()"),
      app.indexOf("\n    }\n}\n\n@main", app.indexOf("func showMainWindow()")),
    );

    expect(showMainWindow.indexOf("NSApplication.shared.activate()"))
      .toBeLessThan(showMainWindow.indexOf("if let mainWindow"));
  });
});
