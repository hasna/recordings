import OpenAI from "openai";
import type {
  RecordingsConfig,
  EnhancementResult,
  PostProcessingMode,
} from "../types/index.js";
import { EnhancementError } from "../types/index.js";
import { normalizePostProcessingMode } from "./config.js";
import { describeTranscriptionFailure } from "./transcriber.js";

let _enhancementClient: OpenAI | null = null;
let _enhancementClientApiKey: string | null = null;

function getEnhancementClient(config: RecordingsConfig): OpenAI {
  const key = config.enhancement_api_key || config.openai_api_key;
  if (!key) {
    throw new EnhancementError(
      "API key not configured for enhancement. Set OPENAI_API_KEY or RECORDINGS_ENHANCEMENT_KEY"
    );
  }
  if (_enhancementClient && _enhancementClientApiKey === key) return _enhancementClient;
  _enhancementClient = new OpenAI({ apiKey: key });
  _enhancementClientApiKey = key;
  return _enhancementClient;
}

export function resetEnhancementClient(): void {
  _enhancementClient = null;
  _enhancementClientApiKey = null;
}

export interface ProcessTextOptions {
  systemPrompt?: string;
  postProcessingMode?: PostProcessingMode;
}

/**
 * Detect if the transcribed text needs AI enhancement.
 *
 * Detection logic:
 * 1. Explicit triggers: "say it better", "rewrite this", etc.
 * 2. Instruction patterns: "write an email saying...", "give instructions to..."
 * 3. Meta-commentary: text that talks ABOUT what to say rather than being the content itself
 */
export function needsEnhancement(
  text: string,
  config: RecordingsConfig
): { needs: boolean; reason: string; instruction: string } {
  const lower = text.toLowerCase().trim();

  // Check explicit triggers from config
  for (const trigger of config.enhance_triggers) {
    if (lower.includes(trigger.toLowerCase())) {
      return {
        needs: true,
        reason: `Explicit trigger: "${trigger}"`,
        instruction: extractInstruction(text, trigger),
      };
    }
  }

  // Check instruction patterns
  const instructionPatterns = [
    /(?:write|draft|compose|create)\s+(?:an?\s+)?(?:email|message|response|reply|letter|note|text|slack|dm)/i,
    /(?:give|provide|send)\s+(?:them|him|her|it|the\s+agent|the\s+team)\s+(?:full\s+)?instructions/i,
    /(?:tell|ask)\s+(?:them|him|her|it|the\s+agent)\s+(?:to|that)/i,
    /(?:make\s+it|make\s+this)\s+(?:sound|look|read)\s+(?:more\s+)?(?:professional|formal|casual|friendly|better)/i,
    /(?:ok\s+so|okay\s+so|alright\s+so)\s+(?:say|write|tell|put)/i,
    /(?:i\s+need|i\s+want)\s+(?:the\s+agent|it|them|you)\s+to\s+(?:build|create|implement|design|make)/i,
  ];

  for (const pattern of instructionPatterns) {
    if (pattern.test(text)) {
      return {
        needs: true,
        reason: `Instruction pattern detected`,
        instruction: text,
      };
    }
  }

  return { needs: false, reason: "Direct dictation", instruction: text };
}

function extractInstruction(text: string, trigger: string): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(trigger.toLowerCase());
  if (idx === -1) return text;

  // Take everything after the trigger as the instruction context
  const after = text.substring(idx + trigger.length).trim();
  const before = text.substring(0, idx).trim();

  // If there's content before the trigger, that's likely the raw text to enhance
  if (before.length > after.length && before.length > 10) {
    return before;
  }

  // Otherwise the whole text is the instruction
  return text;
}

export async function enhanceText(
  rawText: string,
  instruction: string,
  config: RecordingsConfig,
  systemPrompt?: string
): Promise<EnhancementResult> {
  const client = getEnhancementClient(config);
  const model = resolveTranscriberModel(config);

  let basePrompt = `You are a writing assistant. The user has dictated speech that needs to be transformed into polished output.

Rules:
- Output ONLY the enhanced/rewritten text — no explanations, no preamble
- Preserve the user's intent and meaning
- Fix grammar, structure, and clarity
- Perform basic spell checking without changing intended words (correct obvious typos only)
- Format text into logical paragraphs with proper spacing
- If the user is giving instructions (e.g., "write an email saying..."), produce the actual output (the email), not a description of it
- If the user says "say it better" or similar, rewrite their preceding text to be clearer and more professional
- Match the appropriate tone (formal for business, casual for personal)
- Apply keyword/phrase transformations as configured in the system`;

  // Apply keyword transformations if configured
  if (config.keyword_transforms && Object.keys(config.keyword_transforms).length > 0) {
    const transformRules = Object.entries(config.keyword_transforms)
      .map(([from, to]) => `- "${from}" → "${to}"`)
      .join('\n');
    basePrompt += `\n\nKeyword Transformations:\n${transformRules}`;
  }

  const transcriberPrompt = combinePrompts(config.transcriber_prompt, systemPrompt);
  const fullPrompt = transcriberPrompt
    ? `${basePrompt}\n\nTranscriber instructions:\n${transcriberPrompt}`
    : basePrompt;

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content: fullPrompt,
        },
        {
          role: "user",
          content: instruction,
        },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    });

    const enhanced =
      response.choices[0]?.message?.content?.trim() || rawText;

    return {
      original: rawText,
      enhanced,
      model,
      reasoning: null,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new EnhancementError(`Enhancement failed: ${describeTranscriptionFailure(msg)}`);
  }
}

/**
 * Full pipeline: detect if enhancement is needed, enhance if so.
 */
export async function processText(
  rawText: string,
  config: RecordingsConfig,
  systemPromptOrOptions?: string | ProcessTextOptions
): Promise<{
  text: string;
  mode: "raw" | "enhanced";
  enhancement_model: string | null;
  post_processing_mode: PostProcessingMode;
  enhancement_reason: string | null;
}> {
  const options = normalizeProcessTextOptions(systemPromptOrOptions);
  const postProcessingMode = options.postProcessingMode
    ?? normalizePostProcessingMode(
      config.post_processing_mode,
      config.auto_enhance === false ? "off" : "auto"
    );

  if (postProcessingMode === "off") {
    return {
      text: rawText,
      mode: "raw",
      enhancement_model: null,
      post_processing_mode: "off",
      enhancement_reason: null,
    };
  }

  const detection = postProcessingMode === "always"
    ? {
        needs: true,
        reason: "Always-on post-processing",
        instruction: rawText,
      }
    : needsEnhancement(rawText, config);

  if (!detection.needs) {
    return {
      text: rawText,
      mode: "raw",
      enhancement_model: null,
      post_processing_mode: postProcessingMode,
      enhancement_reason: detection.reason,
    };
  }

  const result = await enhanceText(rawText, detection.instruction, config, options.systemPrompt);

  return {
    text: result.enhanced,
    mode: "enhanced",
    enhancement_model: result.model,
    post_processing_mode: postProcessingMode,
    enhancement_reason: detection.reason,
  };
}

export function resolveTranscriberModel(config: RecordingsConfig): string {
  return config.transcriber_model || config.enhancement_model;
}

function normalizeProcessTextOptions(
  value?: string | ProcessTextOptions
): ProcessTextOptions {
  if (typeof value === "string") return { systemPrompt: value };
  return value ?? {};
}

function combinePrompts(...prompts: Array<string | undefined>): string {
  return prompts
    .map((prompt) => prompt?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
}
