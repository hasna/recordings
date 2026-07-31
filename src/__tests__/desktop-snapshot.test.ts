import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DESKTOP_SNAPSHOT,
  exportDesktopSnapshot,
} from "../cli/desktop-snapshot";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recordings-desktop-snapshot-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("exportDesktopSnapshot", () => {
  test("captures the main display and atomically replaces the default snapshot", () => {
    const root = tempRoot();
    const destination = join(root, DEFAULT_DESKTOP_SNAPSHOT);
    writeFileSync(destination, "previous snapshot");
    let invocation: { executable: string; arguments_: string[] } | undefined;

    const result = exportDesktopSnapshot(undefined, {
      platform: "darwin",
      cwd: root,
      capture(executable, arguments_) {
        invocation = { executable, arguments_ };
        writeFileSync(arguments_.at(-1)!, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return { status: 0, stderr: "" };
      },
    });

    expect(result).toBe(destination);
    expect(invocation?.executable).toBe("/usr/sbin/screencapture");
    expect(invocation?.arguments_.slice(0, -1)).toEqual(["-x", "-m", "-C", "-t", "png"]);
    expect(readFileSync(destination)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toEqual([DEFAULT_DESKTOP_SNAPSHOT]);
  });

  test("creates an explicitly requested output directory", () => {
    const root = tempRoot();
    const result = exportDesktopSnapshot("debug/current.png", {
      platform: "darwin",
      cwd: root,
      capture(_executable, arguments_) {
        writeFileSync(arguments_.at(-1)!, "png");
        return { status: 0 };
      },
    });

    expect(result).toBe(join(root, "debug", "current.png"));
    expect(readFileSync(result, "utf8")).toBe("png");
  });

  test("rejects non-macOS hosts before creating the output directory", () => {
    const root = tempRoot();
    const outputDirectory = join(root, "not-created");

    expect(() =>
      exportDesktopSnapshot(join(outputDirectory, "snapshot.png"), {
        platform: "linux",
      }),
    ).toThrow("only supported on macOS");
    expect(existsSync(outputDirectory)).toBeFalse();
  });

  test("keeps the previous snapshot when screencapture fails", () => {
    const root = tempRoot();
    const destination = join(root, "current.png");
    writeFileSync(destination, "previous snapshot");

    expect(() =>
      exportDesktopSnapshot(destination, {
        platform: "darwin",
        capture: () => ({ status: 1, stderr: "screen capture is not permitted" }),
      }),
    ).toThrow("screen capture is not permitted");
    expect(readFileSync(destination, "utf8")).toBe("previous snapshot");
    expect(readdirSync(root)).toEqual(["current.png"]);
  });

  test("rejects a successful command that did not write an image", () => {
    const root = tempRoot();
    mkdirSync(join(root, "output"));

    expect(() =>
      exportDesktopSnapshot("output/current.png", {
        platform: "darwin",
        cwd: root,
        capture: () => ({ status: 0 }),
      }),
    ).toThrow("produced no image");
    expect(readdirSync(join(root, "output"))).toEqual([]);
  });
});
