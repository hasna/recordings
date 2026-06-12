import type { RecordingsConfig } from "../types/index.js";

export type EnhancementOptionBag = {
  enhance?: boolean;
  noEnhance?: boolean;
};

export function applyEnhancementOptions(
  config: RecordingsConfig,
  opts: EnhancementOptionBag
): RecordingsConfig {
  if (opts.enhance === false || opts.noEnhance === false) {
    config.auto_enhance = false;
  }
  return config;
}
