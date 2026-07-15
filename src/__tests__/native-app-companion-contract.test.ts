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
      expect(run("transcribe", "--help").stdout).toContain("--post-processing");

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
});
