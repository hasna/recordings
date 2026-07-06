/**
 * @hasna/recordings SDK — typed `/v1` cloud client.
 *
 * Generated from the serve OpenAPI document (src/server/openapi.ts). Regenerate
 * with `bun run generate:sdk`.
 *
 *   import { RecordingsV1Client } from "@hasna/recordings/sdk";
 *   const client = new RecordingsV1Client({
 *     baseUrl: process.env.RECORDINGS_API_URL!,
 *     apiKey: process.env.RECORDINGS_API_KEY!,
 *   });
 *   const { recordings } = await client.listRecordings({ limit: 20 });
 */
export {
  RecordingsV1Client,
  ApiError as RecordingsV1ApiError,
} from "./v1.generated.js";
export type {
  RecordingsV1ClientOptions,
  Recording as RecordingsV1Recording,
  Agent as RecordingsV1Agent,
  Project as RecordingsV1Project,
  CreateRecordingInput as RecordingsV1CreateRecordingInput,
  RegisterAgentInput as RecordingsV1RegisterAgentInput,
  RegisterProjectInput as RecordingsV1RegisterProjectInput,
} from "./v1.generated.js";
