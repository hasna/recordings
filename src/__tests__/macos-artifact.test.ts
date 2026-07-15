import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MacOSArtifactManifest,
  assertCleanGitStatus,
  parseDesignatedRequirement,
  sha256File,
  verifyArchiveManifest,
} from "../../scripts/macos_artifact";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): {
  archivePath: string;
  manifestPath: string;
  manifest: MacOSArtifactManifest;
} {
  const root = mkdtempSync(join(tmpdir(), "recordings-artifact-"));
  temporaryDirectories.push(root);
  mkdirSync(root, { recursive: true });
  const archivePath = join(root, "Recordings-0.2.12-macos.zip");
  const manifestPath = join(root, "Recordings-0.2.12-macos.manifest.json");
  writeFileSync(archivePath, "immutable signed archive fixture");
  const manifest: MacOSArtifactManifest = {
    schema_version: 1,
    artifact_type: "recordings-macos-app",
    bundle_id: "com.hasna.recordings",
    bundle_version: "0.2.12",
    git_sha: "a".repeat(40),
    architectures: ["arm64"],
    team_id: "EXAMPLE123",
    app_sha256: "b".repeat(64),
    provenance_sha256: "c".repeat(64),
    companion: { version: "0.2.12", sha256: "d".repeat(64) },
    signing: {
      authority: "Developer ID Application: Example Corp (EXAMPLE123)",
      team_id: "EXAMPLE123",
      trusted_timestamp: "Jul 15, 2026 at 12:00:00",
      helper_authority: "Developer ID Application: Example Corp (EXAMPLE123)",
      helper_team_id: "EXAMPLE123",
      helper_trusted_timestamp: "Jul 15, 2026 at 12:00:00",
      designated_requirement_sha256: "e".repeat(64),
    },
    archive: {
      filename: "Recordings-0.2.12-macos.zip",
      sha256: sha256File(archivePath),
    },
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { archivePath, manifestPath, manifest };
}

describe("macOS artifact manifest", () => {
  test("refuses to bind a git SHA to uncommitted source", () => {
    expect(() => assertCleanGitStatus(" M src/cli/index.ts\n")).toThrow("dirty source worktree");
    expect(() => assertCleanGitStatus("?? local-source.ts\n")).toThrow("dirty source worktree");
    expect(() => assertCleanGitStatus("\n")).not.toThrow();
  });

  test("hashes only the designated requirement and ignores extraction-path diagnostics", () => {
    const requirement = 'identifier "com.hasna.recordings" and anchor apple generic';
    expect(
      parseDesignatedRequirement(
        `Executable=/tmp/build/Recordings.app\ndesignated => ${requirement}\n`,
      ),
    ).toBe(requirement);
    expect(
      parseDesignatedRequirement(
        `Executable=/Users/example/Applications/Recordings.app\ndesignated => ${requirement}\n`,
      ),
    ).toBe(requirement);
  });

  test("accepts an intact archive bound to the required Team ID", () => {
    const { archivePath, manifestPath } = fixture();
    const manifest = verifyArchiveManifest(archivePath, manifestPath, "EXAMPLE123");
    expect(manifest.bundle_id).toBe("com.hasna.recordings");
  });

  test("rejects archive tampering and checksum mismatch", () => {
    const { archivePath, manifestPath } = fixture();
    writeFileSync(archivePath, `${readFileSync(archivePath, "utf8")}tampered`);
    expect(() => verifyArchiveManifest(archivePath, manifestPath, "EXAMPLE123")).toThrow(
      "archive checksum",
    );
  });

  test("rejects manifest signer tampering", () => {
    const { archivePath, manifestPath, manifest } = fixture();
    manifest.team_id = "OTHERTEAM";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => verifyArchiveManifest(archivePath, manifestPath, "EXAMPLE123")).toThrow(
      "manifest Team ID",
    );
  });

  test("rejects a renamed archive not bound by the manifest", () => {
    const { archivePath, manifestPath } = fixture();
    const renamed = join(tmpdir(), `renamed-recordings-${Date.now()}.zip`);
    temporaryDirectories.push(renamed);
    writeFileSync(renamed, readFileSync(archivePath));
    expect(() => verifyArchiveManifest(renamed, manifestPath, "EXAMPLE123")).toThrow(
      "archive filename",
    );
  });
});
