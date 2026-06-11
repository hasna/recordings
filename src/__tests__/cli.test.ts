import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("recordings CLI", () => {
  test("command failures print a clean ERROR line instead of a stack trace", async () => {
    const home = join(tmpdir(), `open-recordings-cli-err-${Date.now()}`);
    tempDirs.push(home);

    const proc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "--json", "transcribe", "/nonexistent/audio.wav", "--no-enhance"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          OPENAI_API_KEY: "sk-test-invalid",
          RECORDINGS_API_KEY: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(1);
    const combined = `${stdout}\n${stderr}`;
    expect(combined).toContain("ERROR:");
    expect(combined).not.toContain("at async");
    expect(combined).not.toContain("Bun v");
  });

  test("--help advertises storage sync without legacy cloud command", async () => {
    const proc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "--help"],
      {
        cwd: process.cwd(),
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("storage");
    expect(stdout).not.toContain("cloud");
  });

  test("storage status reports local mode as JSON", async () => {
    const home = join(tmpdir(), `open-recordings-cli-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirs.push(home);

    const proc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "--json", "storage", "status"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          HASNA_RECORDINGS_DATABASE_URL: "",
          RECORDINGS_DATABASE_URL: "",
          HASNA_RECORDINGS_STORAGE_MODE: "",
          RECORDINGS_STORAGE_MODE: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const status = JSON.parse(stdout) as { mode: string; enabled: boolean; service: string; tables: Array<{ table: string; rows: number }> };
    expect(status.mode).toBe("local");
    expect(status.enabled).toBe(false);
    expect(status.service).toBe("recordings");
    expect(status.tables.some((table) => table.table === "recordings")).toBe(true);
  });

  test("--json app status reports package installer paths", async () => {
    const proc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "--json", "app", "status"],
      {
        cwd: process.cwd(),
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const status = JSON.parse(stdout) as {
      package_root: string;
      installer_available: boolean;
      native_sources_available: boolean;
      installed_app_path: string;
      app_code_hash: string | null;
      ad_hoc_signed: boolean;
      microphone_permission: string;
      accessibility_permission: string;
      log_path: string;
    };
    expect(status.package_root).toBe(process.cwd());
    expect(status.installer_available).toBe(true);
    expect(status.native_sources_available).toBe(true);
    expect(status.installed_app_path).toContain(".hasna/recordings/Recordings.app");
    expect(typeof status.ad_hoc_signed).toBe("boolean");
    expect(status.app_code_hash === null || typeof status.app_code_hash === "string").toBe(true);
    expect(typeof status.microphone_permission).toBe("string");
    expect(typeof status.accessibility_permission).toBe("string");
    expect(status.log_path).toContain(".hasna/recordings/Recordings.log");
  });

  test("--json app permissions emits permission diagnostics", async () => {
    const proc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "--json", "app", "permissions"],
      {
        cwd: process.cwd(),
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const permissions = JSON.parse(stdout) as {
      bundle_id: string;
      microphone: string;
      accessibility: string;
      app_code_hash: string | null;
      ad_hoc_signed: boolean;
      log_path: string;
    };
    expect(permissions.bundle_id).toBe("com.hasna.recordings");
    expect(typeof permissions.microphone).toBe("string");
    expect(typeof permissions.accessibility).toBe("string");
    expect(typeof permissions.ad_hoc_signed).toBe("boolean");
    expect(permissions.app_code_hash === null || typeof permissions.app_code_hash === "string").toBe(true);
    expect(permissions.log_path).toContain(".hasna/recordings/Recordings.log");
  });

  test("--json check emits machine-readable dependency status", async () => {
    const home = join(tmpdir(), `open-recordings-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirs.push(home);

    const proc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "--json", "check"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          OPENAI_API_KEY: "test-openai-key",
          RECORDINGS_ENHANCEMENT_KEY: "test-enhancement-key",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const report = JSON.parse(stdout) as {
      recording: { available: boolean; tool: string | null; message: string };
      openai_api_key_configured: boolean;
      enhancement_api_key_configured: boolean;
      enhancement_model: string;
    };
    expect(typeof report.recording.available).toBe("boolean");
    expect(report.openai_api_key_configured).toBe(true);
    expect(report.enhancement_api_key_configured).toBe(true);
    expect(report.enhancement_model).toBe("gpt-4o");
  });
});
