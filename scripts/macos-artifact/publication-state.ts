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

import { compareUnsignedUtf8, sha256, sortUnsignedUtf8 } from "./common";
import { canonicalJson } from "./artifacts";
import { isHex } from "./layout";
import { sameStrings } from "./manifest";
import { releaseCompletionBytes } from "./publication";

export type ReleasePublicationState = {
  schema_version: 4;
  publication_id: string;
  publication_identity_sha256: string;
  destination: string;
  artifacts: Array<{
    alias: string;
    size: string;
    sha256: string;
  }>;
  nested_publications: Array<{
    alias: string;
    publication_identity_sha256: string;
  }>;
};

export const RELEASE_PUBLICATION_STATE_FILENAME = ".recordings-publication.json";
export const RELEASE_PUBLICATION_COMPLETE_FILENAME = ".recordings-publication-complete.json";
export const RELEASE_PUBLICATION_RECORD_LIMIT = 64 * 1024;
export const RELEASE_PUBLICATION_IDENTITY_COMPONENT_LIMIT = 8 * 1024;
export const RELEASE_PUBLICATION_IDENTITY_COMPONENT_COUNT_LIMIT = 64;

export function releasePublicationIdentity(components: string[]): string {
  if (
    components.length === 0 ||
    components.length > RELEASE_PUBLICATION_IDENTITY_COMPONENT_COUNT_LIMIT
  ) {
    throw new Error("release publication identity requires a bounded non-empty component set");
  }
  const canonicalComponents: Record<string, string> = {};
  for (const component of components) {
    const separator = component.indexOf("=");
    const key = separator > 0 ? component.slice(0, separator) : "";
    const value = separator > 0 ? component.slice(separator + 1) : "";
    if (
      !/^[a-z][a-z0-9_]*$/.test(key) ||
      value.length === 0 ||
      Buffer.byteLength(component, "utf8") > RELEASE_PUBLICATION_IDENTITY_COMPONENT_LIMIT ||
      component.includes("\0") ||
      component.includes("\r") ||
      component.includes("\n") ||
      Object.prototype.hasOwnProperty.call(canonicalComponents, key)
    ) {
      throw new Error("release publication identity component is invalid or duplicated");
    }
    canonicalComponents[key] = value;
  }
  return sha256(Buffer.from(canonicalJson({
    schema_version: 1,
    components: canonicalComponents,
  }), "utf8"));
}

export function assertPublicationLeaf(leaf: string, label: string): void {
  if (!leaf || leaf === "." || leaf === ".." || leaf.includes("/") || leaf.includes("\0")) {
    throw new Error(`${label} must be one non-dot path component`);
  }
}

export function assertSecurePublicationDirectory(
  guard: NativeFsGuard,
  handle: NativeHandle,
  expectedUid: number,
  label: string,
): NativeMetadata {
  const details = guard.statHandle(handle);
  if (
    details.type !== "directory" ||
    details.uid !== expectedUid ||
    (details.mode & 0o022) !== 0 ||
    !guard.handleHasNoExtendedAcl(handle)
  ) {
    throw new Error(`${label} has an unsafe type, owner, mode, or extended ACL`);
  }
  return details;
}

export function publicationParent(path: string): {
  guard: NativeFsGuard;
  parent: NativeHandle;
  uid: number;
} {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("release publication requires a numeric process uid");
  const guard = nativeFsGuard();
  const parent = guard.openTrustedHome(path, uid);
  try {
    assertSecurePublicationDirectory(guard, parent, uid, "release publication parent");
    return { guard, parent, uid };
  } catch (error) {
    guard.close(parent);
    throw error;
  }
}

export function publicationStateBytes(state: ReleasePublicationState): Buffer {
  return Buffer.from(`${canonicalJson(state)}\n`, "utf8");
}

