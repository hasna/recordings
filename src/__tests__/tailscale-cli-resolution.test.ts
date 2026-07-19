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

function createTrustedApp(root: string, body?: string): { app: string; cli: string } {
  const app = join(root, "Tailscale.app");
  const cli = join(app, "Contents", "MacOS", "Tailscale");
  writeExecutable(
    cli,
    body ??
      `printf '%s\\n' "$0" >> "$MARKER_DIRECTORY/status-path.log"\nprintf '%s\\n' '{"Self":{"Online":true,"HostName":"station06","ID":"node-1"}}'\n`,
  );
  writeFileSync(join(app, "signature-team"), "W5364U7YZB\n");
  writeFileSync(join(app, "signature-identifier"), "io.tailscale.ipn.macsys\n");
  return { app, cli };
}

function createCodesignStub(root: string): string {
  const executable = join(root, "tools", "codesign");
  writeExecutable(
    executable,
    `app="\${@: -1}"
case "$app" in
  */Contents/MacOS/Tailscale) app="\${app%/Contents/MacOS/Tailscale}" ;;
esac
team="$(/bin/cat "$app/signature-team")"
identifier="$(/bin/cat "$app/signature-identifier")"
if [[ " $* " == *" --verify "* ]]; then
  [ "$team" = W5364U7YZB ] && [ "$identifier" = io.tailscale.ipn.macsys ] || exit 1
fi
if [[ " $* " == *" -d "* ]]; then
  printf 'Identifier=%s\\nTeamIdentifier=%s\\n' "$identifier" "$team" >&2
fi
`,
  );
  return executable;
}

function createDittoStub(root: string, mutateSnapshot = false): string {
  const executable = join(root, "tools", "ditto");
  writeExecutable(
    executable,
    `source="$1"
destination="$2"
/bin/cp -R "$source" "$destination"
${mutateSnapshot ? `printf 'ATTACKER1\\n' > "$destination/signature-team"` : ""}
`,
  );
  return executable;
}

