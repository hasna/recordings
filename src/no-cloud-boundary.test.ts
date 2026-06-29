import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import packageJson from "../package.json";

const repoRoot = join(import.meta.dir, "..");

const forbiddenRuntimeMarkers = [
  ["@hasna", "cloud"].join("/"),
  ["open", "cloud"].join("-"),
  ["cloud", "mcp"].join("-"),
  "register" + "CloudTools",
  "register" + "CloudCommands",
  ["HASNA", "CLOUD"].join("_"),
  ["OPEN", "CLOUD"].join("_"),
  [".hasna", "cloud"].join("/"),
  "--" + "cloud",
  ["cloud", "setup"].join(" "),
  ["cloud", "sync"].join(" "),
  ["Cloud", "Sync"].join(" "),
  ["HASNA", ["R", "D", "S"].join(""), "PASSWORD"].join("_"),
];

const forbiddenRuntimePatterns = [
  new RegExp("\\b" + ["r", "d", "s"].join("") + "\\b", "i"),
];

const runtimeRoots = [
  "README.md",
  "package.json",
  "src/cli",
  "src/db",
  "src/lib",
  "src/mcp",
  "src/storage.ts",
  "src/index.ts",
  "scripts",
];

function collectFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];

  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".git") return [];
    return collectFiles(join(path, entry.name));
  });
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

describe("no private cloud package boundary", () => {
  test("package metadata and lockfile do not depend on private cloud packages", () => {
    const manifests = [packageJson, ...collectFiles(repoRoot).filter((file) => file.endsWith("package.json")).map((file) => JSON.parse(readText(file)))];
    const deps = manifests.flatMap((manifest) => [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]);

    expect(deps).not.toContain(["@hasna", "cloud"].join("/"));

    const lockfile = readText(join(repoRoot, "bun.lock"));
    expect(lockfile).not.toContain(["@hasna", "cloud"].join("/"));
    expect(lockfile).not.toContain(["open", "cloud"].join("-"));
  });

  test("runtime source, docs, and scripts avoid retired shared cloud markers", () => {
    const offenders: Array<{ file: string; marker: string }> = [];

    for (const file of runtimeRoots.flatMap((root) => collectFiles(join(repoRoot, root)))) {
      const content = readText(file);
      for (const marker of forbiddenRuntimeMarkers) {
        if (content.includes(marker)) {
          offenders.push({ file: relative(repoRoot, file), marker });
        }
      }
      for (const pattern of forbiddenRuntimePatterns) {
        if (pattern.test(content)) {
          offenders.push({ file: relative(repoRoot, file), marker: pattern.source });
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("public storage surface is recordings-native", () => {
    const entrypoint = readText(join(repoRoot, "src/index.ts"));
    const storageEntrypoint = readText(join(repoRoot, "src/storage.ts"));
    const storageConfig = readText(join(repoRoot, "src/db/storage-config.ts"));
    const cliStorage = readText(join(repoRoot, "src/cli/storage.ts"));
    const mcpStorage = readText(join(repoRoot, "src/mcp/storage-tools.ts"));

    expect(storageConfig).toContain("HASNA_RECORDINGS_DATABASE_URL");
    expect(storageConfig).toContain("postgres");
    expect(storageEntrypoint).toContain("RECORDINGS_STORAGE_ENV");
    expect(cliStorage).toContain("registerStorageCommands");
    expect(mcpStorage).toContain("recordings_storage_status");
    expect(entrypoint).not.toContain(["@hasna", "cloud"].join("/"));
  });
});
