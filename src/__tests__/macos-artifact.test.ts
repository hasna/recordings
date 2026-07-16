import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MacOSArtifactManifest,
  assertCleanGitStatus,
  parseDesignatedRequirement,
  verifyArchiveManifest,
  compareVersions,
  sha256File as fileDigest,
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
    schema_version: 2,
    artifact_type: "recordings-macos-app",
    bundle_id: "com.hasna.recordings",
    bundle_version: "0.2.12",
    bundle_build_version: "0.2.12",
    git_sha: "a".repeat(40),
    architectures: ["arm64"],
    team_id: "EXAMPLE123",
    minimum_macos: "26.0",
    app_sha256: "b".repeat(64),
    provenance_sha256: "c".repeat(64),
    companion: { version: "0.2.12", sha256: "d".repeat(64), architectures: ["arm64"] },
    signing: {
      authority: "Developer ID Application: Example Corp (EXAMPLE123)",
      team_id: "EXAMPLE123",
      trusted_timestamp: "Jul 15, 2026 at 12:00:00",
      helper_authority: "Developer ID Application: Example Corp (EXAMPLE123)",
      helper_team_id: "EXAMPLE123",
      helper_trusted_timestamp: "Jul 15, 2026 at 12:00:00",
      designated_requirement_sha256: "e".repeat(64),
      helper_designated_requirement_sha256: "f".repeat(64),
      entitlements_sha256: "1".repeat(64),
      helper_entitlements_sha256: "2".repeat(64),
    },
    notarization: {
      submission_id: "11111111-1111-4111-8111-111111111111",
      status: "Accepted",
      log_sha256: "3".repeat(64),
      issue_count: 0,
      submitted_archive_sha256: "4".repeat(64),
      stapled: true,
      distribution_check: true,
    },
    container: { type: "zip", install_locations: ["~/Applications/Recordings.app"] },
    nested_code_policy: {
      allowlist_sha256: "",
      items: [
        { path: ".", team_id: "EXAMPLE123", runtime: true, timestamp_required: true, architectures: ["arm64"], entitlements_sha256: "1".repeat(64) },
        { path: "Contents/Helpers/recordings", team_id: "EXAMPLE123", runtime: true, timestamp_required: true, architectures: ["arm64"], entitlements_sha256: "2".repeat(64) },
      ],
    },
    external_state: {
      paths: ["~/.hasna/recordings"],
      classification: "user-private",
      rollback: "transactional-backup-restore",
    },
    archive: {
      filename: "Recordings-0.2.12-macos.zip",
      sha256: fileDigest(archivePath),
    },
  };
  manifest.nested_code_policy.allowlist_sha256 = Bun.CryptoHasher.hash(
    "sha256",
    JSON.stringify(manifest.nested_code_policy.items),
    "hex",
  );
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
    const manifest = verifyArchiveManifest(
      archivePath,
      manifestPath,
      "EXAMPLE123",
      fileDigest(manifestPath),
      "a".repeat(40),
      "0.2.12",
    );
    expect(manifest.bundle_id).toBe("com.hasna.recordings");
  });

  test("rejects archive tampering and checksum mismatch", () => {
    const { archivePath, manifestPath } = fixture();
    writeFileSync(archivePath, `${readFileSync(archivePath, "utf8")}tampered`);
    expect(() => verifyArchiveManifest(archivePath, manifestPath, "EXAMPLE123", fileDigest(manifestPath), "a".repeat(40), "0.2.12")).toThrow(
      "archive checksum",
    );
  });

  test("rejects manifest signer tampering", () => {
    const { archivePath, manifestPath, manifest } = fixture();
    manifest.team_id = "OTHERTEAM";
    for (const item of manifest.nested_code_policy.items) item.team_id = "OTHERTEAM";
    manifest.nested_code_policy.allowlist_sha256 = Bun.CryptoHasher.hash(
      "sha256",
      JSON.stringify(manifest.nested_code_policy.items),
      "hex",
    );
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => verifyArchiveManifest(archivePath, manifestPath, "EXAMPLE123", fileDigest(manifestPath), "a".repeat(40), "0.2.12")).toThrow(
      "manifest Team ID",
    );
  });

  test("rejects a renamed archive not bound by the manifest", () => {
    const { archivePath, manifestPath } = fixture();
    const renamed = join(tmpdir(), `renamed-recordings-${Date.now()}.zip`);
    temporaryDirectories.push(renamed);
    writeFileSync(renamed, readFileSync(archivePath));
    expect(() => verifyArchiveManifest(renamed, manifestPath, "EXAMPLE123", fileDigest(manifestPath), "a".repeat(40), "0.2.12")).toThrow(
      "archive filename",
    );
  });

  test("rejects coordinated manifest replacement and wrong source/version", () => {
    const { archivePath, manifestPath } = fixture();
    expect(() => verifyArchiveManifest(archivePath, manifestPath, "EXAMPLE123", "0".repeat(64), "a".repeat(40), "0.2.12")).toThrow("authenticated operator value");
    expect(() => verifyArchiveManifest(archivePath, manifestPath, "EXAMPLE123", fileDigest(manifestPath), "b".repeat(40), "0.2.12")).toThrow("operator-approved source");
    expect(() => verifyArchiveManifest(archivePath, manifestPath, "EXAMPLE123", fileDigest(manifestPath), "a".repeat(40), "0.2.11")).toThrow("operator-approved version");
  });

  test("compares numeric release versions without lexical downgrade mistakes", () => {
    expect(compareVersions("0.2.12", "0.2.9")).toBe(1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.2.9", "0.2.12")).toBe(-1);
  });
});
