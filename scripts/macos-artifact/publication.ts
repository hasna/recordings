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

import { sha256, sha256File, sortUnsignedUtf8 } from "./common";
import { canonicalJson } from "./artifacts";
import { isHex } from "./layout";
import { fsyncTree } from "./journal";
import { RELEASE_PUBLICATION_COMPLETE_FILENAME, RELEASE_PUBLICATION_STATE_FILENAME, ReleasePublicationState, assertPublicationContentsComplete, assertPublicationLeaf, assertSecurePublicationDirectory, parseNestedPublicationBindings, parsePublicationState, publicationParent, publicationStateBytes, readPublicationRecord } from "./publication-state";

export function prepareReleasePublication(
  stagingPath: string,
  destinationPath: string,
  reservationPath: string,
  aliases: string[],
  publicationIdentitySHA256: string,
  nestedPublicationBindings: string[] = [],
): void {
  if (!isHex(publicationIdentitySHA256, 64)) {
    throw new Error("release publication identity SHA-256 is invalid");
  }
  const staging = resolve(stagingPath);
  const destination = resolve(destinationPath);
  const reservation = resolve(reservationPath);
  const parentPath = dirname(staging);
  if (dirname(destination) !== parentPath || dirname(reservation) !== parentPath) {
    throw new Error("release staging, destination, and reservation must be siblings");
  }
  const stagingLeaf = basename(staging);
  const destinationLeaf = basename(destination);
  const reservationLeaf = basename(reservation);
  assertPublicationLeaf(stagingLeaf, "release staging leaf");
  assertPublicationLeaf(destinationLeaf, "release destination leaf");
  assertPublicationLeaf(reservationLeaf, "release reservation leaf");
  const canonicalAliases = sortUnsignedUtf8([...aliases]);
  for (const alias of canonicalAliases) assertPublicationLeaf(alias, "release compatibility alias");
  if (new Set(canonicalAliases).size !== canonicalAliases.length) {
    throw new Error("release compatibility aliases must be unique");
  }
  const nestedPublications = parseNestedPublicationBindings(nestedPublicationBindings);
  if (nestedPublications.some((publication) => canonicalAliases.includes(publication.alias))) {
    throw new Error("release compatibility aliases and nested publications must be distinct");
  }
  const { guard, parent, uid } = publicationParent(parentPath);
  let stagingHandle: NativeHandle | undefined;
  let reservationHandle: NativeHandle | undefined;
  try {
    stagingHandle = guard.openDirAt(parent, stagingLeaf);
    reservationHandle = guard.openDirAt(parent, reservationLeaf);
    assertSecurePublicationDirectory(guard, stagingHandle, uid, "release staging directory");
    assertSecurePublicationDirectory(guard, reservationHandle, uid, "release reservation directory");
    if (!guard.sameBinding(parent, stagingLeaf, stagingHandle) ||
        !guard.sameBinding(parent, reservationLeaf, reservationHandle)) {
      throw new Error("release publication directory binding changed during preparation");
    }
    const artifacts = canonicalAliases.map((alias) => {
      const sourceHandle = guard.openRegularAt(stagingHandle!, alias, "read");
      try {
        const source = guard.statHandle(sourceHandle);
        if (source.type !== "file" || source.uid !== uid || (source.mode & 0o022) !== 0 ||
            !guard.handleHasNoExtendedAcl(sourceHandle)) {
          throw new Error(`release publication source has an unsafe type, owner, mode, or ACL: ${alias}`);
        }
        return {
          alias,
          size: source.size.toString(),
          sha256: guard.sha256Handle(sourceHandle),
        };
      } finally {
        guard.close(sourceHandle);
      }
    });
    const state: ReleasePublicationState = {
      schema_version: 4,
      publication_id: randomUUID(),
      publication_identity_sha256: publicationIdentitySHA256,
      destination: destinationLeaf,
      artifacts,
      nested_publications: nestedPublications,
    };
    assertPublicationContentsComplete(
      guard,
      stagingHandle,
      stagingHandle,
      state,
      uid,
      "release publication",
    );
    const contents = publicationStateBytes(state);
    guard.writeFileAt(stagingHandle, RELEASE_PUBLICATION_STATE_FILENAME, contents, 0o444);
    guard.writeFileAt(reservationHandle, RELEASE_PUBLICATION_STATE_FILENAME, contents, 0o400);
    guard.fsyncHandle(stagingHandle);
    guard.fsyncHandle(reservationHandle);
    guard.fsyncHandle(parent);
  } finally {
    if (reservationHandle) guard.close(reservationHandle);
    if (stagingHandle) guard.close(stagingHandle);
    guard.close(parent);
  }
}

