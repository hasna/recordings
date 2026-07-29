// Deployment modes are removed. These tests pin the REMOVAL, not the rename.
//
// Two behaviours are separated everywhere below:
//   (a) a retired deployment word is silently normalized to something that works
//   (b) a retired deployment word is refused, naming the variable and value to use
// (a) is what this repo did. Every assertion here fails against (a).

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveStorageClient, resolveTransport } from "../http/client.js";
import {
  configuredDataBackend,
  isPostgresBackendEnabled,
  resolveDataBackend,
} from "../server/cloud-config.js";
import {
  RETIRED_DEPLOYMENT_MODES,
  asRetiredDeploymentMode,
} from "../lib/retired-deployment-modes.js";
import { getStore } from "../store.js";

const APP = "recordings";
const CLIENT_STORE_KEY = "HASNA_RECORDINGS_CLIENT_STORE";
const BACKEND_KEY = "HASNA_RECORDINGS_STORAGE_MODE";

// The manifest and code spellings differ; both must be caught.
const RETIRED_SPELLINGS = [...RETIRED_DEPLOYMENT_MODES, "self-hosted", "SELF_HOSTED", " Remote "];

describe("retired deployment words are recognized in both spellings", () => {
  test("self_hosted and self-hosted are the same retired word", () => {
    expect(asRetiredDeploymentMode("self_hosted")).toBe("self_hosted");
    expect(asRetiredDeploymentMode("self-hosted")).toBe("self_hosted");
    expect(asRetiredDeploymentMode("SELF-HOSTED")).toBe("self_hosted");
  });

  test("a live value is not mistaken for a retired one", () => {
    for (const live of ["sqlite", "postgresql", "postgres", "http"]) {
      expect(asRetiredDeploymentMode(live)).toBeNull();
    }
  });
});

describe("client store: sqlite | http, and nothing else", () => {
  test("every retired word in every legacy mode variable throws, naming the replacement", () => {
    const legacyKeys = [
      "HASNA_RECORDINGS_STORAGE_MODE",
      "HASNA_RECORDINGS_MODE",
      "RECORDINGS_STORAGE_MODE",
      "RECORDINGS_MODE",
    ];
    let checked = 0;
    for (const key of legacyKeys) {
      for (const word of RETIRED_SPELLINGS) {
        const expectedValue = asRetiredDeploymentMode(word) === "local" ? "sqlite" : "http";
        let message = "";
        try {
          resolveTransport(APP, {
            [key]: word,
            HASNA_RECORDINGS_API_URL: "https://recordings.hasna.xyz",
            HASNA_RECORDINGS_API_KEY: "test-key",
          });
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message, `${key}=${word} must be refused`).toContain("deployment modes are removed");
        expect(message).toContain(key);
        expect(message).toContain(`${CLIENT_STORE_KEY}=${expectedValue}`);
        checked += 1;
      }
    }
    // A loop that silently ran zero times would pass every assertion above.
    expect(checked).toBe(legacyKeys.length * RETIRED_SPELLINGS.length);
  });

  test("the explicit sqlite override still beats a present API url + key", () => {
    const r = resolveTransport(APP, {
      [CLIENT_STORE_KEY]: "sqlite",
      HASNA_RECORDINGS_API_URL: "https://recordings.hasna.xyz",
      HASNA_RECORDINGS_API_KEY: "test-key",
    });
    expect(r.transport).toBe("sqlite");
    expect(r.modeSource).toBe(CLIENT_STORE_KEY);
  });

  test("http + url + key routes to the /v1 API", () => {
    const r = resolveTransport(APP, {
      [CLIENT_STORE_KEY]: "http",
      HASNA_RECORDINGS_API_URL: "https://recordings.hasna.xyz",
      HASNA_RECORDINGS_API_KEY: "test-key",
    });
    expect(r.transport).toBe("http");
    expect(r.baseUrl).toBe("https://recordings.hasna.xyz/v1");
  });

  test("http without a key is misconfigured, and resolveStorageClient refuses it", () => {
    const r = resolveTransport(APP, { [CLIENT_STORE_KEY]: "http" });
    expect(r.transport).toBe("sqlite");
    expect(r.misconfigured).toBe(true);
    expect(() => resolveStorageClient(APP, { [CLIENT_STORE_KEY]: "http" })).toThrow();
  });

  test("an unknown client store is refused rather than defaulting to on-box", () => {
    expect(() => resolveTransport(APP, { [CLIENT_STORE_KEY]: "postgresql" })).toThrow(
      "Unknown client store",
    );
    expect(() => resolveTransport(APP, { [CLIENT_STORE_KEY]: "kloud" })).toThrow(
      "Unknown client store",
    );
  });

  test("the SERVER's backend variable does not steer the client", () => {
    // recordings-serve sets this; a CLI in the same container inherits it.
    for (const backend of ["sqlite", "postgresql", "postgres"]) {
      const flipped = resolveTransport(APP, {
        [BACKEND_KEY]: backend,
        HASNA_RECORDINGS_API_URL: "https://recordings.hasna.xyz",
        HASNA_RECORDINGS_API_KEY: "test-key",
      });
      expect(flipped.transport, `${BACKEND_KEY}=${backend} must not veto the flip`).toBe("http");
      expect(resolveTransport(APP, { [BACKEND_KEY]: backend }).transport).toBe("sqlite");
    }
  });

  test("getStore reports the store by backend name, never by placement", () => {
    expect(getStore({}).mode).toBe("sqlite");
    expect(
      getStore({
        HASNA_RECORDINGS_API_URL: "https://recordings.hasna.xyz",
        HASNA_RECORDINGS_API_KEY: "test-key",
      }).mode,
    ).toBe("http");
  });
});

