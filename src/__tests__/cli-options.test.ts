import { describe, expect, test } from "bun:test";
import { applyEnhancementOptions, parseListPagination } from "../cli/options.js";
import type { RecordingsConfig } from "../types/index.js";

function config(auto_enhance = true): RecordingsConfig {
  return {
    openai_api_key: "sk-test",
    enhancement_api_key: "sk-enhance",
    transcription_model: "gpt-4o-transcribe",
    enhancement_model: "gpt-4o",
    language: "en",
    audio_format: "wav",
    sample_rate: 16_000,
    record_command: "sox",
    hotkey: "space",
    transcription_prompt: "",
    transcriber_prompt: "",
    post_processing_mode: "auto",
    auto_enhance,
    enhance_triggers: [],
    keyword_transforms: {},
    db_path: "/tmp/recordings.db",
    audio_dir: "/tmp/audio",
    max_recording_seconds: 1_800,
  };
}

describe("CLI enhancement options", () => {
  test("commander --no-enhance disables auto enhancement", () => {
    const cfg = config(true);

    applyEnhancementOptions(cfg, { enhance: false });

    expect(cfg.auto_enhance).toBe(false);
    expect(cfg.post_processing_mode).toBe("off");
  });

  test("legacy noEnhance option shape still disables auto enhancement", () => {
    const cfg = config(true);

    applyEnhancementOptions(cfg, { noEnhance: false });

    expect(cfg.auto_enhance).toBe(false);
    expect(cfg.post_processing_mode).toBe("off");
  });

  test("enhancement remains enabled by default", () => {
    const cfg = config(true);

    applyEnhancementOptions(cfg, {});

    expect(cfg.auto_enhance).toBe(true);
    expect(cfg.post_processing_mode).toBe("auto");
  });

  test("--post-processing always forces cleanup mode", () => {
    const cfg = config(true);

    applyEnhancementOptions(cfg, { postProcessing: "always" });

    expect(cfg.auto_enhance).toBe(true);
    expect(cfg.post_processing_mode).toBe("always");
  });

  test("--transcriber-prompt and --transcriber-model update config", () => {
    const cfg = config(true);

    applyEnhancementOptions(cfg, {
      transcriberPrompt: "Format as Markdown",
      transcriberModel: "gpt-test",
    });

    expect(cfg.transcriber_prompt).toBe("Format as Markdown");
    expect(cfg.transcriber_model).toBe("gpt-test");
  });

  test("--system-prompt remains a transcriber prompt alias", () => {
    const cfg = config(true);

    applyEnhancementOptions(cfg, { systemPrompt: "Use terse notes" });

    expect(cfg.transcriber_prompt).toBe("Use terse notes");
  });

  test("invalid post-processing mode throws", () => {
    const cfg = config(true);

    expect(() => applyEnhancementOptions(cfg, { postProcessing: "sometimes" })).toThrow(
      "Invalid post-processing mode"
    );
  });

  test("--no-enhance wins over --post-processing", () => {
    const cfg = config(true);

    applyEnhancementOptions(cfg, {
      enhance: false,
      postProcessing: "always",
    });

    expect(cfg.auto_enhance).toBe(false);
    expect(cfg.post_processing_mode).toBe("off");
  });
});

describe("CLI list pagination", () => {
  test("accepts bounded positive limit and offset", () => {
    expect(parseListPagination("200", "400")).toEqual({ limit: 200, offset: 400 });
  });

  test("caps limit to the remote Store contract", () => {
    expect(parseListPagination("10000", "0")).toEqual({ limit: 500, offset: 0 });
  });

  test("normalizes invalid and negative values", () => {
    expect(parseListPagination("not-a-number", "not-a-number")).toEqual({ limit: 20, offset: 0 });
    expect(parseListPagination("-7", "-2")).toEqual({ limit: 1, offset: 0 });
  });
});
