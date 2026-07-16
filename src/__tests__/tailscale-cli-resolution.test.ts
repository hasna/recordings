import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
const resolver = join(repositoryRoot, "scripts", "resolve_tailscale_cli.sh");
const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "recordings-tailscale-resolver-"));
  temporaryPaths.push(directory);
  return directory;
}

function writeExecutable(path: string, body = "printf '%s\\n' '{\"Self\":{}}'\n"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${body}`);
  chmodSync(path, 0o755);
}

async function resolveWith(options: {
  path: string;
  fallback: string;
  invoke?: boolean;
  defineFunction?: string;
}) {
  const root = temporaryDirectory();
  const wrapper = join(root, "run.sh");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bash
set -euo pipefail
source "$RESOLVER"
recordings_tailscale_standard_app_cli() { printf '%s\\n' "$FALLBACK"; }
${options.defineFunction ?? ""}
resolved="$(recordings_resolve_tailscale_cli)"
printf 'resolved=%s\\n' "$resolved"
${options.invoke ? '"$resolved" status --json' : ""}
`,
  );
  chmodSync(wrapper, 0o755);
  const process = Bun.spawn(["/bin/bash", wrapper], {
    env: {
      ...Bun.env,
      PATH: options.path,
      RESOLVER: resolver,
      FALLBACK: options.fallback,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { root, exitCode, stdout, stderr };
}

describe("Tailscale CLI resolution", () => {
  test("pins the production fallback to the standard Tailscale app CLI", () => {
    const source = readFileSync(resolver, "utf8");
    expect(source).toContain("'/Applications/Tailscale.app/Contents/MacOS/Tailscale'");
    expect(source).toContain("builtin type -P tailscale");
  });

  test("prefers a PATH executable over the app fallback", async () => {
    const root = temporaryDirectory();
    const pathCli = join(root, "bin", "tailscale");
    const fallback = join(root, "app", "Tailscale");
    writeExecutable(pathCli);
    writeExecutable(fallback);

    const result = await resolveWith({ path: dirname(pathCli), fallback });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`resolved=${pathCli}`);
  });

  test("uses an executable app fallback when PATH has no Tailscale CLI", async () => {
    const root = temporaryDirectory();
    const fallback = join(root, "Tailscale App", "Contents", "MacOS", "Tailscale");
    writeExecutable(fallback);

    const result = await resolveWith({ path: join(root, "empty-bin"), fallback });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`resolved=${fallback}`);
  });

  test("accepts an executable PATH symlink and preserves its resolved command path", async () => {
    const root = temporaryDirectory();
    const realCli = join(root, "libexec", "tailscale-real");
    const pathCli = join(root, "bin", "tailscale");
    const fallback = join(root, "app", "Tailscale");
    writeExecutable(realCli);
    mkdirSync(dirname(pathCli), { recursive: true });
    symlinkSync(realCli, pathCli);
    writeExecutable(fallback);

    const result = await resolveWith({ path: dirname(pathCli), fallback });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`resolved=${pathCli}`);
  });

  test.each(["missing", "non-executable"])("rejects a %s fallback", async (kind) => {
    const root = temporaryDirectory();
    const fallback = join(root, "app", "Tailscale");
    if (kind === "non-executable") {
      mkdirSync(dirname(fallback), { recursive: true });
      writeFileSync(fallback, "not executable\n");
      chmodSync(fallback, 0o644);
    }

    const result = await resolveWith({ path: join(root, "empty-bin"), fallback });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not an executable file");
  });

  test("rejects a dangling fallback symlink", async () => {
    const root = temporaryDirectory();
    const fallback = join(root, "app", "Tailscale");
    mkdirSync(dirname(fallback), { recursive: true });
    symlinkSync(join(root, "missing-target"), fallback);

    const result = await resolveWith({ path: join(root, "empty-bin"), fallback });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not an executable file");
  });

  test.each([
    ["relative", "relative/Tailscale", "must be absolute"],
    ["multi-line", "/tmp/one\n/tmp/two", "malformed"],
    ["carriage-return", "/tmp/one\r/tmp/two", "malformed"],
  ])("rejects an ambiguous or unsafe %s path", async (_label, fallback, expectedError) => {
    const root = temporaryDirectory();
    const result = await resolveWith({ path: join(root, "empty-bin"), fallback });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(expectedError);
  });

  test("quotes a resolved path instead of evaluating shell metacharacters", async () => {
    const root = temporaryDirectory();
    const marker = join(root, "injected");
    const bin = join(root, "bin");
    const fallback = join(root, `Tailscale;touch ${marker}`);
    writeExecutable(fallback, "printf '%s\\n' '{\"Self\":{\"Online\":true}}'\n");
    writeExecutable(join(bin, "touch"), ': > "$1"\n');

    const result = await resolveWith({ path: bin, fallback, invoke: true });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('{"Self":{"Online":true}}');
    expect(existsSync(marker)).toBeFalse();
  });

  test("ignores an injected shell function named tailscale", async () => {
    const root = temporaryDirectory();
    const marker = join(root, "function-injected");
    const fallback = join(root, "app", "Tailscale");
    writeExecutable(fallback);

    const result = await resolveWith({
      path: join(root, "empty-bin"),
      fallback,
      defineFunction: `tailscale() { : > "${marker}"; }`,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`resolved=${fallback}`);
    expect(existsSync(marker)).toBeFalse();
  });
});
