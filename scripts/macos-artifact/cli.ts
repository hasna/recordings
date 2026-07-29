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

import { ArtifactPolicy, LEGACY_LOCAL_TARGET_IDENTITY_KIND, MacOSArtifactManifest, OperatorTargetIdentityKind, sha256 } from "./common";
import { architectures, readAuthenticatedManifest, readJson, snapshotRegularFile } from "./artifacts";
import { isTargetIdentityKind, manifestBuilderIdentityKind, manifestTargetIdentityKind, tailscaleNodeIdSha256 } from "./layout";
import { extractVerifiedArchiveToStaging, verifyAndExtractArchiveDescriptors } from "./archive";
import { assertManifestShape, verifyArchiveManifest } from "./manifest";
import { finalizeArtifact, verifyExtractedApp, writeProvenance } from "./app-verification";
import { assertAcceptedNotaryLog, assertExpectedRelease, assertFilesystemTree, assertInstallTransition, finalizeLocalArtifact, requirementDigest, verifyActiveApp } from "./release";
import { fsyncDirectory, fsyncTree, journalArgument, readJournal, transitionStateMode, writeDurableJournal } from "./journal";
import { releasePublicationIdentity } from "./publication-state";
import { assertReleasePublicationComplete, completeReleasePublication, prepareReleasePublication, publishReleaseDirectory, treeDigest } from "./publication";
import { archiveInstallOriginal, publishInstallCandidate } from "./recovery-install";
import { cleanupPreJournalTransaction, recoverJournal } from "./recovery-journal";

export function journalGet(path: string, field: string): void {
  const journal = readJournal(path);
  if (field === "json") console.log(JSON.stringify(journal));
  else if (field === "phase") console.log(journal.phase);
  else if (field === "transaction_dir") console.log(journal.transaction_dir);
  else if (field === "state_backup") console.log(journal.state_backup);
  else if (field === "was_running") console.log(journal.was_running ? "1" : "0");
  else if (field === "prior_running_app_paths") {
    console.log(JSON.stringify(journal.prior_running_app_paths ?? []));
  }
  else throw new Error(`unsupported journal field: ${field}`);
}

export function manifestGet(path: string, expectedManifestSha256: string, field: string): void {
  const manifest = readAuthenticatedManifest<MacOSArtifactManifest>(
    path,
    expectedManifestSha256,
  );
  assertManifestShape(manifest);
  if (field === "minimum_macos") console.log(manifest.minimum_macos);
  else if (field === "architectures") console.log(manifest.architectures.join(" "));
  else if (field === "version") console.log(manifest.bundle_version);
  else if (field === "source") console.log(manifest.git_sha);
  else if (field === "identity") console.log(manifest.signing.designated_requirement_sha256);
  else if (field === "artifact_policy") console.log(manifest.artifact_policy);
  else if (field === "approved_target") console.log(manifest.approved_target);
  else if (field === "approved_target_identity_kind") {
    console.log(manifestTargetIdentityKind(manifest));
  }
  else if (field === "approved_target_identity_sha256") console.log(manifest.approved_target_identity_sha256);
  else if (field === "builder_identity_kind") console.log(manifestBuilderIdentityKind(manifest));
  else throw new Error(`unsupported manifest field: ${field}`);
}