export function publishReleaseDirectory(
  stagingPath: string,
  destinationPath: string,
  beforeRenameForTest?: () => void,
): void {
  const staging = resolve(stagingPath);
  const destination = resolve(destinationPath);
  const parentPath = dirname(staging);
  if (dirname(destination) !== parentPath || staging === destination) {
    throw new Error("release staging and destination must be distinct siblings");
  }
  const stagingLeaf = basename(staging);
  const destinationLeaf = basename(destination);
  assertPublicationLeaf(stagingLeaf, "release staging leaf");
  assertPublicationLeaf(destinationLeaf, "release destination leaf");
  const { guard, parent, uid } = publicationParent(parentPath);
  let stagingHandle: NativeHandle | undefined;
  try {
    stagingHandle = guard.openDirAt(parent, stagingLeaf);
    assertSecurePublicationDirectory(guard, stagingHandle, uid, "release staging directory");
    if (!guard.sameBinding(parent, stagingLeaf, stagingHandle)) {
      throw new Error("release staging binding changed before publication");
    }
    if (guard.statAt(parent, destinationLeaf) !== null) {
      throw new Error("release destination already exists and is immutable");
    }
    fsyncTree(staging);
    if (!guard.sameBinding(parent, stagingLeaf, stagingHandle)) {
      throw new Error("release staging binding changed while being synchronized");
    }
    beforeRenameForTest?.();
    try {
      guard.renameHandleNoReplaceAt(
        parent,
        stagingLeaf,
        stagingHandle,
        parent,
        destinationLeaf,
      );
    } catch (error) {
      if (guard.statAt(parent, destinationLeaf) !== null) {
        throw new Error("release destination already exists and is immutable", { cause: error });
      }
      throw error;
    }
    guard.fsyncHandle(parent);
  } finally {
    if (stagingHandle) guard.close(stagingHandle);
    guard.close(parent);
  }
}

export function releaseCompletionBytes(stateContents: Buffer): Buffer {
  return Buffer.from(`${canonicalJson({
    schema_version: 2,
    publication_state_sha256: sha256(stateContents),
  })}\n`, "utf8");
}

export function completeReleasePublication(
  destinationPath: string,
  reservationPath: string,
  outputRootPath: string,
  expectedPublicationIdentitySHA256: string,
): void {
  const destination = resolve(destinationPath);
  const reservation = resolve(reservationPath);
  const outputRoot = resolve(outputRootPath);
  if (dirname(destination) !== outputRoot || dirname(reservation) !== outputRoot) {
    throw new Error("release destination and reservation must be direct output-root children");
  }
  const destinationLeaf = basename(destination);
  const reservationLeaf = basename(reservation);
  const { guard, parent, uid } = publicationParent(outputRoot);
  let destinationHandle: NativeHandle | undefined;
  let reservationHandle: NativeHandle | undefined;
  try {
    destinationHandle = guard.openDirAt(parent, destinationLeaf);
    assertSecurePublicationDirectory(guard, destinationHandle, uid, "published release directory");
    if (!guard.sameBinding(parent, destinationLeaf, destinationHandle)) {
      throw new Error("published release directory binding changed");
    }
    const stateContents = readPublicationRecord(
      guard,
      destinationHandle,
      RELEASE_PUBLICATION_STATE_FILENAME,
      uid,
      0o444,
      "published release state",
    );
    const state = parsePublicationState(
      stateContents,
      destinationLeaf,
      expectedPublicationIdentitySHA256,
    );
    const completionContents = releaseCompletionBytes(stateContents);
    const existingCompletion = guard.statAt(
      destinationHandle,
      RELEASE_PUBLICATION_COMPLETE_FILENAME,
    );
    let reservationHasState = false;
    const reservationMetadata = guard.statAt(parent, reservationLeaf);
    if (reservationMetadata !== null) {
      reservationHandle = guard.openDirAt(parent, reservationLeaf);
      assertSecurePublicationDirectory(guard, reservationHandle, uid, "release reservation directory");
      if (!guard.sameBinding(parent, reservationLeaf, reservationHandle)) {
        throw new Error("release reservation binding changed");
      }
      const reservationStateMetadata = guard.statAt(
        reservationHandle,
        RELEASE_PUBLICATION_STATE_FILENAME,
      );
      if (reservationStateMetadata === null) {
        if (existingCompletion === null || guard.readDir(reservationHandle).length !== 0) {
          throw new Error("release reservation has no authenticating publication state");
        }
      } else {
        const reservationState = readPublicationRecord(
          guard,
          reservationHandle,
          RELEASE_PUBLICATION_STATE_FILENAME,
          uid,
          0o400,
          "release reservation state",
        );
        if (!reservationState.equals(stateContents)) {
          throw new Error("release reservation does not authenticate the published directory");
        }
        reservationHasState = true;
      }
    }
    if (existingCompletion === null && !reservationHandle) {
      throw new Error("incomplete release publication has no authenticating reservation");
    }
    for (const artifact of state.artifacts) {
      const alias = artifact.alias;
      const sourceHandle = guard.openRegularAt(destinationHandle, alias, "read");
      try {
        const source = guard.statHandle(sourceHandle);
        if (source.type !== "file" || source.uid !== uid || (source.mode & 0o022) !== 0 ||
            source.size.toString() !== artifact.size ||
            !guard.handleHasNoExtendedAcl(sourceHandle) ||
            guard.sha256Handle(sourceHandle) !== artifact.sha256 ||
            !guard.sameBinding(destinationHandle, alias, sourceHandle)) {
          throw new Error(`release publication source failed byte and metadata authentication: ${alias}`);
        }
        let published = guard.statAt(parent, alias);
        if (published === null) {
          if (!guard.linkNoReplaceAt(destinationHandle, alias, parent, alias)) {
            published = guard.statAt(parent, alias);
          } else {
            published = guard.statAt(parent, alias);
          }
        }
        if (!published || published.type !== "file" ||
            published.dev !== source.dev || published.ino !== source.ino) {
          throw new Error(`release compatibility alias is not the authenticated hard link: ${alias}`);
        }
      } finally {
        guard.close(sourceHandle);
      }
    }
    assertPublicationContentsComplete(
      guard,
      destinationHandle,
      parent,
      state,
      uid,
      "release publication",
    );
    guard.fsyncHandle(parent);
    if (existingCompletion === null) {
      guard.writeFileAt(
        destinationHandle,
        RELEASE_PUBLICATION_COMPLETE_FILENAME,
        completionContents,
        0o444,
      );
      guard.fsyncHandle(destinationHandle);
      guard.fsyncHandle(parent);
    } else {
      const existing = readPublicationRecord(
        guard,
        destinationHandle,
        RELEASE_PUBLICATION_COMPLETE_FILENAME,
        uid,
        0o444,
        "release completion marker",
      );
      if (!existing.equals(completionContents)) {
        throw new Error("release completion marker does not authenticate publication state");
      }
    }
    if (reservationHandle) {
      if (reservationHasState) {
        guard.unlinkFileAt(reservationHandle, RELEASE_PUBLICATION_STATE_FILENAME);
      }
      guard.fsyncHandle(reservationHandle);
      guard.close(reservationHandle);
      reservationHandle = undefined;
      guard.unlinkDirAt(parent, reservationLeaf);
      guard.fsyncHandle(parent);
    }
  } finally {
    if (reservationHandle) guard.close(reservationHandle);
    if (destinationHandle) guard.close(destinationHandle);
    guard.close(parent);
  }
}

