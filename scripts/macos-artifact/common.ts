import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  type BigIntStats,
  closeSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
  fsyncSync,
  fchmodSync,
  fstatSync,
  futimesSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";
import {
  nativeFsGuard,
  type NativeFsGuard,
  type NativeHandle,
  type NativeMetadata,
} from "../native_fs_guard";

import { architectures } from "./artifacts";

export const GIT_EXECUTABLE = "/usr/bin/git";
// Production macOS never honors an environment override; the non-Darwin branch
// lets fixture-only CI execute the real artifact CLI on hosts without codesign.
export const CODESIGN_EXECUTABLE = process.platform === "darwin"
  ? "/usr/bin/codesign"
  : process.env.RECORDINGS_TEST_MACOS_ARTIFACT_CODESIGN_EXECUTABLE ?? "codesign";
export const LIPO_EXECUTABLE = process.platform === "darwin" ? "/usr/bin/lipo" : "lipo";
export const PLUTIL_EXECUTABLE = process.platform === "darwin" ? "/usr/bin/plutil" : "plutil";
export const XCRUN_EXECUTABLE = "/usr/bin/xcrun";
export const SPCTL_EXECUTABLE = "/usr/sbin/spctl";
export const SYSPOLICY_CHECK_EXECUTABLE = "/usr/bin/syspolicy_check";

export const RELEASE_ARTIFACT_SCHEMA_VERSION = 4;
export const LOCAL_ARTIFACT_SCHEMA_VERSION = 3;
export const BUNDLE_ID = "com.hasna.recordings";
export const PROVENANCE_FILENAME = "recordings-build-provenance.json";
export const RELEASE_APPROVED_TARGET = "fleet";
export const LEGACY_LOCAL_TARGET_IDENTITY_KIND = "hardware_uuid_sha256";
export const LOCAL_ONLY_APPROVED_TARGETS_POLICY_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "policy",
  "local-only-approved-targets.txt",
);

// The approved local-only targets are policy data, not code: one file is read by
// this validator and, through scripts/read_local_only_targets.sh, by both shell entry
// points, so a target is declared once. The shell reader is a separate implementation
// of these rules; equivalence is enforced by an executing contract test, not by shared
// code. Parsing stays deliberately strict — a malformed policy fails closed rather than
// silently widening the allowlist.
//
// This is an operator-integrity control, NOT an authorization boundary. The file sits in
// the same package root as the guards that read it, so anyone able to edit it can edit
// those guards. Widening it still grants nothing on its own: the install additionally
// requires a matching `hostname -s`, a matching authenticated Tailscale node digest, and
// a matching authenticated manifest SHA-256.
export function localOnlyApprovedTargets(
  policyPath: string = LOCAL_ONLY_APPROVED_TARGETS_POLICY_PATH,
): string[] {
  // lstat, not readFileSync alone: readFileSync FOLLOWS a symlink, and the shell reader
  // refuses one outright (`[ -L ]`). That divergence was real and it favoured the
  // attacker — a policy symlinked at a widened allowlist was rejected by the shell gate
  // and silently honoured here. Refusing every non-regular file matches the shell reader
  // and keeps the wording it prints, so both sides fail closed identically.
  let policyStats;
  try {
    policyStats = lstatSync(policyPath);
  } catch {
    throw new Error("local-only approved target policy is missing");
  }
  if (!policyStats.isFile()) {
    throw new Error("local-only approved target policy is missing");
  }
  // An unreadable (mode 000) policy passes the lstat above and then threw a raw EACCES from
  // here, while the shell reader emitted bash's own "Permission denied" and no reader
  // message. Same fail-closed outcome, two unrecognizable errors; both now say this.
  let rawContents: string;
  try {
    rawContents = readFileSync(policyPath, "utf8");
  } catch {
    throw new Error("local-only approved target policy is not readable");
  }
  // Reject a NUL anywhere, in the same order and with the same wording as the shell
  // reader's pre-scan. This reader had no NUL check at all and only ever refused one that
  // happened to land inside a would-be hostname: "# comment\0" was dropped as a comment,
  // so "# comment\0\nstation03\n" was refused by the shell gate and ACCEPTED here.
  if (rawContents.includes("\u0000")) {
    throw new Error("local-only approved target policy contains a NUL byte");
  }
  // Strip a BOM at offset 0 only. A U+FEFF anywhere else is a zero-width no-break space,
  // not a byte-order mark; the shell reader used to strip one per line and therefore
  // accepted a BOM on line 2 that this reader rejected.
  const contents = rawContents.replace(/^﻿/, "");
  const targets = contents
    .split("\n")
    // Deliberately NOT String.trim(): trim() also strips U+FEFF and U+00A0, and the
    // shell reader trims neither, so a trailing NBSP or BOM would be accepted here and
    // rejected there. ASCII space and tab only, matching read_local_only_targets.sh
    // under its pinned LC_ALL=C; everything else is left for the hostname shape below.
    .map((line) => line.replace(/\r$/, "").replace(/^[\t ]+|[\t ]+$/g, ""))
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (targets.length === 0) {
    throw new Error("local-only approved target policy lists no targets");
  }
  for (const target of targets) {
    if (!/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(target)) {
      throw new Error(`local-only approved target policy has an invalid target name: ${target}`);
    }
  }
  if (new Set(targets).size !== targets.length) {
    throw new Error("local-only approved target policy has duplicate targets");
  }
  if (targets.includes(RELEASE_APPROVED_TARGET)) {
    throw new Error("local-only approved target policy must not list the release fleet target");
  }
  return targets;
}