export function readPublicationRecord(
  guard: NativeFsGuard,
  parent: NativeHandle,
  leaf: string,
  expectedUid: number,
  expectedMode: number,
  label: string,
): Buffer {
  const handle = guard.openRegularAt(parent, leaf, "read");
  try {
    const details = guard.statHandle(handle);
    if (details.type !== "file" || details.uid !== expectedUid ||
        (details.mode & 0o777) !== expectedMode || details.nlink !== 1 ||
        !guard.handleHasNoExtendedAcl(handle) || !guard.sameBinding(parent, leaf, handle)) {
      throw new Error(`${label} has an unsafe type, owner, mode, link count, ACL, or binding`);
    }
    const contents = guard.readRegularAt(parent, leaf, RELEASE_PUBLICATION_RECORD_LIMIT);
    if (guard.sha256Handle(handle) !== sha256(contents) || !guard.sameBinding(parent, leaf, handle)) {
      throw new Error(`${label} changed while it was authenticated`);
    }
    return contents;
  } finally {
    guard.close(handle);
  }
}

export function parsePublicationState(
  contents: Buffer,
  destinationLeaf: string,
  expectedPublicationIdentitySHA256: string,
): ReleasePublicationState {
  const value = JSON.parse(contents.toString("utf8")) as Partial<ReleasePublicationState>;
  if (
    !isHex(expectedPublicationIdentitySHA256, 64) ||
    value.schema_version !== 4 ||
    typeof value.publication_id !== "string" ||
    !/^[0-9a-f-]{36}$/.test(value.publication_id) ||
    value.publication_identity_sha256 !== expectedPublicationIdentitySHA256 ||
    value.destination !== destinationLeaf ||
    !Array.isArray(value.artifacts) ||
    !Array.isArray(value.nested_publications) ||
    Object.keys(value).sort().join(",") !==
      "artifacts,destination,nested_publications,publication_id,publication_identity_sha256,schema_version" ||
    value.artifacts.some((artifact) =>
      !artifact || typeof artifact !== "object" || Array.isArray(artifact) ||
      typeof (artifact as { alias?: unknown }).alias !== "string" ||
      typeof (artifact as { size?: unknown }).size !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test((artifact as { size: string }).size) ||
      typeof (artifact as { sha256?: unknown }).sha256 !== "string" ||
      !isHex((artifact as { sha256: string }).sha256, 64)
    )
  ) {
    throw new Error("release publication state is invalid or names another destination");
  }
  const artifacts = value.artifacts as ReleasePublicationState["artifacts"];
  const aliases = artifacts.map((artifact) => artifact.alias);
  for (const alias of aliases) assertPublicationLeaf(alias, "release compatibility alias");
  if (
    aliases.includes(destinationLeaf) ||
    aliases.includes(RELEASE_PUBLICATION_STATE_FILENAME) ||
    aliases.includes(RELEASE_PUBLICATION_COMPLETE_FILENAME) ||
    new Set(aliases).size !== aliases.length ||
    !sameStrings(aliases, sortUnsignedUtf8([...aliases])) ||
    artifacts.some((artifact) => Object.keys(artifact).sort().join(",") !== "alias,sha256,size")
  ) {
    throw new Error("release publication state has unsafe, duplicate, or unsorted aliases");
  }
  const nestedPublications =
    value.nested_publications as ReleasePublicationState["nested_publications"];
  const nestedAliases = nestedPublications.map((publication) => publication?.alias);
  if (
    nestedPublications.some((publication) =>
      !publication || typeof publication !== "object" || Array.isArray(publication) ||
      typeof publication.alias !== "string" ||
      typeof publication.publication_identity_sha256 !== "string" ||
      !isHex(publication.publication_identity_sha256, 64) ||
      Object.keys(publication).sort().join(",") !==
        "alias,publication_identity_sha256"
    ) ||
    nestedAliases.some((alias) => typeof alias !== "string") ||
    nestedAliases.some((alias) => {
      assertPublicationLeaf(alias, "nested release publication alias");
      return false;
    }) ||
    nestedAliases.includes(destinationLeaf) ||
    nestedAliases.includes(RELEASE_PUBLICATION_STATE_FILENAME) ||
    nestedAliases.includes(RELEASE_PUBLICATION_COMPLETE_FILENAME) ||
    new Set(nestedAliases).size !== nestedAliases.length ||
    !sameStrings(nestedAliases, sortUnsignedUtf8([...nestedAliases])) ||
    nestedAliases.some((alias) => aliases.includes(alias))
  ) {
    throw new Error("release publication state has unsafe or duplicate nested publications");
  }
  const state = value as ReleasePublicationState;
  if (!publicationStateBytes(state).equals(contents)) {
    throw new Error("release publication state is not canonically encoded");
  }
  return state;
}