export function assertReleasePublicationComplete(
  destinationPath: string,
  outputRootPath: string,
  expectedPublicationIdentitySHA256: string,
): void {
  const destination = resolve(destinationPath);
  const outputRoot = resolve(outputRootPath);
  if (dirname(destination) !== outputRoot) {
    throw new Error("release destination must be a direct output-root child");
  }
  const destinationLeaf = basename(destination);
  const { guard, parent, uid } = publicationParent(outputRoot);
  let destinationHandle: NativeHandle | undefined;
  try {
    destinationHandle = guard.openDirAt(parent, destinationLeaf);
    assertSecurePublicationDirectory(guard, destinationHandle, uid, "published release directory");
    if (!guard.sameBinding(parent, destinationLeaf, destinationHandle)) {
      throw new Error("published release directory binding changed");
    }
    const stateContents = readPublicationRecord(
      guard,
      destinationHandle,
      RELEASE_PUBLICATION_STATE_FILENAME,
      uid,
      0o444,
      "published release state",
    );
    const state = parsePublicationState(
      stateContents,
      destinationLeaf,
      expectedPublicationIdentitySHA256,
    );
    const completionContents = readPublicationRecord(
      guard,
      destinationHandle,
      RELEASE_PUBLICATION_COMPLETE_FILENAME,
      uid,
      0o444,
      "release completion marker",
    );
    if (!completionContents.equals(releaseCompletionBytes(stateContents))) {
      throw new Error("release completion marker does not authenticate publication state");
    }
    assertPublicationContentsComplete(
      guard,
      destinationHandle,
      parent,
      state,
      uid,
      "release publication",
    );
  } finally {
    if (destinationHandle) guard.close(destinationHandle);
    guard.close(parent);
  }
}

export function treeRecords(root: string): string[] {
  const records: string[] = [];
  const visit = (path: string): void => {
    const details = lstatSync(path);
    if (details.isSymbolicLink()) throw new Error(`tree digest refuses symlink: ${path}`);
    const name = relative(root, path) || ".";
    const mode = (details.mode & 0o777).toString(8);
    if (details.isDirectory()) {
      records.push(`d\0${name}\0${mode}`);
      for (const entry of sortUnsignedUtf8(readdirSync(path))) visit(join(path, entry));
    } else if (details.isFile()) {
      records.push(`f\0${name}\0${mode}\0${details.size}\0${sha256File(path)}`);
    } else {
      throw new Error(`tree digest refuses special file: ${path}`);
    }
  };
  visit(root);
  return records;
}

export function treeDigest(root: string): string {
  return sha256(treeRecords(root).join("\n"));
}


