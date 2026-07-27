#!/usr/bin/env bun
// Single writer for every copy of the release version. package.json is the
// authority because scripts/build_companion_cli.sh derives EXPECTED_VERSION from
// it and rejects a compiled CLI whose --version disagrees, which aborts
// src/native/Recordings/build.sh under set -euo pipefail.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type VersionSite = {
  /** Repo-relative file carrying a copy of the release version. */
  file: string;
  /** Label used in check output. */
  label: string;
  /** Group 2 is the version; groups 1 and 3 are preserved verbatim on write. */
  pattern: RegExp;
};

export const versionSites: VersionSite[] = [
  {
    file: "package.json",
    label: "package.json version",
    pattern: /("version"\s*:\s*")([^"]+)(")/,
  },
  {
    file: "src/version.ts",
    label: "src/version.ts VERSION",
    pattern: /(export const VERSION = ")([^"]+)(")/,
  },
  {
    file: "src/native/Recordings/RecordingsLib/Info.plist",
    label: "Info.plist CFBundleShortVersionString",
    pattern: /(<key>CFBundleShortVersionString<\/key>\s*<string>)([^<]+)(<\/string>)/,
  },
  {
    file: "src/native/Recordings/RecordingsLib/Info.plist",
    label: "Info.plist CFBundleVersion",
    pattern: /(<key>CFBundleVersion<\/key>\s*<string>)([^<]+)(<\/string>)/,
  },
];

export type SiteReading = {
  site: VersionSite;
  version: string;
};

export type VersionCheck = {
  expected: string;
  readings: SiteReading[];
  mismatched: SiteReading[];
};

// The authority is whichever site the build script reads, so it stays first.
const authoritySite = versionSites[0];

export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

// Rejects a leading "v" the same way prepareReleaseInstallInputs does, so a
// bump cannot introduce a form the release path already refuses.
export function assertReleaseVersion(version: string): string {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`invalid release version: ${version} (expected MAJOR.MINOR.PATCH)`);
  }
  return version;
}

function readSite(root: string, site: VersionSite): SiteReading {
  const match = readFileSync(join(root, site.file), "utf8").match(site.pattern);
  if (!match) {
    throw new Error(`${site.file}: no version found for ${site.label}`);
  }
  return { site, version: match[2] };
}

export function checkVersionSites(root: string = repoRoot()): VersionCheck {
  const readings = versionSites.map((site) => readSite(root, site));
  const authority = readings.find((reading) => reading.site === authoritySite);
  if (!authority) {
    throw new Error(`missing authority version site: ${authoritySite.label}`);
  }
  const expected = authority.version;
  return {
    expected,
    readings,
    mismatched: readings.filter((reading) => reading.version !== expected),
  };
}

export function applyVersion(version: string, root: string = repoRoot()): SiteReading[] {
  assertReleaseVersion(version);

  // Group by file so two sites in one file (the plist) do not clobber each other.
  const files = [...new Set(versionSites.map((site) => site.file))];
  for (const file of files) {
    const path = join(root, file);
    let contents = readFileSync(path, "utf8");
    for (const site of versionSites.filter((candidate) => candidate.file === file)) {
      if (!site.pattern.test(contents)) {
        throw new Error(`${file}: no version found for ${site.label}`);
      }
      contents = contents.replace(site.pattern, `$1${version}$3`);
    }
    writeFileSync(path, contents);
  }

  return versionSites.map((site) => ({ site, version }));
}

function main(argv: string[]): void {
  const [command] = argv;

  if (command === undefined || command === "--check" || command === "check") {
    const { expected, readings, mismatched } = checkVersionSites();
    if (mismatched.length > 0) {
      console.error(`Version sites disagree (${authoritySite.label} says ${expected}):`);
      for (const reading of mismatched) {
        console.error(`  ${reading.site.label}: ${reading.version}`);
      }
      console.error("Fix with: bun run version:set <version>");
      process.exit(1);
    }
    console.log(`Version sites agree at ${expected} (${readings.length} sites).`);
    return;
  }

  if (command === "--help" || command === "-h") {
    console.log("Usage: bun run scripts/set-version.ts [--check | <version>]");
    return;
  }

  for (const reading of applyVersion(command)) {
    console.log(`  ${reading.site.label} -> ${reading.version}`);
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