export function isLocalOnlyApprovedTarget(
  target: string | undefined,
  policyPath?: string,
): boolean {
  if (target === undefined) return false;
  return localOnlyApprovedTargets(policyPath).includes(target);
}

export function localOnlyApprovedTargetsMessage(policyPath?: string): string {
  return localOnlyApprovedTargets(policyPath).join(", ");
}

export type ArtifactPolicy = "release" | "local_only";
export type TargetIdentityKind =
  | typeof LEGACY_LOCAL_TARGET_IDENTITY_KIND
  | "tailscale_node_id_sha256";
export type OperatorTargetIdentityKind = TargetIdentityKind | "none";

export type BuildProvenance = {
  schema_version: 3 | 4;
  artifact_policy?: "local_only";
  approved_target?: string;
  approved_target_identity_kind?: TargetIdentityKind;
  approved_target_identity_sha256?: string;
  builder_identity_kind?: TargetIdentityKind;
  builder_identity_sha256?: string;
  non_notarized?: true;
  bundle_id: string;
  bundle_version: string;
  bundle_build_version: string;
  git_sha: string;
  architectures: string[];
  team_id: string;
  minimum_macos: string;
  companion: {
    version: string;
    sha256: string;
    architectures: string[];
  };
};

export type MacOSArtifactManifest = BuildProvenance & {
  artifact_type: "recordings-macos-app";
  app_sha256: string;
  binding: {
    bundle_tree_sha256: string;
  };
  provenance_sha256: string;
  signing: {
    mode?: "ad_hoc";
    authority: string;
    team_id: string;
    trusted_timestamp: string;
    helper_authority: string;
    helper_team_id: string;
    helper_trusted_timestamp: string;
    entitlements_sha256: string;
    helper_entitlements_sha256: string;
    designated_requirement_sha256: string;
    helper_designated_requirement_sha256: string;
  };
  notarization: {
    submission_id: string;
    status: "Accepted" | "Not Submitted";
    log_sha256: string;
    issue_count: 0;
    submitted_archive_sha256: string;
    stapled: boolean;
    distribution_check: boolean;
  };
  container: {
    type: "zip";
    install_locations: ["/Applications/Recordings.app"] | ["~/Applications/Recordings.app"];
  };
  nested_code_policy: {
    allowlist_sha256: string;
    items: NestedCodeItem[];
  };
  external_state: {
    paths: ["~/.hasna/recordings"];
    classification: "user-private";
    rollback: "database-preserving-transactional-restore";
  };
  archive: {
    filename: string;
    sha256: string;
  };
};

export type SigningEvidence = {
  mode: "developer_id" | "ad_hoc";
  authority: string;
  teamId: string;
  timestamp: string;
  designatedRequirement: string;
  architectures: string[];
  entitlementsSha256: string;
};

export type AppVerificationEvidence = {
  bundleTreeSha256: string;
  executableSha256: string;
  provenanceSha256: string;
  companionSha256: string;
  outerSigning: SigningEvidence;
  helperSigning: SigningEvidence;
};

export const APP_ENTITLEMENTS = {
  "com.apple.security.app-sandbox": false,
  "com.apple.security.automation.apple-events": true,
  "com.apple.security.device.audio-input": true,
} as const;

export const HELPER_ENTITLEMENTS = {
  "com.apple.security.cs.allow-jit": true,
  "com.apple.security.cs.allow-unsigned-executable-memory": true,
} as const;

export const UPDATE_CLIENT_ENTITLEMENTS = {} as const;

