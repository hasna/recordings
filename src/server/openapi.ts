/**
 * OpenAPI 3.1 document for the versioned `/v1` cloud API. This is the SINGLE
 * source of truth the typed SDK is generated from (see scripts/generate-sdk.ts)
 * and is served live at `GET /openapi.json` and `GET /v1/openapi.json`.
 */
import { VERSION } from "../version.js";

const recordingSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    audio_path: { type: "string", nullable: true },
    raw_text: { type: "string" },
    processed_text: { type: "string", nullable: true },
    processing_mode: { type: "string", enum: ["raw", "enhanced"] },
    model_used: { type: "string" },
    enhancement_model: { type: "string", nullable: true },
    duration_ms: { type: "number" },
    language: { type: "string", nullable: true },
    tags: { type: "array", items: { type: "string" } },
    agent_id: { type: "string", nullable: true },
    project_id: { type: "string", nullable: true },
    session_id: { type: "string", nullable: true },
    goal: { type: "string", nullable: true },
    role: { type: "string", nullable: true },
    task_list_id: { type: "string", nullable: true },
    machine_id: { type: "string", nullable: true },
    metadata: { type: "object", additionalProperties: true },
    created_at: { type: "string" },
  },
} as const;

const agentSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    description: { type: "string", nullable: true },
    role: { type: "string" },
    metadata: { type: "object", additionalProperties: true },
    created_at: { type: "string" },
    last_seen_at: { type: "string" },
  },
} as const;

const projectSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    path: { type: "string" },
    description: { type: "string", nullable: true },
    created_at: { type: "string" },
    updated_at: { type: "string" },
  },
} as const;

export function buildV1OpenApiDocument(version = VERSION) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Recordings V1 API",
      version,
      description:
        "Versioned cloud API for @hasna/recordings (A1 pure-remote). Authenticate with an API key via the `x-api-key` header or `Authorization: Bearer <token>`. Reads require the `recordings:read` scope, writes require `recordings:write` (a `recordings:*` key satisfies both).",
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
      },
      schemas: {
        Recording: recordingSchema,
        Agent: agentSchema,
        Project: projectSchema,
        CreateRecordingInput: {
          type: "object",
          required: ["raw_text"],
          properties: {
            id: { type: "string" },
            raw_text: { type: "string" },
            audio_path: { type: "string" },
            processed_text: { type: "string" },
            processing_mode: { type: "string", enum: ["raw", "enhanced"] },
            model_used: { type: "string" },
            enhancement_model: { type: "string" },
            duration_ms: { type: "number" },
            language: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            agent_id: { type: "string" },
            project_id: { type: "string" },
            session_id: { type: "string" },
            goal: { type: "string" },
            role: { type: "string" },
            task_list_id: { type: "string" },
            machine_id: { type: "string" },
            metadata: { type: "object", additionalProperties: true },
          },
        },
        RegisterAgentInput: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            role: { type: "string" },
          },
        },
        RegisterProjectInput: {
          type: "object",
          required: ["name", "path"],
          properties: {
            name: { type: "string" },
            path: { type: "string" },
            description: { type: "string" },
          },
        },
      },
    },
    security: [{ apiKey: [] }],
    paths: {
      "/v1/recordings": {
        get: {
          operationId: "listRecordings",
          summary: "List recordings",
          parameters: [
            { name: "agent_id", in: "query", schema: { type: "string" } },
            { name: "project_id", in: "query", schema: { type: "string" } },
            { name: "session_id", in: "query", schema: { type: "string" } },
            { name: "processing_mode", in: "query", schema: { type: "string", enum: ["raw", "enhanced"] } },
            { name: "tags", in: "query", style: "form", explode: true, schema: { type: "array", items: { type: "string" } } },
            { name: "search", in: "query", schema: { type: "string" } },
            { name: "since", in: "query", schema: { type: "string" } },
            { name: "until", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer" } },
            { name: "offset", in: "query", schema: { type: "integer" } },
          ],
          responses: {
            "200": {
              description: "List of recordings",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      recordings: { type: "array", items: { $ref: "#/components/schemas/Recording" } },
                      count: { type: "integer", description: "Total matching recordings before pagination" },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          operationId: "createRecording",
          summary: "Create a recording",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/CreateRecordingInput" } },
            },
          },
          responses: {
            "201": {
              description: "Created recording",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { recording: { $ref: "#/components/schemas/Recording" } },
                  },
                },
              },
            },
          },
        },
      },
      "/v1/recordings/{id}": {
        get: {
          operationId: "getRecording",
          summary: "Get a recording by id",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "The recording",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { recording: { $ref: "#/components/schemas/Recording" } },
                  },
                },
              },
            },
            "404": { description: "Not found" },
          },
        },
        delete: {
          operationId: "deleteRecording",
          summary: "Delete a recording by id",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "Deletion result",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { deleted: { type: "boolean" } } },
                },
              },
            },
          },
        },
      },
      "/v1/stats": {
        get: {
          operationId: "getRecordingStats",
          summary: "Aggregate recording statistics",
          responses: {
            "200": {
              description: "Stats",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      total: { type: "integer" },
                      raw: { type: "integer" },
                      enhanced: { type: "integer" },
                      total_duration_ms: { type: "number" },
                      by_model: { type: "object", additionalProperties: { type: "integer" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/v1/agents": {
        get: {
          operationId: "listAgents",
          summary: "List agents",
          responses: {
            "200": {
              description: "List of agents",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      agents: { type: "array", items: { $ref: "#/components/schemas/Agent" } },
                      count: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          operationId: "registerAgent",
          summary: "Register (upsert) an agent",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/RegisterAgentInput" } },
            },
          },
          responses: {
            "201": {
              description: "The agent",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { agent: { $ref: "#/components/schemas/Agent" } } },
                },
              },
            },
          },
        },
      },
      "/v1/agents/{id}": {
        get: {
          operationId: "getAgent",
          summary: "Get an agent by id or name",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "The agent",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { agent: { $ref: "#/components/schemas/Agent" } } },
                },
              },
            },
            "404": { description: "Not found" },
          },
        },
      },
      "/v1/projects": {
        get: {
          operationId: "listProjects",
          summary: "List projects",
          responses: {
            "200": {
              description: "List of projects",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      projects: { type: "array", items: { $ref: "#/components/schemas/Project" } },
                      count: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          operationId: "registerProject",
          summary: "Register (upsert) a project",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/RegisterProjectInput" } },
            },
          },
          responses: {
            "201": {
              description: "The project",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { project: { $ref: "#/components/schemas/Project" } } },
                },
              },
            },
          },
        },
      },
      "/v1/projects/{id}": {
        get: {
          operationId: "getProject",
          summary: "Get a project by id or path",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "The project",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { project: { $ref: "#/components/schemas/Project" } } },
                },
              },
            },
            "404": { description: "Not found" },
          },
        },
      },
    },
  };
}
