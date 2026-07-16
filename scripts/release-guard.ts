#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

type Finding = {
  file: string;
  marker: string;
  kind: "retired-cloud" | "secret-pattern";
};

type PatternCheck = {
  label: string;
  pattern: RegExp;
};

const repoRoot = process.cwd();

const roots = [
  "package.json",
  "README.md",
  "LICENSE",
  "Dockerfile.package",
  "bun.lock",
  "scripts",
  "src/storage.ts",
  "src/index.ts",
  "src/cli",
  "src/db",
  "src/lib",
  "src/mcp",
  "src/types",
  "src/native/Recordings/App",
  "src/native/Recordings/RecordingsLib",
  "src/native/Recordings/RecordingsTests",
  "src/native/Recordings/Package.swift",
  "src/native/Recordings/Package.resolved",
  "src/native/Recordings/build.sh",
  "dist",
];

const ignoredDirs = new Set([".git", "node_modules", ".build"]);

const retiredCloudMarkers = [
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

const secretPatterns: PatternCheck[] = [
  { label: ["sk", "ant", ""].join("-"), pattern: new RegExp(["sk", "ant", ""].join("-")) },
  { label: ["sk", "proj", ""].join("-"), pattern: new RegExp(["sk", "proj", ""].join("-")) },
  { label: ["npm", ""].join("_"), pattern: new RegExp(["npm", ""].join("_") + "[A-Za-z]") },
  { label: ["gho", ""].join("_"), pattern: new RegExp(["gho", ""].join("_")) },
  { label: ["ghp", ""].join("_"), pattern: new RegExp(["ghp", ""].join("_")) },
  { label: ["secret", "token"].join("-") + ":", pattern: new RegExp(["secret", "token"].join("-") + ":") },
  { label: "ctx7sk" + "-", pattern: new RegExp("ctx7sk" + "-") },
  { label: ["xai", ""].join("-"), pattern: new RegExp(["xai", ""].join("-")) },
  { label: "AI" + "za" + "[A-Za-z0-9]", pattern: new RegExp("AI" + "za" + "[A-Za-z0-9]") },
  { label: "AK" + "IA" + "[A-Z0-9]", pattern: new RegExp("AK" + "IA" + "[A-Z0-9]") },
];

const legacyDatabasePatterns: PatternCheck[] = [
  {
    label: ["legacy", "database", ["r", "d", "s"].join("-")].join("-"),
    pattern: new RegExp("\\b" + ["r", "d", "s"].join("") + "\\b", "i"),
  },
];

// These exact public CA locations are transport trust material, not the retired
// client-side database integration. No other token receives an exception.
const legacyDatabaseName = ["r", "d", "s"].join("");
const approvedPublicCaTokens = [
  `/etc/ssl/certs/${legacyDatabaseName}-global-bundle.pem`,
  `https://truststore.pki.${legacyDatabaseName}.amazonaws.com/global/global-bundle.pem`,
];

export function contentForLegacyDatabaseScan(relativeFile: string, content: string): string {
  if (relativeFile !== "Dockerfile.package") return content;
  return approvedPublicCaTokens.reduce((value, token) => value.split(token).join(""), content);
}

function isText(buffer: Buffer): boolean {
  return !buffer.includes(0);
}

function collectFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];

  const files: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    files.push(...collectFiles(join(path, entry.name)));
  }
  return files;
}

const findings: Finding[] = [];
for (const file of roots.flatMap((root) => collectFiles(join(repoRoot, root)))) {
  const buffer = readFileSync(file);
  if (!isText(buffer)) continue;

  const content = buffer.toString("utf8");
  const relativeFile = relative(repoRoot, file);

  for (const marker of retiredCloudMarkers) {
    if (content.includes(marker)) {
      findings.push({ file: relativeFile, marker, kind: "retired-cloud" });
    }
  }

  const legacyDatabaseContent = contentForLegacyDatabaseScan(relativeFile, content);
  for (const check of legacyDatabasePatterns) {
    if (check.pattern.test(legacyDatabaseContent)) {
      findings.push({ file: relativeFile, marker: check.label, kind: "retired-cloud" });
    }
  }

  for (const check of secretPatterns) {
    if (check.pattern.test(content)) {
      findings.push({ file: relativeFile, marker: check.label, kind: "secret-pattern" });
    }
  }
}

if (findings.length > 0) {
  console.error("Release guard failed:");
  for (const finding of findings) {
    console.error(`  ${finding.kind}: ${finding.file}: ${finding.marker}`);
  }
  process.exit(1);
}

console.log("Release guard passed: package-visible files are free of retired cloud and secret markers.");