export type NestedCodeItem = {
  path: string;
  team_id: string;
  runtime: true;
  timestamp_required: boolean;
  architectures: string[];
  entitlements_sha256: string;
};

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Canonical release ordering is the lexicographic order of unsigned UTF-8
 * bytes. Do not use the host locale or JavaScript's UTF-16 code-unit order for
 * material that is hashed or compared across runtimes.
 */
export function compareUnsignedUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function sortUnsignedUtf8(values: string[]): string[] {
  return values.sort(compareUnsignedUtf8);
}

export const HASH_IO_CHUNK_BYTES = 1024 * 1024;
export const JSON_INPUT_LIMIT_BYTES = 16 * 1024 * 1024;

export type RegularFileSnapshot = {
  dev: bigint;
  ino: bigint;
  size: number;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

export function snapshotOpenRegularFile(descriptor: number, label: string): RegularFileSnapshot {
  const details = fstatSync(descriptor, { bigint: true });
  if (!details.isFile() || details.size < 0n || details.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} must be a regular file with a supported size`);
  }
  return {
    dev: details.dev,
    ino: details.ino,
    size: Number(details.size),
    mtimeNs: details.mtimeNs,
    ctimeNs: details.ctimeNs,
  };
}

export function openRegularFile(path: string, label: string): {
  descriptor: number;
  snapshot: RegularFileSnapshot;
} {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} must be a regular file, not a symlink or special entry`, {
      cause: error,
    });
  }
  try {
    return { descriptor, snapshot: snapshotOpenRegularFile(descriptor, label) };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

export function assertRegularFileUnchanged(
  path: string,
  descriptor: number,
  before: RegularFileSnapshot,
  label: string,
): void {
  const after = snapshotOpenRegularFile(descriptor, label);
  let pathDetails: BigIntStats;
  try {
    pathDetails = lstatSync(path, { bigint: true });
  } catch (error) {
    throw new Error(`${label} changed or was replaced while being read`, { cause: error });
  }
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs !== before.ctimeNs ||
    !pathDetails.isFile() ||
    pathDetails.dev !== before.dev ||
    pathDetails.ino !== before.ino
  ) {
    throw new Error(`${label} changed or was replaced while being read`);
  }
}

export function readRegularFileBounded(
  path: string,
  maximumBytes: number,
  label: string,
  maximumSizeError: string,
): Buffer {
  const { descriptor, snapshot } = openRegularFile(path, label);
  try {
    if (snapshot.size > maximumBytes) throw new Error(maximumSizeError);
    const contents = Buffer.allocUnsafe(snapshot.size);
    let offset = 0;
    while (offset < snapshot.size) {
      const count = readSync(
        descriptor,
        contents,
        offset,
        Math.min(HASH_IO_CHUNK_BYTES, snapshot.size - offset),
        offset,
      );
      if (count === 0) throw new Error(`${label} changed while being read`);
      offset += count;
    }
    assertRegularFileUnchanged(path, descriptor, snapshot, label);
    return contents;
  } finally {
    closeSync(descriptor);
  }
}

export function readRegularFilePrefix(path: string, bytes: number, label: string): Buffer {
  const { descriptor, snapshot } = openRegularFile(path, label);
  try {
    const contents = Buffer.allocUnsafe(Math.min(snapshot.size, bytes));
    let offset = 0;
    while (offset < contents.length) {
      const count = readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (count === 0) throw new Error(`${label} changed while being read`);
      offset += count;
    }
    assertRegularFileUnchanged(path, descriptor, snapshot, label);
    return contents;
  } finally {
    closeSync(descriptor);
  }
}

export function sha256RegularFile(
  path: string,
  label: string,
  maximumBytes?: number,
  maximumSizeError?: string,
): string {
  const { descriptor, snapshot } = openRegularFile(path, label);
  try {
    if (maximumBytes !== undefined && snapshot.size > maximumBytes) {
      throw new Error(maximumSizeError ?? `${label} exceeds the supported size limit`);
    }
    const hasher = createHash("sha256");
    const buffer = Buffer.allocUnsafe(
      Math.min(HASH_IO_CHUNK_BYTES, Math.max(snapshot.size, 1)),
    );
    let offset = 0;
    while (offset < snapshot.size) {
      const count = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, snapshot.size - offset),
        offset,
      );
      if (count === 0) throw new Error(`${label} changed while being read`);
      hasher.update(buffer.subarray(0, count));
      offset += count;
    }
    assertRegularFileUnchanged(path, descriptor, snapshot, label);
    return hasher.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

export function sha256File(path: string): string {
  return sha256RegularFile(path, "hash input");
}


