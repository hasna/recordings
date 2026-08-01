import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SCREEN_CAPTURE_EXECUTABLE = "/usr/sbin/screencapture";
export const DEFAULT_DESKTOP_SNAPSHOT = "desktop-snapshot.png";

type CaptureResult = {
  error?: Error;
  status: number | null;
  stderr?: string;
};

type DesktopSnapshotDependencies = {
  platform?: NodeJS.Platform;
  cwd?: string;
  capture?: (executable: string, arguments_: string[]) => CaptureResult;
};

function runScreenCapture(executable: string, arguments_: string[]): CaptureResult {
  const result = spawnSync(executable, arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  return {
    error: result.error,
    status: result.status,
    stderr: result.stderr,
  };
}

/**
 * Write a main-display snapshot to a stable caller-visible path.
 *
 * `screencapture` writes into a private sibling directory first so a denied Screen Recording
 * grant or an interrupted capture cannot truncate a useful snapshot from the previous run.
 */
export function exportDesktopSnapshot(
  output = DEFAULT_DESKTOP_SNAPSHOT,
  dependencies: DesktopSnapshotDependencies = {},
): string {
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    throw new Error("Desktop snapshots are only supported on macOS");
  }

  const destination = resolve(dependencies.cwd ?? process.cwd(), output);
  const destinationDirectory = dirname(destination);
  mkdirSync(destinationDirectory, { recursive: true });

  const stagingDirectory = mkdtempSync(join(destinationDirectory, ".recordings-desktop-"));
  chmodSync(stagingDirectory, 0o700);
  const stagingPath = join(stagingDirectory, "snapshot.png");

  try {
    const capture = dependencies.capture ?? runScreenCapture;
    const result = capture(SCREEN_CAPTURE_EXECUTABLE, [
      "-x",
      "-m",
      "-C",
      "-t",
      "png",
      stagingPath,
    ]);

    if (result.error) {
      throw new Error(`Could not run macOS screencapture: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = result.stderr?.trim();
      throw new Error(
        detail
          ? `Desktop snapshot failed: ${detail}`
          : "Desktop snapshot failed; allow Screen Recording access for the invoking terminal",
      );
    }

    let size = 0;
    try {
      const snapshot = statSync(stagingPath);
      if (snapshot.isFile()) size = snapshot.size;
    } catch {
      // Report one useful capture error below instead of leaking a filesystem-specific stat error.
    }
    if (size === 0) {
      throw new Error(
        "Desktop snapshot produced no image; allow Screen Recording access for the invoking terminal",
      );
    }

    chmodSync(stagingPath, 0o600);
    renameSync(stagingPath, destination);
    return destination;
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}