export function parseNestedPublicationBindings(
  bindings: string[],
): ReleasePublicationState["nested_publications"] {
  const publications = bindings.map((binding) => {
    const separator = binding.indexOf("=");
    const alias = separator > 0 ? binding.slice(0, separator) : "";
    const publicationIdentitySHA256 = separator > 0 ? binding.slice(separator + 1) : "";
    assertPublicationLeaf(alias, "nested release publication alias");
    if (!isHex(publicationIdentitySHA256, 64)) {
      throw new Error("nested release publication identity SHA-256 is invalid");
    }
    return {
      alias,
      publication_identity_sha256: publicationIdentitySHA256,
    };
  }).sort((left, right) => compareUnsignedUtf8(left.alias, right.alias));
  if (new Set(publications.map((publication) => publication.alias)).size !== publications.length) {
    throw new Error("nested release publication aliases must be unique");
  }
  return publications;
}

export function assertPublicationContentsComplete(
  guard: NativeFsGuard,
  directoryHandle: NativeHandle,
  aliasParentHandle: NativeHandle,
  state: ReleasePublicationState,
  expectedUid: number,
  label: string,
  depth = 0,
): void {
  if (depth > 8) throw new Error("nested release publication depth exceeds the supported limit");
  for (const artifact of state.artifacts) {
    const alias = artifact.alias;
    const sourceHandle = guard.openRegularAt(directoryHandle, alias, "read");
    try {
      const source = guard.statHandle(sourceHandle);
      const published = guard.statAt(aliasParentHandle, alias);
      if (source.type !== "file" || source.uid !== expectedUid || (source.mode & 0o022) !== 0 ||
          source.size.toString() !== artifact.size ||
          !guard.handleHasNoExtendedAcl(sourceHandle) ||
          guard.sha256Handle(sourceHandle) !== artifact.sha256 ||
          !guard.sameBinding(directoryHandle, alias, sourceHandle) ||
          !published || published.type !== "file" ||
          source.dev !== published.dev || source.ino !== published.ino) {
        throw new Error(`${label} compatibility alias is missing or unauthenticated: ${alias}`);
      }
    } finally {
      guard.close(sourceHandle);
    }
  }
  for (const nested of state.nested_publications) {
    const nestedHandle = guard.openDirAt(directoryHandle, nested.alias);
    try {
      assertSecurePublicationDirectory(
        guard,
        nestedHandle,
        expectedUid,
        `${label} nested publication directory`,
      );
      if (!guard.sameBinding(directoryHandle, nested.alias, nestedHandle)) {
        throw new Error(`${label} nested publication directory binding changed`);
      }
      const nestedStateContents = readPublicationRecord(
        guard,
        nestedHandle,
        RELEASE_PUBLICATION_STATE_FILENAME,
        expectedUid,
        0o444,
        `${label} nested publication state`,
      );
      const nestedState = parsePublicationState(
        nestedStateContents,
        nested.alias,
        nested.publication_identity_sha256,
      );
      const nestedCompletion = readPublicationRecord(
        guard,
        nestedHandle,
        RELEASE_PUBLICATION_COMPLETE_FILENAME,
        expectedUid,
        0o444,
        `${label} nested publication completion marker`,
      );
      if (!nestedCompletion.equals(releaseCompletionBytes(nestedStateContents))) {
        throw new Error(`${label} nested completion marker does not authenticate publication state`);
      }
      assertPublicationContentsComplete(
        guard,
        nestedHandle,
        directoryHandle,
        nestedState,
        expectedUid,
        `${label} nested publication`,
        depth + 1,
      );
    } finally {
      guard.close(nestedHandle);
    }
  }
}


