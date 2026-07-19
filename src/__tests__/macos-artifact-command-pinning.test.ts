import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];
const testOnNonDarwin = process.platform === "darwin" ? test.skip : test;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("macOS artifact command pinning", () => {
  test("production requirement digests use the Darwin-pinned codesign executable", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "scripts", "macos_artifact.ts"),
      "utf8",
    );
    const requirementDigestSource = source.slice(
      source.indexOf("function requirementDigest("),
      source.indexOf("function assertFilesystemTree("),
    );
    expect(source).toContain(
      'const CODESIGN_EXECUTABLE = process.platform === "darwin"\n  ? "/usr/bin/codesign"',
    );
    expect(source).not.toContain('run("codesign"');
    expect(requirementDigestSource).toContain(
      'run(CODESIGN_EXECUTABLE, ["-d", "-r-", appPath])',
    );
  });

  testOnNonDarwin("real release requirement digests ignore hostile PATH codesign evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "recordings-requirement-command-pinning-"));
    temporaryDirectories.push(root);
    const hostileBin = join(root, "hostile-bin");
    const appPath = join(root, "Recordings.app");
    const hostileMarker = join(root, "hostile-codesign-invoked");
    const pinnedCodesign = join(root, "pinned-codesign");
    mkdirSync(hostileBin);
    mkdirSync(appPath);
    writeExecutable(
      join(hostileBin, "codesign"),
      `#!/bin/sh
printf invoked > "${hostileMarker}"
printf '%s\n' 'designated => identifier "com.attacker.recordings"' >&2
`,
    );
    writeExecutable(
      pinnedCodesign,
      `#!/bin/sh
printf '%s\n' "\${PINNED_CODESIGN_EVIDENCE:-}" >&2
`,
    );

    const runRequirementDigest = (evidence: string) => Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "..", "..", "scripts", "macos_artifact.ts"),
        "requirement-digest",
        "--app",
        appPath,
        "--artifact-policy",
        "release",
      ],
      {
        env: {
          ...Bun.env,
          PATH: `${hostileBin}:/usr/bin:/bin`,
          PINNED_CODESIGN_EVIDENCE: evidence,
          RECORDINGS_TEST_MACOS_ARTIFACT_CODESIGN_EXECUTABLE: pinnedCodesign,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const trustedRequirement = 'identifier "com.hasna.recordings" and anchor apple generic';
    const trusted = runRequirementDigest(`designated => ${trustedRequirement}`);
    expect(trusted.exitCode, trusted.stderr.toString()).toBe(0);
    expect(trusted.stdout.toString().trim()).toBe(sha256(trustedRequirement));
    expect(existsSync(hostileMarker)).toBeFalse();

    const unexpectedSigner = runRequirementDigest("Authority=Unexpected Signer");
    expect(unexpectedSigner.exitCode).not.toBe(0);
    expect(unexpectedSigner.stderr.toString()).toContain(
      "code signature is missing a designated requirement",
    );
    expect(existsSync(hostileMarker)).toBeFalse();
  });
});
