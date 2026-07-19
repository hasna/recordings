import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const BUN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const INSTALLER_ENVIRONMENT_KEYS = [
  "HOME",
  "SSH_CONNECTION",
  "RECORDINGS_EXPECTED_TEAM_IDENTIFIER",
  "RECORDINGS_LAUNCH_TIMEOUT_SECONDS",
  "RECORDINGS_LOCK_STALE_SECONDS",
  "RECORDINGS_MAINTENANCE_STALE_SECONDS",
  "RECORDINGS_READER_DRAIN_TIMEOUT_MS",
  "RECORDINGS_SQLITE_BUSY_TIMEOUT_MS",
] as const;
const INSTALLER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

type BunExecutableValidation =
  | { executable: string; version: string }
  | { reason: string };

export function validateBunExecutable(candidate: string): BunExecutableValidation {
  if (!isAbsolute(candidate)) return { reason: "path is not absolute" };

  let executable: string;
  try {
    executable = realpathSync(candidate);
    if (!statSync(executable).isFile()) return { reason: "resolved path is not a regular file" };
    accessSync(executable, fsConstants.X_OK);
  } catch {
    return { reason: "path is missing, inaccessible, or not executable" };
  }

  const nonce = randomBytes(24).toString("hex");
  const probe = spawnSync(
    executable,
    [
      "-e",
      `
        import { realpathSync, statSync } from "node:fs";
        const expected = process.argv[1];
        const nonce = process.argv[2];
        const actual = process.execPath;
        if (!expected || !nonce || realpathSync(actual) !== realpathSync(expected)) process.exit(66);
        if (!statSync(actual).isFile()) process.exit(66);
        if (!/^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$/.test(Bun.version)) {
          process.exit(66);
        }
        process.stdout.write(nonce + ":" + Bun.version);
      `,
      executable,
      nonce,
    ],
    {
      encoding: "utf8",
      env: {
        HOME: "/tmp",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: "/tmp",
      },
      maxBuffer: 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    },
  );
  const output = probe.stdout?.trim() ?? "";
  const prefix = `${nonce}:`;
  const version = output.startsWith(prefix) ? output.slice(prefix.length) : "";
  if (probe.error || probe.status !== 0 || !BUN_VERSION_PATTERN.test(version)) {
    return { reason: "behavioral Bun -e probe failed" };
  }
  return { executable, version };
}

export function resolveInstallBunExecutable(
  environment: NodeJS.ProcessEnv,
  activeExecutable = process.execPath,
): string {
  if (environment.RECORDINGS_BUN_EXECUTABLE !== undefined) {
    const explicit = validateBunExecutable(environment.RECORDINGS_BUN_EXECUTABLE);
    if (!("executable" in explicit)) {
      throw new Error(
        `RECORDINGS_BUN_EXECUTABLE is not a validated general Bun interpreter: ${explicit.reason}`,
      );
    }
    return explicit.executable;
  }

  const active = validateBunExecutable(activeExecutable);
  if ("executable" in active) return active.executable;

  throw new Error(
    "The active recordings executable is not a general Bun interpreter; rerun app install from the Bun-interpreted package CLI or set RECORDINGS_BUN_EXECUTABLE to an explicitly trusted absolute Bun executable",
  );
}

export function createInstallerEnvironment(
  environment: NodeJS.ProcessEnv,
  bunExecutable: string,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const key of INSTALLER_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined) sanitized[key] = value;
  }
  // The installer pins every external tool it invokes. Do not let caller PATH
  // influence either direct shell command lookup or target-identity binding.
  sanitized.PATH = INSTALLER_PATH;
  // Keep ps -o lstart lease identities byte-stable across the TypeScript
  // producer and the installer shell's live-owner validation.
  sanitized.LC_ALL = "C";
  sanitized.LANG = "C";
  sanitized.TZ = "UTC0";
  sanitized.RECORDINGS_BUN_EXECUTABLE = bunExecutable;
  return sanitized;
}
