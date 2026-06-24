import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
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
    expect(stdout).toContain("events");
    expect(stdout).toContain("storage");
    expect(stdout).toContain("webhooks");
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

  test("app help advertises permission request command", async () => {
    const proc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "app", "--help"],
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
    expect(stdout).toContain("request-permissions");
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
      realtime_session_model: string;
      realtime_transcription_model: string;
      config_warnings: string[];
    };
    expect(typeof report.recording.available).toBe("boolean");
    expect(report.openai_api_key_configured).toBe(true);
    expect(report.enhancement_api_key_configured).toBe(true);
    expect(report.enhancement_model).toBe("gpt-4o");
    expect(report.realtime_session_model).toBe("gpt-realtime");
    expect(report.realtime_transcription_model).toBe("gpt-realtime-whisper");
    expect(Array.isArray(report.config_warnings)).toBe(true);
  });

  test("--json transcribe emits only one JSON payload on stdout", async () => {
    const home = join(tmpdir(), `open-recordings-cli-json-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirs.push(home);
    mkdirSync(home, { recursive: true });
    const audioPath = join(home, "sample.wav");
    writeFileSync(audioPath, "fake wav bytes");

    const apiServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname.endsWith("/audio/transcriptions")) {
          return Response.json({ text: "mock transcript", language: "en" });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    try {
      const proc = Bun.spawn(
        [process.execPath, "src/cli/index.ts", "--json", "transcribe", audioPath, "--no-enhance"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: home,
            OPENAI_API_KEY: "sk-test-key",
            RECORDINGS_API_KEY: "",
            RECORDINGS_ENHANCEMENT_KEY: "",
            OPENAI_BASE_URL: `http://127.0.0.1:${apiServer.port}`,
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
      expect(stdout).not.toContain("Transcribing");
      expect(stdout).not.toContain("Transcription:");
      expect(stdout.trim().startsWith("{")).toBe(true);

      const recording = JSON.parse(stdout) as {
        raw_text: string;
        processing_mode: string;
        model_used: string;
      };
      expect(recording.raw_text).toBe("mock transcript");
      expect(recording.processing_mode).toBe("raw");
      expect(recording.model_used).toBe("gpt-4o-transcribe");
    } finally {
      apiServer.stop(true);
    }
  });

  test("--json transcribe always post-processes and emits safe metadata", async () => {
    const home = join(tmpdir(), `open-recordings-cli-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirs.push(home);
    mkdirSync(home, { recursive: true });
    const audioPath = join(home, "sample.wav");
    writeFileSync(audioPath, "fake wav bytes");

    const apiServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname.endsWith("/audio/transcriptions")) {
          return Response.json({ text: "hello world", language: "en" });
        }
        if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
          return Response.json({
            choices: [{ message: { content: "Hello, world." } }],
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    try {
      const proc = Bun.spawn(
        [
          process.execPath,
          "src/cli/index.ts",
          "--json",
          "transcribe",
          audioPath,
          "--prompt",
          "Hasna",
          "--transcriber-prompt",
          "Fix punctuation only",
          "--post-processing",
          "always",
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: home,
            OPENAI_API_KEY: "sk-test-key",
            RECORDINGS_API_KEY: "",
            RECORDINGS_ENHANCEMENT_KEY: "",
            OPENAI_BASE_URL: `http://127.0.0.1:${apiServer.port}`,
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
      const recording = JSON.parse(stdout) as {
        raw_text: string;
        processed_text: string;
        processing_mode: string;
        metadata: {
          transcription_prompt: { configured: boolean; source: string };
          transcriber_prompt: { configured: boolean; source: string };
          post_processing: { mode: string; applied: boolean; model: string };
        };
      };
      expect(recording.raw_text).toBe("hello world");
      expect(recording.processed_text).toBe("Hello, world.");
      expect(recording.processing_mode).toBe("enhanced");
      expect(recording.metadata.transcription_prompt).toEqual({
        configured: true,
        source: "request",
      });
      expect(recording.metadata.transcriber_prompt).toEqual({
        configured: true,
        source: "request",
      });
      expect(recording.metadata.post_processing.mode).toBe("always");
      expect(recording.metadata.post_processing.applied).toBe(true);
      expect(JSON.stringify(recording.metadata)).not.toContain("Fix punctuation only");
    } finally {
      apiServer.stop(true);
    }
  });

  test("--json save-text persists realtime fast-path text without audio transcription", async () => {
    const home = join(tmpdir(), `open-recordings-cli-save-text-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirs.push(home);
    mkdirSync(home, { recursive: true });
    const audioPath = join(home, "sample.wav");
    const textPath = join(home, "transcript.txt");
    const transcript = "hello from realtime\nwith \"quotes\" and multiple lines";
    writeFileSync(textPath, transcript);

    const proc = Bun.spawn(
      [
        process.execPath,
        "src/cli/index.ts",
        "--json",
        "save-text",
        "--text-file",
        textPath,
        "--audio-path",
        audioPath,
        "--source",
        "realtime_fast_path",
        "--model-used",
        "gpt-realtime-whisper",
        "--post-processing",
        "off",
        "--language",
        "en",
        "--duration-ms",
        "1200",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          OPENAI_API_KEY: "",
          RECORDINGS_API_KEY: "",
          RECORDINGS_ENHANCEMENT_KEY: "",
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
    const recording = JSON.parse(stdout) as {
      audio_path: string;
      raw_text: string;
      processing_mode: string;
      model_used: string;
      duration_ms: number;
      language: string;
      metadata: {
        transcription_source: string;
        realtime: { fast_path: boolean; model: string; bounded_fallback: boolean };
        post_processing: { mode: string; applied: boolean };
      };
    };
    expect(recording.audio_path).toBe(audioPath);
    expect(recording.raw_text).toBe(transcript);
    expect(recording.processing_mode).toBe("raw");
    expect(recording.model_used).toBe("gpt-realtime-whisper");
    expect(recording.duration_ms).toBe(1200);
    expect(recording.language).toBe("en");
    expect(recording.metadata.transcription_source).toBe("realtime_fast_path");
    expect(recording.metadata.realtime).toEqual({
      fast_path: true,
      model: "gpt-realtime-whisper",
      bounded_fallback: false,
    });
    expect(recording.metadata.post_processing.mode).toBe("off");
    expect(recording.metadata.post_processing.applied).toBe(false);
  });

  test("list is compact by default while json and detail commands preserve full text", async () => {
    const home = join(tmpdir(), `open-recordings-cli-compact-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirs.push(home);
    mkdirSync(home, { recursive: true });
    const longText = `First compact transcript ${"middle words ".repeat(30)}hidden-tail-token`;

    const env = {
      ...process.env,
      HOME: home,
      OPENAI_API_KEY: "",
      RECORDINGS_API_KEY: "",
      RECORDINGS_ENHANCEMENT_KEY: "",
    };

    const saveProc = Bun.spawn(
      [
        process.execPath,
        "src/cli/index.ts",
        "--json",
        "save-text",
        longText,
        "--post-processing",
        "off",
      ],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const [saveStdout, saveStderr, saveExit] = await Promise.all([
      new Response(saveProc.stdout).text(),
      new Response(saveProc.stderr).text(),
      saveProc.exited,
    ]);
    expect(saveExit).toBe(0);
    expect(saveStderr).toBe("");
    const saved = JSON.parse(saveStdout) as { id: string; raw_text: string };
    expect(saved.raw_text).toBe(longText);

    const listProc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "list", "-n", "1"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const [listStdout, listStderr, listExit] = await Promise.all([
      new Response(listProc.stdout).text(),
      new Response(listProc.stderr).text(),
      listProc.exited,
    ]);
    expect(listExit).toBe(0);
    expect(listStderr).toBe("");
    expect(listStdout).toContain("recordings: showing 1 of 1");
    expect(listStdout).toContain(saved.id.slice(0, 8));
    expect(listStdout).toContain("Details: recordings show <id> or inspect <id>");
    expect(listStdout).not.toContain("hidden-tail-token");

    const jsonProc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "--json", "list", "-n", "1"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const [jsonStdout, jsonStderr, jsonExit] = await Promise.all([
      new Response(jsonProc.stdout).text(),
      new Response(jsonProc.stderr).text(),
      jsonProc.exited,
    ]);
    expect(jsonExit).toBe(0);
    expect(jsonStderr).toBe("");
    const listed = JSON.parse(jsonStdout) as Array<{ raw_text: string }>;
    expect(listed[0]!.raw_text).toBe(longText);

    const showProc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "inspect", saved.id.slice(0, 8)],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const [showStdout, showStderr, showExit] = await Promise.all([
      new Response(showProc.stdout).text(),
      new Response(showProc.stderr).text(),
      showProc.exited,
    ]);
    expect(showExit).toBe(0);
    expect(showStderr).toBe("");
    expect(showStdout).toContain("hidden-tail-token");
  });

  test("list prints cursor hints and caps oversized human limits", async () => {
    const home = join(tmpdir(), `open-recordings-cli-cursor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirs.push(home);
    mkdirSync(home, { recursive: true });
    const env = {
      ...process.env,
      HOME: home,
      OPENAI_API_KEY: "",
      RECORDINGS_API_KEY: "",
      RECORDINGS_ENHANCEMENT_KEY: "",
    };

    for (const text of ["one", "two"]) {
      const proc = Bun.spawn(
        [process.execPath, "src/cli/index.ts", "save-text", text, "--post-processing", "off"],
        { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
      );
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    }

    const proc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "list", "-n", "100"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("recordings: showing 2 of 2");
    expect(stdout).toContain("limit 50");
    expect(stdout).toContain("Limit capped at 50");
  });

  test("mcp installer configures stdio args for Codex and Gemini", async () => {
    const home = join(tmpdir(), `open-recordings-cli-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirs.push(home);
    const codexDir = join(home, ".codex");
    const geminiDir = join(home, ".gemini");
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(geminiDir, { recursive: true });
    const codexConfig = join(codexDir, "config.toml");
    const geminiConfig = join(geminiDir, "settings.json");
    writeFileSync(codexConfig, "");
    writeFileSync(geminiConfig, "{}");

    const proc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "mcp", "--codex", "--gemini"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
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
    expect(stdout).toContain("Codex");
    expect(stdout).toContain("Gemini");
    expect(readFileSync(codexConfig, "utf-8")).toContain('args = ["--stdio"]');

    const gemini = JSON.parse(readFileSync(geminiConfig, "utf-8")) as {
      mcpServers: { recordings: { command: string; args: string[] } };
    };
    expect(gemini.mcpServers.recordings.args).toEqual(["--stdio"]);
  });
});
