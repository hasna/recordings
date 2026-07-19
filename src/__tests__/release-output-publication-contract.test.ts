import { describe, expect, test } from "bun:test";
import {
  existsSync,
  chmodSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertAcceptedNotaryLog,
  assertReleasePublicationComplete,
  canonicalJson,
  completeReleasePublication,
  compareUnsignedUtf8,
  prepareReleasePublication,
  publishReleaseDirectory,
  releasePublicationIdentity,
  RELEASE_PUBLICATION_COMPLETE_FILENAME,
  snapshotRegularFile,
} from "../../scripts/macos_artifact";

const build = readFileSync("src/native/Recordings/build.sh", "utf8");
const pkg = readFileSync("packaging/macos/build_release_pkg.sh", "utf8");
const artifactTool = readFileSync("scripts/macos_artifact.ts", "utf8");
const nativeGuard = readFileSync("scripts/native/recordings_fs_guard.c", "utf8");

describe("release output publication contract", () => {
  test("uses retained capabilities and platform kernel no-replace primitives", () => {
    const publisher = artifactTool.match(
      /export function publishReleaseDirectory\([\s\S]*?\n}\n\nfunction releaseCompletionBytes/,
    )?.[0];
    expect(publisher).toBeDefined();
    expect(publisher).toContain("guard.renameHandleNoReplaceAt(");
    expect(publisher).toContain("guard.sameBinding(parent, stagingLeaf, stagingHandle)");
    expect(publisher).not.toContain("renameSync(");
    expect(nativeGuard).toContain("renameatx_np(source_parent_fd, source_leaf");
    expect(nativeGuard).toContain("RENAME_EXCL");
    expect(nativeGuard).toContain("SYS_renameat2");
    expect(nativeGuard).toContain("acl_get_fd_np(handle->fd, ACL_TYPE_EXTENDED)");
    expect(nativeGuard).toContain("acl == NULL) return make_boolean(env, errno == ENOENT)");
  });

  test("uses unsigned UTF-8 byte ordering for canonical cross-runtime material", () => {
    const astral = "\u{10000}";
    const privateUse = "\u{e000}";
    const values = [astral, "ä", privateUse, "z", "a"];
    expect([...values].sort(compareUnsignedUtf8)).toEqual([
      "a",
      "z",
      "ä",
      privateUse,
      astral,
    ]);
    expect(canonicalJson({ [astral]: 5, ä: 3, [privateUse]: 4, z: 2, a: 1 })).toBe(
      `{"a":1,"z":2,"ä":3,"${privateUse}":4,"${astral}":5}`,
    );
    expect(compareUnsignedUtf8(astral, privateUse)).toBeGreaterThan(0);
  });

  test("binds the accepted notary log to the exact locally submitted archive digest", () => {
    const submissionId = "11111111-1111-4111-8111-111111111111";
    const submittedDigest = "a".repeat(64);
    const log = {
      jobId: submissionId,
      status: "Accepted",
      issues: null,
      sha256: submittedDigest,
    };
    for (const issues of [null, []]) {
      const accepted = { ...log, issues };
      expect(() => assertAcceptedNotaryLog(accepted, submissionId, submittedDigest)).not.toThrow();
    }
    const missingIssues = { ...log } as { issues?: unknown };
    delete missingIssues.issues;
    expect(() =>
      assertAcceptedNotaryLog(missingIssues, submissionId, submittedDigest),
    ).toThrow("not accepted and issue-free");
    expect(() =>
      assertAcceptedNotaryLog({ ...log, issues: [{ severity: "warning" }] }, submissionId, submittedDigest),
    ).toThrow("not accepted and issue-free");
    expect(() =>
      assertAcceptedNotaryLog({ ...log, sha256: "b".repeat(64) }, submissionId, submittedDigest),
    ).toThrow("does not match the submitted archive");
    expect(() =>
      assertAcceptedNotaryLog(
        { jobId: submissionId, status: "Accepted", issues: null },
        submissionId,
        submittedDigest,
      ),
    ).toThrow("does not match the submitted archive");
  });

  test("kernel no-replace publication cannot replace a destination created after precheck", () => {
    const root = mkdtempSync(join(tmpdir(), "recordings-release-race-"));
    try {
      const staging = join(root, ".Recordings-1.2.4.staging");
      const destination = join(root, "Recordings-1.2.4.release");
      mkdirSync(staging, { mode: 0o700 });
      writeFileSync(join(staging, "artifact.zip"), "authenticated");
      expect(() => publishReleaseDirectory(staging, destination, () => {
        mkdirSync(destination, { mode: 0o700 });
        writeFileSync(join(destination, "intruder"), "must-survive");
      })).toThrow("destination already exists");
      expect(readFileSync(join(destination, "intruder"), "utf8")).toBe("must-survive");
      expect(readFileSync(join(staging, "artifact.zip"), "utf8")).toBe("authenticated");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovers missing aliases idempotently and rejects substituted destinations", () => {
    const root = mkdtempSync(join(tmpdir(), "recordings-release-recovery-"));
    try {
      const publicationIdentity = releasePublicationIdentity([
        "release_kind=app-update",
        `source_sha=${"a".repeat(40)}`,
        "version=1.2.5",
      ]);
      const staging = join(root, ".Recordings-1.2.5.staging");
      const destination = join(root, "Recordings-1.2.5.release");
      const reservation = join(root, ".Recordings-1.2.5.reservation");
      mkdirSync(staging, { mode: 0o700 });
      mkdirSync(reservation, { mode: 0o700 });
      writeFileSync(join(staging, "artifact.zip"), "zip");
      writeFileSync(join(staging, "artifact.manifest.json"), "manifest");
      chmodSync(join(staging, "artifact.zip"), 0o444);
      chmodSync(join(staging, "artifact.manifest.json"), 0o444);
      prepareReleasePublication(staging, destination, reservation, [
        "artifact.zip",
        "artifact.manifest.json",
      ], publicationIdentity);
      publishReleaseDirectory(staging, destination);

      linkSync(join(destination, "artifact.zip"), join(root, "artifact.zip"));
      completeReleasePublication(destination, reservation, root, publicationIdentity);
      assertReleasePublicationComplete(destination, root, publicationIdentity);
      expect(existsSync(reservation)).toBeFalse();
      expect(existsSync(join(destination, RELEASE_PUBLICATION_COMPLETE_FILENAME))).toBeTrue();
      expect(readFileSync(join(root, "artifact.manifest.json"), "utf8")).toBe("manifest");

      unlinkSync(join(root, "artifact.manifest.json"));
      completeReleasePublication(destination, reservation, root, publicationIdentity);
      assertReleasePublicationComplete(destination, root, publicationIdentity);

      mkdirSync(reservation, { mode: 0o700 });
      completeReleasePublication(destination, reservation, root, publicationIdentity);
      expect(existsSync(reservation)).toBeFalse();

      const differentSourceIdentity = releasePublicationIdentity([
        "release_kind=app-update",
        `source_sha=${"b".repeat(40)}`,
        "version=1.2.5",
      ]);
      expect(() =>
        completeReleasePublication(destination, reservation, root, differentSourceIdentity),
      ).toThrow("invalid or names another destination");
      expect(() =>
        assertReleasePublicationComplete(destination, root, differentSourceIdentity),
      ).toThrow("invalid or names another destination");

      chmodSync(join(destination, "artifact.manifest.json"), 0o644);
      writeFileSync(join(destination, "artifact.manifest.json"), "tampered");
      chmodSync(join(destination, "artifact.manifest.json"), 0o444);
      expect(() =>
        completeReleasePublication(destination, reservation, root, publicationIdentity),
      ).toThrow(
        "byte and metadata authentication",
      );
      chmodSync(join(destination, "artifact.manifest.json"), 0o644);
      writeFileSync(join(destination, "artifact.manifest.json"), "manifest");
      chmodSync(join(destination, "artifact.manifest.json"), 0o444);

      unlinkSync(join(root, "artifact.zip"));
      writeFileSync(join(root, "artifact.zip"), "substitute");
      expect(() =>
        completeReleasePublication(destination, reservation, root, publicationIdentity),
      ).toThrow(
        "not the authenticated hard link",
      );
      expect(readFileSync(join(root, "artifact.zip"), "utf8")).toBe("substitute");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("outer recovery authenticates the canonical nested updater publication", () => {
    const root = mkdtempSync(join(tmpdir(), "recordings-nested-release-recovery-"));
    try {
      const outerIdentity = releasePublicationIdentity([
        "release_kind=initial-bootstrap",
        `source_sha=${"a".repeat(40)}`,
        "version=1.2.6",
      ]);
      const nestedIdentity = releasePublicationIdentity([
        "release_kind=initial-bootstrap-updater",
        `source_sha=${"a".repeat(40)}`,
        "version=1.2.6",
      ]);
      const staging = join(root, ".Recordings-1.2.6.staging");
      const destination = join(root, "Recordings-1.2.6.release");
      const reservation = join(root, ".Recordings-1.2.6.reservation");
      mkdirSync(staging, { mode: 0o700 });
      mkdirSync(reservation, { mode: 0o700 });
      writeFileSync(join(staging, "artifact.zip"), "app");
      chmodSync(join(staging, "artifact.zip"), 0o444);

      const nestedStaging = join(staging, ".updater.staging");
      const nestedDestination = join(staging, "updater.release");
      const nestedReservation = join(staging, ".updater.reservation");
      mkdirSync(nestedStaging, { mode: 0o700 });
      mkdirSync(nestedReservation, { mode: 0o700 });
      writeFileSync(join(nestedStaging, "updater.pkg"), "package");
      chmodSync(join(nestedStaging, "updater.pkg"), 0o444);
      prepareReleasePublication(
        nestedStaging,
        nestedDestination,
        nestedReservation,
        ["updater.pkg"],
        nestedIdentity,
      );
      publishReleaseDirectory(nestedStaging, nestedDestination);
      completeReleasePublication(nestedDestination, nestedReservation, staging, nestedIdentity);

      prepareReleasePublication(
        staging,
        destination,
        reservation,
        ["artifact.zip", "updater.pkg"],
        outerIdentity,
        [`updater.release=${nestedIdentity}`],
      );
      publishReleaseDirectory(staging, destination);
      completeReleasePublication(destination, reservation, root, outerIdentity);
      expect(() =>
        assertReleasePublicationComplete(destination, root, outerIdentity),
      ).not.toThrow();

      rmSync(join(destination, "updater.release"), { recursive: true });
      expect(() =>
        assertReleasePublicationComplete(destination, root, outerIdentity),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("derives canonical invocation identities and rejects ambiguous components", () => {
    const source = "c".repeat(40);
    const first = releasePublicationIdentity([
      "release_kind=initial-bootstrap",
      `source_sha=${source}`,
      "version=1.2.6",
    ]);
    const reordered = releasePublicationIdentity([
      "version=1.2.6",
      `source_sha=${source}`,
      "release_kind=initial-bootstrap",
    ]);
    expect(first).toBe(reordered);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(releasePublicationIdentity([
      "release_kind=app-update",
      `source_sha=${source}`,
      "version=1.2.6",
    ])).not.toBe(first);
    expect(() => releasePublicationIdentity([
      `source_sha=${source}`,
      `source_sha=${"d".repeat(40)}`,
    ])).toThrow("invalid or duplicated");
    expect(() => releasePublicationIdentity(["release_kind=app-update\nother"])).toThrow(
      "invalid or duplicated",
    );
  });

  test("pins mutable release inputs into one exclusive authenticated snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "recordings-release-input-snapshot-"));
    try {
      const source = join(root, "source.raw");
      const snapshot = join(root, "snapshot.raw");
      writeFileSync(source, "first");
      const digest = snapshotRegularFile(source, snapshot, 32);
      writeFileSync(source, "second");
      expect(readFileSync(snapshot, "utf8")).toBe("first");
      expect(digest).toBe(
        Bun.CryptoHasher.hash("sha256", "first", "hex"),
      );
      expect(() => snapshotRegularFile(source, snapshot, 32)).toThrow();
      expect(() =>
        snapshotRegularFile(source, join(root, "too-small.raw"), 2),
      ).toThrow("exceeds the configured size limit");

      const exactSource = join(root, "exact-source.raw");
      const exactSnapshot = join(root, "exact-snapshot.raw");
      writeFileSync(exactSource, Buffer.alloc(32, 0x5a));
      expect(snapshotRegularFile(exactSource, exactSnapshot, 32, 32)).toBe(
        Bun.CryptoHasher.hash("sha256", Buffer.alloc(32, 0x5a), "hex"),
      );
      expect(readFileSync(exactSnapshot)).toEqual(Buffer.alloc(32, 0x5a));

      const shortSource = join(root, "short-source.raw");
      const shortSnapshot = join(root, "short-snapshot.raw");
      writeFileSync(shortSource, Buffer.alloc(31, 0x5a));
      expect(() =>
        snapshotRegularFile(shortSource, shortSnapshot, 32, 32),
      ).toThrow("must contain exactly 32 bytes");
      expect(existsSync(shortSnapshot)).toBeFalse();

      const longSource = join(root, "long-source.raw");
      const longSnapshot = join(root, "long-snapshot.raw");
      writeFileSync(longSource, Buffer.alloc(33, 0x5a));
      expect(() =>
        snapshotRegularFile(longSource, longSnapshot, 64, 32),
      ).toThrow("must contain exactly 32 bytes");
      expect(existsSync(longSnapshot)).toBeFalse();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("publishes a durable sibling directory without replacing an existing release", () => {
    const root = mkdtempSync(join(tmpdir(), "recordings-release-publication-"));
    try {
      const staging = join(root, ".Recordings-1.2.3.staging.first");
      const destination = join(root, "Recordings-1.2.3.release");
      mkdirSync(staging, { mode: 0o700 });
      writeFileSync(join(staging, "artifact.zip"), "first");
      publishReleaseDirectory(staging, destination);
      expect(existsSync(staging)).toBeFalse();
      expect(readFileSync(join(destination, "artifact.zip"), "utf8")).toBe("first");

      const second = join(root, ".Recordings-1.2.3.staging.second");
      mkdirSync(second, { mode: 0o700 });
      writeFileSync(join(second, "artifact.zip"), "second");
      expect(() => publishReleaseDirectory(second, destination)).toThrow(
        "destination already exists",
      );
      expect(readFileSync(join(destination, "artifact.zip"), "utf8")).toBe("first");

      const otherParent = join(root, "other");
      mkdirSync(otherParent);
      expect(() => publishReleaseDirectory(second, join(otherParent, "release"))).toThrow(
        "must be distinct siblings",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reserves, stages, verifies, and atomically publishes complete immutable release sets", () => {
    for (const source of [build, pkg]) {
      expect(source).toContain(".reservation");
      expect(source).toContain(".staging.XXXXXX");
      expect(source).toContain("publish-release-directory");
      expect(source).toContain("prepare-release-publication");
      expect(source).toContain("complete-release-publication");
      expect(source).toContain("assert-release-publication-complete");
      expect(source).toContain("--publication-identity-sha256");
      expect(source).toContain("already exists");
    }
    expect(build).toContain("verify_complete_release_staging");
    expect(build).toContain("publish_complete_release_set");
    expect(build).toContain('RELEASE_DIRECTORY_PUBLISHED=1');
    expect(build).toContain("--nested-publication");
    expect(build).toContain("snapshot-regular-file");
    expect(build).toContain("compatible_cohort_sha256=$COMPATIBLE_COHORT_SHA256");
    expect(build).toContain("envelope_public_key_sha256=$ENVELOPE_PUBLIC_KEY_SHA256");
    expect(pkg).toContain('PUBLIC_KEY="$PUBLIC_KEY_SNAPSHOT"');
    expect(build).not.toContain(
      '"$RM_EXECUTABLE" -f "$NOTARY_ARCHIVE" "$FINAL_ARCHIVE" "$FINAL_MANIFEST"',
    );
    expect(pkg).toContain("verify_package_release_set");
    expect(pkg).toContain('PACKAGE_DIRECTORY_PUBLISHED=1');
    expect(pkg).not.toContain(
      '/bin/rm -f "$PKG" "$NOTARY_SUBMISSION" "$NOTARY_LOG"',
    );
  });

  test("separates same-version bootstrap and app-update publication identities", () => {
    expect(build).toContain(
      'release_set_basename="Recordings-${VERSION}-macos-${RELEASE_SUBTYPE}"',
    );
    expect(build).toContain(
      'ARTIFACT_BASENAME="Recordings-${VERSION}-macos-${RELEASE_SUBTYPE}"',
    );
    expect(build).toContain('initial-bootstrap|app-update');
    expect(build).toContain('release_kind=$RELEASE_SUBTYPE');
    expect(build).toContain('source_sha=$SOURCE_SHA');
    expect(build).toContain('RELEASE_FINAL_DIR="$RELEASE_OUTPUT_ROOT/${release_set_basename}.release"');
    expect(build).toContain('RELEASE_RESERVATION="$RELEASE_OUTPUT_ROOT/.${release_set_basename}.reservation"');
    expect(build).not.toContain('release_set_basename="Recordings-${VERSION}-macos"');
    expect(pkg).toContain("release_kind=initial-bootstrap-updater");
    expect(pkg).toContain("source_sha=$SOURCE_SHA");
  });

  test("package notarization also verifies the log digest before stapling", () => {
    const submittedDigest = pkg.indexOf('SUBMITTED_PKG_SHA256="$(sha256_file "$PKG")"');
    const canonicalValidation = pkg.indexOf('"$STAGED_VERIFIER" assert-notary-log');
    const equality = pkg.indexOf('--submitted-archive-sha256 "$SUBMITTED_PKG_SHA256"');
    const staple = pkg.indexOf("/usr/bin/xcrun stapler staple");
    expect(submittedDigest).toBeGreaterThan(-1);
    expect(canonicalValidation).toBeGreaterThan(submittedDigest);
    expect(equality).toBeGreaterThan(canonicalValidation);
    expect(staple).toBeGreaterThan(equality);
  });
});
