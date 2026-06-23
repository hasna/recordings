import type { RecordingsConfig } from "../types/index.js";
import { normalizePostProcessingConfig, normalizePostProcessingMode } from "../lib/config.js";

const POST_PROCESSING_MODES = new Set(["off", "auto", "always"]);

export type EnhancementOptionBag = {
  enhance?: boolean;
  noEnhance?: boolean;
  postProcessing?: string;
  transcriberPrompt?: string;
  systemPrompt?: string;
  transcriberModel?: string;
  enhancementModel?: string;
};

export function applyEnhancementOptions(
  config: RecordingsConfig,
  opts: EnhancementOptionBag
): RecordingsConfig {
  if (opts.postProcessing) {
    const requestedMode = opts.postProcessing.trim().toLowerCase();
    if (!POST_PROCESSING_MODES.has(requestedMode)) {
      throw new Error("Invalid post-processing mode. Use one of: off, auto, always.");
    }
  }

  const disableEnhancement = opts.enhance === false || opts.noEnhance === false;
  if (disableEnhancement) {
    config.auto_enhance = false;
    config.post_processing_mode = "off";
    normalizePostProcessingConfig(config, true);
  } else if (opts.postProcessing) {
    config.post_processing_mode = normalizePostProcessingMode(
      opts.postProcessing,
      config.post_processing_mode ?? "auto"
    );
    normalizePostProcessingConfig(config, true);
  } else {
    normalizePostProcessingConfig(config, false);
  }
  if (opts.transcriberPrompt !== undefined) {
    config.transcriber_prompt = opts.transcriberPrompt;
  } else if (opts.systemPrompt !== undefined) {
    config.transcriber_prompt = opts.systemPrompt;
  }
  if (opts.transcriberModel) {
    config.transcriber_model = opts.transcriberModel;
  } else if (opts.enhancementModel) {
    config.enhancement_model = opts.enhancementModel;
    config.transcriber_model = opts.enhancementModel;
  }
  return config;
}
