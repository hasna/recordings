import type { RecordingsConfig } from "../types/index.js";
import {
  normalizeModelSlots,
  normalizePostProcessingConfig,
  normalizePostProcessingMode,
} from "../lib/config.js";

const POST_PROCESSING_MODES = new Set(["off", "auto", "always"]);

export type EnhancementOptionBag = {
  enhance?: boolean;
  noEnhance?: boolean;
  postProcessing?: string;
  transcriberPrompt?: string;
  systemPrompt?: string;
  transcriberModel?: string;
  transcriptionModel?: string;
  enhancementModel?: string;
  enhanceTriggersJson?: string;
  keywordTransformsJson?: string;
};

export function parseListPagination(
  limitValue: string,
  offsetValue: string
): { limit: number; offset: number } {
  const parseInteger = (value: string): number | null => {
    const trimmed = value.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const parsedLimit = parseInteger(limitValue);
  const parsedOffset = parseInteger(offsetValue);
  return {
    limit: parsedLimit !== null ? Math.min(Math.max(parsedLimit, 1), 500) : 20,
    offset: parsedOffset !== null ? Math.max(parsedOffset, 0) : 0,
  };
}

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
  if (opts.enhancementModel) {
    config.enhancement_model = opts.enhancementModel;
  }
  if (opts.transcriberModel) {
    config.transcriber_model = opts.transcriberModel;
  } else if (opts.enhancementModel) {
    config.transcriber_model = opts.enhancementModel;
  }
  if (opts.transcriptionModel) {
    config.transcription_model = opts.transcriptionModel;
  }
  if (opts.enhanceTriggersJson !== undefined) {
    const triggers = JSON.parse(opts.enhanceTriggersJson) as unknown;
    if (!Array.isArray(triggers) || !triggers.every((trigger) => typeof trigger === "string")) {
      throw new Error("Invalid enhancement triggers snapshot; expected a JSON string array.");
    }
    config.enhance_triggers = triggers;
  }
  if (opts.keywordTransformsJson !== undefined) {
    const transforms = JSON.parse(opts.keywordTransformsJson) as unknown;
    if (
      typeof transforms !== "object" || transforms === null || Array.isArray(transforms)
      || !Object.values(transforms).every((value) => typeof value === "string")
    ) {
      throw new Error("Invalid keyword transforms snapshot; expected a JSON string map.");
    }
    config.keyword_transforms = transforms as Record<string, string>;
  }
  normalizeModelSlots(config);
  return config;
}
