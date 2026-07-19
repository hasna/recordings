import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export const INSTALL_MAINTENANCE_MARKER_NAME = ".recordings-install-maintenance";
export const STORE_READER_LEASES_NAME = ".recordings-store-readers";

function stateParent(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  const home = env["HOME"] || env["USERPROFILE"] || homedir();
  return join(home, ".hasna");
}

export function installMaintenanceMarkerPath(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  return join(stateParent(env), INSTALL_MAINTENANCE_MARKER_NAME);
}

export function storeReaderLeasesPath(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  return join(stateParent(env), STORE_READER_LEASES_NAME);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertPrivateDirectory(path: string): void {
  const details = lstatSync(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`Local Recordings coordination path is not a secure directory: ${path}`);
  }
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    throw new Error(`Local Recordings coordination path has an unexpected owner: ${path}`);
  }
  if ((details.mode & 0o022) !== 0) {
    throw new Error(`Local Recordings coordination path is group/world writable: ${path}`);
  }
}

function ensureReaderRoot(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string {
  const parent = stateParent(env);
  const readerRoot = storeReaderLeasesPath(env);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(parent);
  try {
    mkdirSync(readerRoot, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertPrivateDirectory(readerRoot);
  return readerRoot;
}

function processStartIdentity(): string {
  const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], {
    encoding: "utf8",
    // The installer compares these bytes under its sanitized environment.
    // ps localizes lstart and applies TZ, so both producer and validator must
    // use one locale and timezone.
    env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC0" },
  });
  const identity = result.status === 0
    ? result.stdout.trim().replace(/\s+/g, " ")
    : "";
  if (!identity) {
    throw new Error("Could not establish the local Store reader process identity");
  }
  return identity;
}

function maintenanceUnavailable(): Error {
  return new Error(
    "Local Recordings storage is temporarily unavailable during app installation maintenance",
  );
}

function assertMaintenanceAbsent(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): void {
  if (pathExists(installMaintenanceMarkerPath(env))) throw maintenanceUnavailable();
}

function canonicalPotentialPath(path: string): string {
  const absolutePath = resolve(path);
  let existingPath = absolutePath;
  const missingEntries: string[] = [];

  while (true) {
    try {
      return join(realpathSync(existingPath), ...missingEntries);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return absolutePath;
      const parent = dirname(existingPath);
      if (parent === existingPath) return absolutePath;
      missingEntries.unshift(basename(existingPath));
      existingPath = parent;
    }
  }
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

/**
 * Return whether a path can be changed by the global Recordings state
 * transaction. Both lexical and existing-prefix canonical paths are checked so
 * an alias into ~/.hasna/recordings cannot silently bypass maintenance.
 */
export function isGlobalRecordingsStatePath(
  path: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const globalStateRoot = join(stateParent(env), "recordings");
  return pathIsWithin(resolve(globalStateRoot), resolve(path)) ||
    pathIsWithin(canonicalPotentialPath(globalStateRoot), canonicalPotentialPath(path));
}

function removeActiveLease(activeLease: string, releasedLease: string): void {
  try {
    renameSync(activeLease, releasedLease);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  rmSync(releasedLease, { recursive: true, force: true });
}

/**
 * Synchronously publish one cross-process local-state lease. The returned
 * release callback is idempotent and must remain owned until all writes that
 * could overlap installation rollback have finished.
 */
export function acquireLocalStoreReaderLease(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): () => void {
  assertMaintenanceAbsent(env);
  const readerRoot = ensureReaderRoot(env);
  const nonce = randomUUID();
  const pendingLease = join(readerRoot, `.pending-${process.pid}-${nonce}`);
  const activeLease = join(readerRoot, `lease-${process.pid}-${nonce}`);
  const releasedLease = join(readerRoot, `.released-${process.pid}-${nonce}`);
  let active = false;

  try {
    mkdirSync(pendingLease, { mode: 0o700 });
    const owner = join(pendingLease, "owner");
    writeFileSync(owner, `${process.pid}\n${processStartIdentity()}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(owner, 0o600);
    renameSync(pendingLease, activeLease);
    active = true;
    assertMaintenanceAbsent(env);
  } catch (error) {
    if (active) removeActiveLease(activeLease, releasedLease);
    else rmSync(pendingLease, { recursive: true, force: true });
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    removeActiveLease(activeLease, releasedLease);
    released = true;
  };
}

/**
 * Hold a cross-process reader lease for the full lifetime of one local Store
 * operation. The marker/lease/marker sequence closes both acquisition races:
 * an installer either observes and drains this lease, or this caller observes
 * the install marker and aborts before touching local storage.
 */
export async function withLocalStoreReaderLease<T>(
  operation: () => T | Promise<T>,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<T> {
  const release = acquireLocalStoreReaderLease(env);
  try {
    return await operation();
  } finally {
    release();
  }
}
