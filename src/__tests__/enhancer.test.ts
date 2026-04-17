import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  needsEnhancement,
  enhanceText,
  processText,
  resetEnhancementClient,
} from "../lib/enhancer.js";
import { DEFAULT_CONFIG } from "../lib/config.js";
import type { RecordingsConfig } from "../types/index.js";
import { EnhancementError } from "../types/index.js";

const config: RecordingsConfig = {
  ...DEFAULT_CONFIG,
  openai_api_key: "sk-test-key",
  enhancement_api_key: "sk-test-key",
};

beforeEach(() => {
  resetEnhancementClient();
});

afterEach(() => {
  resetEnhancementClient();
});

// ── needsEnhancement: Explicit Triggers ─────────────────────────────────────

describe("needsEnhancement - explicit triggers", () => {
  test("detects 'say it better' trigger", () => {
    const result = needsEnhancement("This is my draft say it better", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toContain("say it better");
  });

  test("detects 'rewrite this' trigger", () => {
    const result = needsEnhancement("rewrite this paragraph for me", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toContain("rewrite this");
  });

  test("detects 'make it sound' trigger", () => {
    const result = needsEnhancement("make it sound more professional please", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toContain("make it sound");
  });

  test("detects 'clean this up' trigger", () => {
    const result = needsEnhancement("clean this up for the meeting", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toContain("clean this up");
  });

  test("detects 'fix this' trigger", () => {
    const result = needsEnhancement("fix this email draft", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toContain("fix this");
  });

  test("detects 'rephrase' trigger", () => {
    const result = needsEnhancement("can you rephrase it", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toContain("rephrase");
  });

  test("detects 'write it properly' trigger", () => {
    const result = needsEnhancement("write it properly for the boss", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toContain("write it properly");
  });

  test("detects 'make it professional' trigger", () => {
    const result = needsEnhancement("make it professional for the client", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toContain("make it professional");
  });

  test("detects 'improve this' trigger", () => {
    const result = needsEnhancement("improve this paragraph", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toContain("improve this");
  });

  test("detects 'polish this' trigger", () => {
    const result = needsEnhancement("polish this draft before sending", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toContain("polish this");
  });

  test("is case-insensitive for triggers", () => {
    const result = needsEnhancement("SAY IT BETTER please", config);
    expect(result.needs).toBe(true);
  });

  test("extracts instruction with content before trigger", () => {
    const longBefore = "This is a really long draft that I worked on for a while and it needs to be improved significantly. say it better";
    const result = needsEnhancement(longBefore, config);
    expect(result.needs).toBe(true);
    // The instruction should be the content before the trigger (since before > after and before > 10)
    expect(result.instruction).not.toBe(longBefore);
  });

  test("uses full text as instruction when trigger is at start", () => {
    const text = "say it better";
    const result = needsEnhancement(text, config);
    expect(result.needs).toBe(true);
    expect(result.instruction).toBe(text);
  });
});

// ── needsEnhancement: Instruction Patterns ──────────────────────────────────

describe("needsEnhancement - instruction patterns", () => {
  test("detects 'write an email' pattern", () => {
    const result = needsEnhancement("write an email saying we need to reschedule", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toBe("Instruction pattern detected");
  });

  test("detects 'draft a message' pattern", () => {
    const result = needsEnhancement("draft a message to the team about the deadline", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toBe("Instruction pattern detected");
  });

  test("detects 'compose a response' pattern", () => {
    const result = needsEnhancement("compose a response to the client complaint", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toBe("Instruction pattern detected");
  });

  test("detects 'create a reply' pattern", () => {
    const result = needsEnhancement("create a reply to his email", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toBe("Instruction pattern detected");
  });

  test("detects 'give them instructions' pattern", () => {
    const result = needsEnhancement("give them instructions on how to deploy", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toBe("Instruction pattern detected");
  });

  test("detects 'give the agent full instructions' pattern", () => {
    const result = needsEnhancement("give the agent full instructions to build the API", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toBe("Instruction pattern detected");
  });

  test("detects 'provide him instructions' pattern", () => {
    const result = needsEnhancement("provide him instructions on the setup", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toBe("Instruction pattern detected");
  });

  test("detects 'tell them to' pattern", () => {
    const result = needsEnhancement("tell them to fix the bug by Friday", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toBe("Instruction pattern detected");
  });

  test("detects 'ask him that' pattern", () => {
    const result = needsEnhancement("ask him that we need the report", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toBe("Instruction pattern detected");
  });

  test("detects 'tell the agent to' pattern", () => {
    const result = needsEnhancement("tell the agent to refactor the module", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toBe("Instruction pattern detected");
  });

  test("detects 'make it sound more professional' pattern", () => {
    const result = needsEnhancement("make it sound more professional", config);
    expect(result.needs).toBe(true);
  });

  test("detects 'make this look formal' pattern", () => {
    const result = needsEnhancement("make this look formal", config);
    expect(result.needs).toBe(true);
  });

  test("detects 'make it read better' pattern", () => {
    const result = needsEnhancement("make it read better", config);
    expect(result.needs).toBe(true);
  });

  test("detects 'ok so say something' pattern", () => {
    const result = needsEnhancement("ok so say something nice about the product", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toBe("Instruction pattern detected");
  });

  test("detects 'okay so write' pattern", () => {
    const result = needsEnhancement("okay so write a thank you note", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toBe("Instruction pattern detected");
  });

  test("detects 'alright so tell' pattern", () => {
    const result = needsEnhancement("alright so tell them we agree", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toBe("Instruction pattern detected");
  });

  test("detects 'i need the agent to build' pattern", () => {
    const result = needsEnhancement("i need the agent to build a dashboard", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toBe("Instruction pattern detected");
  });

  test("detects 'i want it to create' pattern", () => {
    const result = needsEnhancement("i want it to create a login page", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toBe("Instruction pattern detected");
  });

  test("detects 'i need them to implement' pattern", () => {
    const result = needsEnhancement("i need them to implement the search feature", config);
    expect(result.needs).toBe(true);
    expect(result.reason).toBe("Instruction pattern detected");
  });

  test("detects 'write a slack message' pattern", () => {
    const result = needsEnhancement("write a slack message to the channel about downtime", config);
    expect(result.needs).toBe(true);
  });

  test("detects 'send her instructions' pattern", () => {
    const result = needsEnhancement("send her instructions about the onboarding", config);
    expect(result.needs).toBe(true);
  });

  test("detects 'write a note' pattern", () => {
    const result = needsEnhancement("write a note about the meeting outcomes", config);
    expect(result.needs).toBe(true);
  });

  test("detects 'draft a letter' pattern", () => {
    const result = needsEnhancement("draft a letter to the landlord about the lease", config);
    expect(result.needs).toBe(true);
  });

  test("detects 'compose a text' pattern", () => {
    const result = needsEnhancement("compose a text to my mom about dinner", config);
    expect(result.needs).toBe(true);
  });

  test("detects 'create a dm' pattern", () => {
    const result = needsEnhancement("create a dm for the manager about PTO", config);
    expect(result.needs).toBe(true);
  });

  test("uses full text as instruction for pattern matches", () => {
    const text = "write an email saying we need more time";
    const result = needsEnhancement(text, config);
    expect(result.instruction).toBe(text);
  });
});

// ── needsEnhancement: Negative Cases (Raw Dictation) ────────────────────────

describe("needsEnhancement - raw dictation (no enhancement)", () => {
  test("plain statement does not trigger enhancement", () => {
    const result = needsEnhancement("I went to the store today", config);
    expect(result.needs).toBe(false);
    expect(result.reason).toBe("Direct dictation");
  });

  test("question does not trigger enhancement", () => {
    const result = needsEnhancement("What time is the meeting tomorrow", config);
    expect(result.needs).toBe(false);
  });

  test("technical note does not trigger enhancement", () => {
    const result = needsEnhancement("The API returns a 404 when the ID is missing", config);
    expect(result.needs).toBe(false);
  });

  test("grocery list does not trigger enhancement", () => {
    const result = needsEnhancement("Milk eggs bread butter cheese", config);
    expect(result.needs).toBe(false);
  });

  test("short note does not trigger enhancement", () => {
    const result = needsEnhancement("Remember to call dentist", config);
    expect(result.needs).toBe(false);
  });

  test("empty string does not trigger enhancement", () => {
    const result = needsEnhancement("", config);
    expect(result.needs).toBe(false);
  });

  test("returns full text as instruction when no enhancement needed", () => {
    const text = "Just a regular note";
    const result = needsEnhancement(text, config);
    expect(result.instruction).toBe(text);
  });
});

// ── needsEnhancement: Custom Triggers ───────────────────────────────────────

describe("needsEnhancement - custom triggers", () => {
  test("uses custom enhance_triggers from config", () => {
    const customConfig = {
      ...config,
      enhance_triggers: ["make it fancy", "jazz it up"],
    };

    const result1 = needsEnhancement("make it fancy please", customConfig);
    expect(result1.needs).toBe(true);

    const result2 = needsEnhancement("jazz it up a bit", customConfig);
    expect(result2.needs).toBe(true);

    // Default triggers should NOT work with custom config
    const result3 = needsEnhancement("say it better", customConfig);
    expect(result3.needs).toBe(false);
  });
});

// ── enhanceText ─────────────────────────────────────────────────────────────

describe("enhanceText", () => {
  test("throws EnhancementError when no API key", async () => {
    const noKeyConfig = { ...config, openai_api_key: "", enhancement_api_key: "" };
    try {
      await enhanceText("test", "test", noKeyConfig);
      expect(true).toBe(false); // Should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(EnhancementError);
      expect((err as Error).message).toContain("API key not configured");
    }
  });

  test("calls OpenAI chat completion and returns enhanced text", async () => {
    mock.module("openai", () => ({
      default: class MockOpenAI {
        chat = {
          completions: {
            create: mock(() =>
              Promise.resolve({
                choices: [{ message: { content: "Polished professional text" } }],
              })
            ),
          },
        };
      },
    }));

    resetEnhancementClient();
    const { enhanceText: enhance } = await import("../lib/enhancer.js");
    resetEnhancementClient();

    const result = await enhance("raw messy text", "raw messy text", config);
    expect(result.original).toBe("raw messy text");
    expect(result.enhanced).toBe("Polished professional text");
    expect(result.model).toBe(config.enhancement_model);
    expect(result.reasoning).toBeNull();

    resetEnhancementClient();
  });

  test("falls back to rawText when API returns empty content", async () => {
    mock.module("openai", () => ({
      default: class MockOpenAI {
        chat = {
          completions: {
            create: mock(() =>
              Promise.resolve({
                choices: [{ message: { content: null } }],
              })
            ),
          },
        };
      },
    }));

    resetEnhancementClient();
    const { enhanceText: enhance } = await import("../lib/enhancer.js");
    resetEnhancementClient();

    const result = await enhance("original text", "instruction", config);
    expect(result.enhanced).toBe("original text"); // Falls back to rawText

    resetEnhancementClient();
  });

  test("wraps API errors in EnhancementError", async () => {
    mock.module("openai", () => ({
      default: class MockOpenAI {
        chat = {
          completions: {
            create: mock(() => Promise.reject(new Error("Rate limit exceeded"))),
          },
        };
      },
    }));

    resetEnhancementClient();
    const { enhanceText: enhance } = await import("../lib/enhancer.js");
    resetEnhancementClient();

    try {
      await enhance("text", "instruction", config);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(EnhancementError);
      expect((err as Error).message).toContain("Enhancement failed");
      expect((err as Error).message).toContain("Rate limit exceeded");
    }

    resetEnhancementClient();
  });

  test("wraps non-Error exceptions in EnhancementError", async () => {
    mock.module("openai", () => ({
      default: class MockOpenAI {
        chat = {
          completions: {
            create: mock(() => Promise.reject("string rejection")),
          },
        };
      },
    }));

    resetEnhancementClient();
    const { enhanceText: enhance } = await import("../lib/enhancer.js");
    resetEnhancementClient();

    try {
      await enhance("text", "instruction", config);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(EnhancementError);
      expect((err as Error).message).toContain("Enhancement failed");
    }

    resetEnhancementClient();
  });

  test("uses enhancement_api_key when available", async () => {
    let capturedKey = "";
    mock.module("openai", () => ({
      default: class MockOpenAI {
        constructor(opts: { apiKey: string }) {
          capturedKey = opts.apiKey;
        }
        chat = {
          completions: {
            create: mock(() =>
              Promise.resolve({
                choices: [{ message: { content: "enhanced" } }],
              })
            ),
          },
        };
      },
    }));

    resetEnhancementClient();
    const { enhanceText: enhance } = await import("../lib/enhancer.js");
    resetEnhancementClient();

    const customConfig = { ...config, enhancement_api_key: "sk-enhance-key", openai_api_key: "sk-openai-key" };
    await enhance("text", "instruction", customConfig);
    expect(capturedKey).toBe("sk-enhance-key");

    resetEnhancementClient();
  });
});

// ── processText ─────────────────────────────────────────────────────────────

describe("processText", () => {
  test("returns raw when auto_enhance is false", async () => {
    const noAutoConfig = { ...config, auto_enhance: false };
    const result = await processText("hello world", noAutoConfig);
    expect(result.mode).toBe("raw");
    expect(result.text).toBe("hello world");
    expect(result.enhancement_model).toBeNull();
  });

  test("returns raw for plain dictation even with auto_enhance", async () => {
    const result = await processText("I went to the store today", config);
    expect(result.mode).toBe("raw");
    expect(result.text).toBe("I went to the store today");
    expect(result.enhancement_model).toBeNull();
  });

  test("enhances text when trigger is detected", async () => {
    mock.module("openai", () => ({
      default: class MockOpenAI {
        chat = {
          completions: {
            create: mock(() =>
              Promise.resolve({
                choices: [{ message: { content: "Enhanced output here" } }],
              })
            ),
          },
        };
      },
    }));

    resetEnhancementClient();
    const { processText: process } = await import("../lib/enhancer.js");
    resetEnhancementClient();

    const result = await process("This needs work say it better", config);
    expect(result.mode).toBe("enhanced");
    expect(result.text).toBe("Enhanced output here");
    expect(result.enhancement_model).toBe(config.enhancement_model);

    resetEnhancementClient();
  });

  test("enhances text when instruction pattern is detected", async () => {
    mock.module("openai", () => ({
      default: class MockOpenAI {
        chat = {
          completions: {
            create: mock(() =>
              Promise.resolve({
                choices: [{ message: { content: "Dear Team,\n\nI wanted to reach out..." } }],
              })
            ),
          },
        };
      },
    }));

    resetEnhancementClient();
    const { processText: process } = await import("../lib/enhancer.js");
    resetEnhancementClient();

    const result = await process("write an email saying we need to reschedule the meeting", config);
    expect(result.mode).toBe("enhanced");
    expect(result.text).toContain("Dear Team");
    expect(result.enhancement_model).toBe(config.enhancement_model);

    resetEnhancementClient();
  });
});

// ── systemPrompt support ──────────────────────────────────────────────────

describe("systemPrompt support", () => {
  test("processText passes systemPrompt through to enhanceText", async () => {
    let capturedMessages: Array<{ role: string; content: string }> = [];
    mock.module("openai", () => ({
      default: class MockOpenAI {
        chat = {
          completions: {
            create: mock((opts: { messages: Array<{ role: string; content: string }> }) => {
              capturedMessages = opts.messages;
              return Promise.resolve({
                choices: [{ message: { content: "Enhanced with context" } }],
              });
            }),
          },
        };
      },
    }));

    resetEnhancementClient();
    const { processText: process } = await import("../lib/enhancer.js");
    resetEnhancementClient();

    await process("write an email saying thanks", config, "You are working on the Acme project");
    expect(capturedMessages[0]!.content).toContain("Additional context:");
    expect(capturedMessages[0]!.content).toContain("Acme project");

    resetEnhancementClient();
  });

  test("processText works without systemPrompt", async () => {
    let capturedMessages: Array<{ role: string; content: string }> = [];
    mock.module("openai", () => ({
      default: class MockOpenAI {
        chat = {
          completions: {
            create: mock((opts: { messages: Array<{ role: string; content: string }> }) => {
              capturedMessages = opts.messages;
              return Promise.resolve({
                choices: [{ message: { content: "Enhanced without context" } }],
              });
            }),
          },
        };
      },
    }));

    resetEnhancementClient();
    const { processText: process } = await import("../lib/enhancer.js");
    resetEnhancementClient();

    await process("write an email saying thanks", config);
    expect(capturedMessages[0]!.content).not.toContain("Additional context:");

    resetEnhancementClient();
  });

  test("processText ignores systemPrompt for raw dictation", async () => {
    const result = await processText("Just a regular note", config, "project context");
    expect(result.mode).toBe("raw");
    expect(result.text).toBe("Just a regular note");
  });
});

// ── extractInstruction (tested via needsEnhancement) ────────────────────────

describe("extractInstruction behavior via needsEnhancement", () => {
  test("extracts content before trigger when before is longer", () => {
    // "before" = long content, "after" = short, before.length > 10
    const text = "This is a really long email draft that I wrote about the quarterly results and projections. Say it better";
    const result = needsEnhancement(text, config);
    expect(result.needs).toBe(true);
    // The instruction should be the content before the trigger
    expect(result.instruction).not.toContain("Say it better");
  });

  test("uses full text when after is longer than before", () => {
    const text = "Say it better and make sure to include all the important details about the project timeline and deliverables";
    const result = needsEnhancement(text, config);
    expect(result.needs).toBe(true);
    // After is longer, so full text is used
    expect(result.instruction).toBe(text);
  });

  test("uses full text when before is short (<=10 chars)", () => {
    const text = "Draft. Say it better and elaborate";
    const result = needsEnhancement(text, config);
    expect(result.needs).toBe(true);
    // Before is <= 10 chars, so full text is used
    expect(result.instruction).toBe(text);
  });
});