describe("server data backend: sqlite | postgresql, and nothing else", () => {
  test("every retired word throws, naming postgresql or sqlite", () => {
    let checked = 0;
    for (const key of ["HASNA_RECORDINGS_STORAGE_MODE", "RECORDINGS_STORAGE_MODE"]) {
      for (const word of RETIRED_SPELLINGS) {
        const expectedValue = asRetiredDeploymentMode(word) === "local" ? "sqlite" : "postgresql";
        let message = "";
        try {
          isPostgresBackendEnabled({ [key]: word } as NodeJS.ProcessEnv);
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message, `${key}=${word} must be refused`).toContain("deployment modes are removed");
        expect(message).toContain(`${BACKEND_KEY}=${expectedValue}`);
        checked += 1;
      }
    }
    expect(checked).toBe(2 * RETIRED_SPELLINGS.length);
  });

  test("both Postgres spellings and sqlite are accepted", () => {
    expect(resolveDataBackend({ [BACKEND_KEY]: "postgresql" } as NodeJS.ProcessEnv)).toBe("postgresql");
    expect(resolveDataBackend({ [BACKEND_KEY]: "postgres" } as NodeJS.ProcessEnv)).toBe("postgresql");
    expect(resolveDataBackend({ [BACKEND_KEY]: "SQLite" } as NodeJS.ProcessEnv)).toBe("sqlite");
    expect(configuredDataBackend({} as NodeJS.ProcessEnv)).toBeNull();
  });

  test("an unrecognized value is refused instead of falling through to DSN presence", () => {
    // The defect: `remote|hybrid` meant Postgres and EVERY other value — a typo,
    // or `self_hosted` — silently became "is a DATABASE_URL set?".
    expect(() =>
      isPostgresBackendEnabled({
        [BACKEND_KEY]: "remoote",
        HASNA_RECORDINGS_DATABASE_URL: "postgres://u@h/db",
      } as NodeJS.ProcessEnv),
    ).toThrow("is not a data backend");
  });

  test("an explicit sqlite backend wins over a present DSN", () => {
    expect(
      isPostgresBackendEnabled({
        [BACKEND_KEY]: "sqlite",
        HASNA_RECORDINGS_DATABASE_URL: "postgres://u@h/db",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  test("a DSN alone still selects postgresql", () => {
    expect(
      isPostgresBackendEnabled({ DATABASE_URL: "postgres://u@h/db" } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(isPostgresBackendEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

// ── Source guard ─────────────────────────────────────────────────────────────
//
// A mode variable set to a retired placement word anywhere in the tree would
// re-create the thing being removed, and would do it in a file nobody reruns.

const MODE_ASSIGNMENT = new RegExp(
  String.raw`\b[A-Z][A-Z0-9_]*_(?:MODE|STORE)\b\s*[:=]\s*["']?\s*(local|self[_-]hosted|cloud|remote|hybrid)\b`,
  "i",
);

const GUARDED_ROOTS = [
  "src",
  "scripts",
  "Dockerfile",
  "Dockerfile.package",
  "docker-compose.yml",
  "README.md",
];

// Named exceptions, with the reason. An unexplained exception is a hole.
const GUARD_EXEMPT = new Set([
  // The one place allowed to name the retired words: it exists to refuse them.
  "src/lib/retired-deployment-modes.ts",
  // This file quotes them in order to assert they are refused.
  "src/__tests__/deployment-modes-removed.test.ts",
]);

// hasna.contract.json is NOT scanned: its `storage.mode` enum is owned by
// hasna/contracts, which is mid-change. Editing that value here would validate
// against neither the pinned schema nor the in-flight one. Deliberate seam.

const repoRoot = join(import.meta.dir, "..", "..");

function collectFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".build") return [];
    return collectFiles(join(path, entry.name));
  });
}

describe("no mode variable is set to a retired deployment word", () => {
  test("the guard detects a planted assignment (positive control)", () => {
    for (const planted of [
      `HASNA_RECORDINGS_STORAGE_MODE: "local"`,
      `HASNA_RECORDINGS_STORAGE_MODE=remote`,
      `HASNA_APP_MODE=self_hosted`,
      `RECORDINGS_STORAGE_MODE: self-hosted`,
      `HASNA_RECORDINGS_CLIENT_STORE="cloud"`,
      `      HASNA_RECORDINGS_STORAGE_MODE: hybrid`,
    ]) {
      expect(MODE_ASSIGNMENT.test(planted), `guard missed: ${planted}`).toBe(true);
    }
    // …and does not fire on the live vocabulary, or on unrelated *_MODE vars.
    for (const clean of [
      `HASNA_RECORDINGS_STORAGE_MODE=postgresql`,
      `HASNA_RECORDINGS_CLIENT_STORE: "sqlite"`,
      `RECORDINGS_POST_PROCESSING_MODE=always`,
      `SMOKE_MODE="$mode"`,
    ]) {
      expect(MODE_ASSIGNMENT.test(clean), `guard false-positive: ${clean}`).toBe(false);
    }
  });

  test("no guarded file assigns a retired word to a mode variable", () => {
    const files = GUARDED_ROOTS.flatMap((root) => collectFiles(join(repoRoot, root)));
    // An empty file list would make the assertion below vacuous.
    expect(files.length).toBeGreaterThan(100);

    const offenders: Array<{ file: string; line: number; text: string }> = [];
    let scanned = 0;
    for (const file of files) {
      const rel = relative(repoRoot, file);
      if (GUARD_EXEMPT.has(rel)) continue;
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue; // binary or unreadable fixture
      }
      scanned += 1;
      content.split("\n").forEach((text, index) => {
        if (MODE_ASSIGNMENT.test(text)) offenders.push({ file: rel, line: index + 1, text: text.trim() });
      });
    }
    expect(scanned).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
