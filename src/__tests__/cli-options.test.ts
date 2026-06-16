import { describe, expect, test } from "bun:test";
import { applyEnhancementOptions } from "../cli/options.js";
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
  });

  test("legacy noEnhance option shape still disables auto enhancement", () => {
    const cfg = config(true);

    applyEnhancementOptions(cfg, { noEnhance: false });

    expect(cfg.auto_enhance).toBe(false);
  });

  test("enhancement remains enabled by default", () => {
    const cfg = config(true);

    applyEnhancementOptions(cfg, {});

    expect(cfg.auto_enhance).toBe(true);
  });
});
