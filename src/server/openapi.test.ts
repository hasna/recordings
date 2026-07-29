import { describe, expect, test } from "bun:test";
import { VERSION } from "../version.js";
import { buildV1OpenApiDocument } from "./openapi.js";

describe("V1 OpenAPI document", () => {
  test("builds the published document with the package version and auth contract", () => {
    const document = buildV1OpenApiDocument();

    expect(document.openapi).toBe("3.1.0");
    expect(document.info).toMatchObject({
      title: "Recordings V1 API",
      version: VERSION,
    });
    expect(document.security).toEqual([{ apiKey: [] }]);
    expect(document.components.securitySchemes.apiKey).toEqual({
      type: "apiKey",
      in: "header",
      name: "x-api-key",
    });
  });

  test("uses an explicit release version without changing later default documents", () => {
    const release = buildV1OpenApiDocument("9.8.7-beta.1");
    const current = buildV1OpenApiDocument();

    expect(release.info.version).toBe("9.8.7-beta.1");
    expect(current.info.version).toBe(VERSION);
  });

  test("publishes unique operation IDs for every supported route and method", () => {
    const document = buildV1OpenApiDocument();
    const paths = document.paths as Record<string, Record<string, { operationId?: string }>>;
    const operations = Object.entries(paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, operation]) => ({
        path,
        method,
        operationId: operation.operationId,
      })),
    );

    expect(operations).toHaveLength(11);
    expect(operations.map(({ operationId }) => operationId).sort()).toEqual([
      "createRecording",
      "deleteRecording",
      "getAgent",
      "getProject",
      "getRecording",
      "getRecordingStats",
      "listAgents",
      "listProjects",
      "listRecordings",
      "registerAgent",
      "registerProject",
    ].sort());
    expect(new Set(operations.map(({ operationId }) => operationId)).size).toBe(operations.length);
    expect(operations).toContainEqual({
      path: "/v1/recordings/{id}",
      method: "delete",
      operationId: "deleteRecording",
    });
  });

  test("keeps required inputs, path parameters, and schema references resolvable", () => {
    const document = buildV1OpenApiDocument();
    expect(document.components.schemas.CreateRecordingInput.required).toEqual(["raw_text"]);
    expect(document.components.schemas.RegisterAgentInput.required).toEqual(["name"]);
    expect(document.components.schemas.RegisterProjectInput.required).toEqual(["name", "path"]);

    for (const route of [
      document.paths["/v1/recordings/{id}"].get,
      document.paths["/v1/recordings/{id}"].delete,
      document.paths["/v1/agents/{id}"].get,
      document.paths["/v1/projects/{id}"].get,
    ]) {
      expect(route.parameters).toContainEqual({
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string" },
      });
    }

    const serialized = JSON.stringify(document);
    const references = [...serialized.matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)]
      .map((match) => match[1]!);
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(document.components.schemas).toHaveProperty(reference);
    }
  });
});