export function argument(name: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing required argument ${name}`);
  return value;
}

export function optionalArgument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

export function repeatedArguments(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < Bun.argv.length; index += 1) {
    if (Bun.argv[index] !== name) continue;
    const value = Bun.argv[index + 1];
    if (!value) throw new Error(`missing value for repeated argument ${name}`);
    values.push(value);
  }
  return values;
}

export function artifactPolicyArgument(): ArtifactPolicy {
  const value = argument("--artifact-policy");
  if (value !== "release" && value !== "local_only") {
    throw new Error("artifact policy must be release or local_only");
  }
  return value;
}

export function targetIdentityKindArgument(
  policy?: ArtifactPolicy,
  required = false,
): OperatorTargetIdentityKind {
  const index = Bun.argv.indexOf("--approved-target-identity-kind");
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!value) {
    if (required) throw new Error("missing required argument --approved-target-identity-kind");
    return policy === "release" ? "none" : LEGACY_LOCAL_TARGET_IDENTITY_KIND;
  }
  if (value !== "none" && !isTargetIdentityKind(value)) {
    throw new Error("unsupported approved target identity kind");
  }
  return value;
}

export function builderIdentityKindArgument(policy: ArtifactPolicy): OperatorTargetIdentityKind {
  const index = Bun.argv.indexOf("--builder-identity-kind");
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!value) {
    if (policy === "local_only") {
      throw new Error("missing required argument --builder-identity-kind");
    }
    return "none";
  }
  if (value !== "none" && !isTargetIdentityKind(value)) {
    throw new Error("unsupported builder identity kind");
  }
  return value;
}

export function main(): void {
  const command = Bun.argv[2];
  if (command === "verify" && Bun.argv.includes("--archive-fd")) {
    verifyAndExtractArchiveDescriptors(
      Number(argument("--archive-fd")),
      Number(argument("--output-dir-fd")),
      argument("--expected-sha256"),
    );
  } else if (command === "provenance") {
    const sourceSha = argument("--source-sha");
    const teamId = argument("--team-id");
    const policy = artifactPolicyArgument();
    writeProvenance(
      argument("--app"),
      teamId,
      argument("--package-root"),
      sourceSha,
      policy,
      argument("--approved-target"),
      targetIdentityKindArgument(policy),
      argument("--approved-target-identity-sha256"),
      builderIdentityKindArgument(policy),
      argument("--builder-identity-sha256"),
    );
  } else if (command === "finalize") {
    const sourceSha = argument("--source-sha");
    const teamId = argument("--team-id");
    finalizeArtifact(
      argument("--app"),
      argument("--archive"),
      argument("--manifest"),
      optionalArgument("--package-root") ?? process.cwd(),
      sourceSha,
      teamId,
      argument("--notary-log"),
      argument("--notary-submission-id"),
      argument("--submitted-archive-sha256"),
    );
  } else if (command === "finalize-local") {
    const sourceSha = argument("--source-sha");
    finalizeLocalArtifact(
      argument("--app"),
      argument("--archive"),
      argument("--manifest"),
      optionalArgument("--package-root") ?? process.cwd(),
      sourceSha,
      argument("--approved-target"),
      targetIdentityKindArgument(undefined, true),
      argument("--approved-target-identity-sha256"),
    );
  } else if (command === "verify-archive") {
    const teamId = argument("--team-id");
    const policy = artifactPolicyArgument();
    verifyArchiveManifest(
      argument("--archive"),
      argument("--manifest"),
      teamId,
      argument("--manifest-sha256"),
      argument("--source-sha"),
      argument("--version"),
      policy,
      argument("--approved-target"),
      argument("--approved-target-identity-sha256"),
      targetIdentityKindArgument(policy),
    );
  } else if (command === "extract-verified-archive") {
    const teamId = argument("--team-id");
    const policy = artifactPolicyArgument();
    extractVerifiedArchiveToStaging(
      argument("--archive"),
      argument("--manifest"),
      argument("--staging-target"),
      teamId,
      argument("--manifest-sha256"),
      argument("--source-sha"),
      argument("--version"),
      policy,
      argument("--approved-target"),
      argument("--approved-target-identity-sha256"),
      targetIdentityKindArgument(policy),
    );
  } else if (command === "verify-app") {
    const teamId = argument("--team-id");
    const policy = artifactPolicyArgument();
    verifyExtractedApp(
      argument("--app"),
      argument("--manifest"),
      argument("--manifest-sha256"),
      teamId,
      policy,
      argument("--approved-target"),
      argument("--approved-target-identity-sha256"),
      targetIdentityKindArgument(policy),
    );
  } else if (command === "verify-active") {
    const teamId = argument("--team-id");
    const policy = artifactPolicyArgument();
    verifyActiveApp(
      argument("--app"),
      argument("--manifest"),
      argument("--manifest-sha256"),
      teamId,
      policy,
      argument("--approved-target"),
      argument("--approved-target-identity-sha256"),
      targetIdentityKindArgument(policy),
    );
  } else if (command === "assert-release") {
    assertExpectedRelease(
      argument("--manifest"),
      argument("--manifest-sha256"),
      argument("--source-sha"),
      argument("--version"),
    );
  } else if (command === "assert-transition") {
    assertInstallTransition(
      argument("--existing-app"),
      argument("--manifest"),
      argument("--manifest-sha256"),
    );
  } else if (command === "requirement-digest") {
    requirementDigest(argument("--app"), artifactPolicyArgument());
  } else if (command === "tailscale-node-id-sha256") {
    console.log(tailscaleNodeIdSha256(readFileSync(0, "utf8"), argument("--expected-hostname")));
  } else if (command === "verify-filesystem-tree") {
    assertFilesystemTree(argument("--path"), Number(argument("--uid")));
  } else if (command === "fsync-tree") {
    fsyncTree(argument("--path"));
  } else if (command === "fsync-directory") {
    fsyncDirectory(argument("--path"));
  } else if (command === "publish-release-directory") {
    publishReleaseDirectory(
      argument("--staging"),
      argument("--destination"),
    );
  } else if (command === "release-publication-identity") {
    console.log(releasePublicationIdentity(repeatedArguments("--component")));
  } else if (command === "snapshot-regular-file") {
    const expectedBytes = optionalArgument("--expected-bytes");
    console.log(snapshotRegularFile(
      argument("--source"),
      argument("--destination"),
      Number(argument("--maximum-bytes")),
      expectedBytes === undefined ? undefined : Number(expectedBytes),
    ));
  } else if (command === "prepare-release-publication") {
    prepareReleasePublication(
      argument("--staging"),
      argument("--destination"),
      argument("--reservation"),
      repeatedArguments("--alias"),
      argument("--publication-identity-sha256"),
      repeatedArguments("--nested-publication"),
    );
  } else if (command === "complete-release-publication") {
    completeReleasePublication(
      argument("--destination"),
      argument("--reservation"),
      argument("--output-root"),
      argument("--publication-identity-sha256"),
    );
  } else if (command === "assert-release-publication-complete") {
    assertReleasePublicationComplete(
      argument("--destination"),
      argument("--output-root"),
      argument("--publication-identity-sha256"),
    );
  } else if (command === "assert-notary-log") {
    assertAcceptedNotaryLog(
      readJson<unknown>(argument("--notary-log")),
      argument("--submission-id"),
      argument("--submitted-archive-sha256"),
    );
  } else if (command === "tree-digest") {
    console.log(treeDigest(argument("--path")));
  } else if (command === "native-fs-guard-check") {
    nativeFsGuard();
  } else if (command === "journal-write") {
    writeDurableJournal(argument("--journal"), journalArgument());
  } else if (command === "journal-get") {
    journalGet(argument("--journal"), argument("--field"));
  } else if (command === "journal-recover") {
    recoverJournal(argument("--journal"));
  } else if (command === "transaction-cleanup") {
    cleanupPreJournalTransaction(
      argument("--transaction-dir"),
      argument("--nonce"),
    );
  } else if (command === "state-mode-harden") {
    transitionStateMode(
      argument("--path"),
      Number(argument("--uid")),
      "700",
      new Set(["755"]),
    );
  } else if (command === "install-archive-original") {
    archiveInstallOriginal(
      argument("--journal"),
      argument("--source"),
      argument("--destination"),
      argument("--expected-tree-sha256"),
    );
  } else if (command === "install-publish-candidate") {
    publishInstallCandidate(
      argument("--journal"),
      argument("--staging"),
      argument("--destination"),
      argument("--expected-tree-sha256"),
    );
  } else if (command === "manifest-get") {
    manifestGet(
      argument("--manifest"),
      argument("--manifest-sha256"),
      argument("--field"),
    );
  } else {
    throw new Error(`unknown command: ${command ?? "missing"}`);
  }
}

