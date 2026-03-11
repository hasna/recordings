import OpenAI from "openai";
import { createReadStream } from "fs";
import type { RecordingsConfig, TranscriptionResult } from "../types/index.js";
import { TranscriptionError } from "../types/index.js";

let _client: OpenAI | null = null;

function getClient(config: RecordingsConfig): OpenAI {
  if (_client) return _client;
  if (!config.openai_api_key) {
    throw new TranscriptionError(
      "OpenAI API key not configured. Set OPENAI_API_KEY env var or add to ~/.secrets"
    );
  }
  _client = new OpenAI({ apiKey: config.openai_api_key });
  return _client;
}

export function resetClient(): void {
  _client = null;
}

export async function transcribeAudio(
  audioPath: string,
  config: RecordingsConfig
): Promise<TranscriptionResult> {
  const client = getClient(config);
  const startTime = Date.now();

  try {
    const transcription = await client.audio.transcriptions.create({
      file: createReadStream(audioPath),
      model: config.transcription_model,
      language: config.language || undefined,
      response_format: "json",
    });

    const durationMs = Date.now() - startTime;

    return {
      text: transcription.text,
      duration_ms: durationMs,
      model: config.transcription_model,
      language: (transcription as unknown as Record<string, unknown>).language as string | null,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new TranscriptionError(`Transcription failed: ${msg}`);
  }
}

export async function transcribeBuffer(
  buffer: Buffer,
  filename: string,
  config: RecordingsConfig
): Promise<TranscriptionResult> {
  const client = getClient(config);
  const startTime = Date.now();

  try {
    const file = new File([new Uint8Array(buffer)], filename, {
      type: getMimeType(filename),
    });

    const transcription = await client.audio.transcriptions.create({
      file,
      model: config.transcription_model,
      language: config.language || undefined,
      response_format: "json",
    });

    const durationMs = Date.now() - startTime;

    return {
      text: transcription.text,
      duration_ms: durationMs,
      model: config.transcription_model,
      language: (transcription as unknown as Record<string, unknown>).language as string | null,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new TranscriptionError(`Transcription failed: ${msg}`);
  }
}

function getMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    case "m4a":
      return "audio/mp4";
    case "webm":
      return "audio/webm";
    case "mp4":
      return "audio/mp4";
    case "mpeg":
    case "mpga":
      return "audio/mpeg";
    default:
      return "audio/wav";
  }
}