async function trustedSnapshotWith(options: {
  team?: string;
  identifier?: string;
  mutateSnapshot?: boolean;
  replaceSourceBeforeStatus?: boolean;
}) {
  const root = temporaryDirectory();
  const markerDirectory = join(root, "markers");
  const snapshotParent = join(root, "private-work");
  mkdirSync(markerDirectory, { mode: 0o700 });
  mkdirSync(snapshotParent, { mode: 0o700 });
  const source = createTrustedApp(root);
  if (options.team) writeFileSync(join(source.app, "signature-team"), `${options.team}\n`);
  if (options.identifier) {
    writeFileSync(join(source.app, "signature-identifier"), `${options.identifier}\n`);
  }
  const codesign = createCodesignStub(root);
  const ditto = createDittoStub(root, options.mutateSnapshot);
  const wrapper = join(root, "snapshot.sh");
  writeFileSync(
    wrapper,
    `#!/bin/bash
set -euo pipefail
source "$RESOLVER"
snapshot_cli="$(recordings_resolve_trusted_tailscale_app_cli "$SNAPSHOT_PARENT")"
printf 'resolved=%s\\n' "$snapshot_cli"
${
  options.replaceSourceBeforeStatus
    ? `printf '#!/bin/bash\\nprintf attacker\\n' > "$SOURCE_CLI"\n/bin/chmod 755 "$SOURCE_CLI"`
    : ""
}
recordings_run_trusted_tailscale_status "$snapshot_cli" "$SNAPSHOT_PARENT"
`,
  );
  chmodSync(wrapper, 0o755);
  const process = Bun.spawn(["/bin/bash", wrapper], {
    env: resolverChildEnvironment(Bun.env, {
      RESOLVER: resolver,
      SNAPSHOT_PARENT: snapshotParent,
      SOURCE_CLI: source.cli,
      MARKER_DIRECTORY: markerDirectory,
      RECORDINGS_TEST_TRUSTED_TAILSCALE_APP: source.app,
      RECORDINGS_TEST_TAILSCALE_CODESIGN_EXECUTABLE: codesign,
      RECORDINGS_TEST_TAILSCALE_DITTO_EXECUTABLE: ditto,
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { root, markerDirectory, snapshotParent, source, exitCode, stdout, stderr };
}

function resolverChildEnvironment(
  inheritedEnvironment: Record<string, string | undefined>,
  overrides: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const environment = { ...inheritedEnvironment, ...overrides };
  delete environment.BASH_ENV;
  delete environment.ENV;
  return environment;
}

async function resolveWith(options: {
  path: string;
  fallback: string;
  invoke?: boolean;
  defineFunction?: string;
  inheritedEnvironment?: Record<string, string | undefined>;
}) {
  const root = temporaryDirectory();
  const wrapper = join(root, "run.sh");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bash
set -euo pipefail
[ -z "\${BASH_ENV+x}" ]
[ -z "\${ENV+x}" ]
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
    env: resolverChildEnvironment(options.inheritedEnvironment ?? Bun.env, {
      PATH: options.path,
      RESOLVER: resolver,
      FALLBACK: options.fallback,
    }),
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

  test("uses the app fallback when PATH shadows Tailscale with a non-executable file", async () => {
    const root = temporaryDirectory();
    const pathCli = join(root, "bin", "tailscale");
    const fallback = join(root, "app", "Tailscale");
    mkdirSync(dirname(pathCli), { recursive: true });
    writeFileSync(pathCli, "not executable\n");
    chmodSync(pathCli, 0o644);
    writeExecutable(fallback);

    const result = await resolveWith({ path: dirname(pathCli), fallback });
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

  test.each(["BASH_ENV", "ENV"] as const)(
    "scrubs inherited %s before starting the fixture shell",
    async (startupVariable) => {
      const root = temporaryDirectory();
      const marker = join(root, "startup-environment-ran");
      const injectedBin = join(root, "injected-bin");
      const fallback = join(root, "app", "Tailscale");
      const startupFile = join(root, "startup.sh");
      writeExecutable(join(injectedBin, "tailscale"));
      writeExecutable(fallback);
      writeFileSync(startupFile, `: > "$STARTUP_MARKER"\nexport PATH="$STARTUP_BIN"\n`);

      const result = await resolveWith({
        path: join(root, "fixture-bin"),
        fallback,
        inheritedEnvironment: {
          ...Bun.env,
          [startupVariable]: startupFile,
          STARTUP_MARKER: marker,
          STARTUP_BIN: injectedBin,
        },
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(`resolved=${fallback}`);
      expect(existsSync(marker)).toBeFalse();
    },
  );

  test("snapshots the complete authenticated official app and executes only the verified copy", async () => {
    const result = await trustedSnapshotWith({ replaceSourceBeforeStatus: true });
    expect(result.exitCode, result.stderr).toBe(0);
    const snapshotCli = join(
      result.snapshotParent,
      "tailscale-identity-snapshot",
      "Tailscale.app",
      "Contents",
      "MacOS",
      "Tailscale",
    );
    expect(result.stdout).toContain(`resolved=${snapshotCli}`);
    expect(result.stdout).toContain('"Online":true');
    expect(readFileSync(join(result.markerDirectory, "status-path.log"), "utf8").trim()).toBe(
      snapshotCli,
    );
    expect(result.stdout).not.toContain("attacker");
  });

  test.each([
    ["wrong team", { team: "ATTACKER1" }, "official TeamIdentifier"],
    [
      "wrong identifier",
      { identifier: "io.attacker.fake" },
      "official bundle identifier",
    ],
    ["post-copy signature swap", { mutateSnapshot: true }, "authenticated after copying"],
  ] as const)("rejects a %s", async (_label, options, expectedError) => {
    const result = await trustedSnapshotWith(options);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(expectedError);
    expect(existsSync(join(result.markerDirectory, "status-path.log"))).toBeFalse();
  });

  test("keeps all test app and tool overrides after the real Darwin branch", () => {
    const source = readFileSync(resolver, "utf8");
    const resolverFunction = source.indexOf("recordings_resolve_trusted_tailscale_app_cli() {");
    const darwinBranch = source.indexOf(
      'if [ "$real_host_kernel" = "Darwin" ]; then',
      resolverFunction,
    );
    const nonDarwinBranch = source.indexOf("else", darwinBranch);
    expect(darwinBranch).toBeGreaterThan(-1);
    expect(nonDarwinBranch).toBeGreaterThan(darwinBranch);
    for (const override of [
      "RECORDINGS_TEST_TRUSTED_TAILSCALE_APP",
      "RECORDINGS_TEST_TAILSCALE_CODESIGN_EXECUTABLE",
      "RECORDINGS_TEST_TAILSCALE_DITTO_EXECUTABLE",
    ]) {
      expect(source.indexOf(override, darwinBranch)).toBeGreaterThan(nonDarwinBranch);
    }
    const darwinSelection = source.slice(darwinBranch, nonDarwinBranch);
    expect(darwinSelection).toContain('/Applications/Tailscale.app');
    expect(darwinSelection).toContain('/usr/bin/codesign');
    expect(darwinSelection).toContain('/usr/bin/ditto');
    expect(darwinSelection).not.toContain("RECORDINGS_TEST_");
  });
});
