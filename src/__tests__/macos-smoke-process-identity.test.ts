import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
const bunExecutable = process.execPath;
const temporaryPaths: string[] = [];
const fixturePidFiles: string[][] = [];

setDefaultTimeout(15_000);

afterEach(() => {
  for (const pidFiles of fixturePidFiles.splice(0)) {
    for (const pidFile of pidFiles) {
      if (!existsSync(pidFile)) continue;
      const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function processIsRunning(pidFile: string): boolean {
  const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeExecutable(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function normalEvidence(pid: number): string {
  return JSON.stringify({
    mode: "normal",
    processIdentifier: pid,
    menuBarSurfaceCount: 1,
    renderedStatusLabels: ["Recordings", "Recordings, recording", "Recordings, transcribing"],
    accessibilityObservationStatus: "available",
    accessibilityMenuBarItemCount: 1,
    accessibilityMenuBarLabels: ["Recordings, transcribing"],
    globalHandlersInstalled: false,
    permissionRequestsStarted: 0,
    windowCreationCount: 1,
    windowActivationCount: 2,
    retainedWindowReused: true,
    applicationActivationPolicy: 0,
    applicationIsActive: false,
    mainWindowIsVisible: true,
    mainWindowCanBecomeKey: true,
    mainWindowIsKey: false,
    resolvedCompanionPath: null,
    companionCapabilitiesPassed: false,
  });
}

function createSmokeFixture(
  options: {
    completionBehavior?:
      | "correct"
      | "ignore"
      | "ignore-term"
      | "wrong-challenge"
      | "wrong-mode"
      | "wrong-pid";
    invalidEvidence?: boolean;
    missingEvidence?: boolean;
    malformedPidEvidence?: boolean;
    preexistingExactApp?: boolean;
    stayAliveUntilSignaled?: boolean;
    wrapperExitsBeforeAppCompletion?: boolean;
    appIdentityChangesAfterCalls?: number;
    wrapperExitCode?: number;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "recordings-smoke-identity-"));
  temporaryPaths.push(root);
  const bin = join(root, "bin");
  const app = join(root, "Recordings.app");
  const executable = join(app, "Contents", "MacOS", "Recordings");
  const appAcknowledgementPath = join(root, "app-acknowledgement.path");
  const preexistingAppPid = join(root, "preexisting-app.pid");
  const smokeScript = join(root, "smoke_macos_app.sh");
  const openExecutable = join(bin, "open");
  const killExecutable = join(bin, "kill");
  const killLog = join(root, "kill.log");
  const appPid = join(root, "app.pid");
  const appExitMarker = join(root, "app.exited");
  const completionWriterPid = join(root, "completion-writer.pid");
  const psCalls = join(root, "app-ps-calls");
  const signalMarker = join(root, "app.signal");
  const wrapperExitMarker = join(root, "wrapper.exited");
  const wrapperPid = join(root, "wrapper.pid");
  const workdirMode = join(root, "workdir.mode");
  fixturePidFiles.push([appPid, preexistingAppPid, wrapperPid]);
  mkdirSync(dirname(executable), { recursive: true });
  cpSync(join(repositoryRoot, "scripts", "smoke_macos_app.sh"), smokeScript);
  let smokeSource = readFileSync(smokeScript, "utf8");
  expect(smokeSource).toContain("terminate_verified_process()");
  expect(smokeSource).toContain('"$KILL_EXECUTABLE" -TERM "$pid"');
  expect(smokeSource).toContain('"$KILL_EXECUTABLE" -KILL "$pid"');
  expect(smokeSource).toContain("run_smoke normal\nrun_smoke permission-helper\nrun_smoke resolver");
  smokeSource = smokeSource
    .replace("SMOKE_MAX_ATTEMPTS=100", "SMOKE_MAX_ATTEMPTS=3")
    .replace("SMOKE_COMPLETION_ATTEMPTS=200", "SMOKE_COMPLETION_ATTEMPTS=3")
    .replace("SMOKE_CLEANUP_ATTEMPTS=20", "SMOKE_CLEANUP_ATTEMPTS=3")
    .replace(
      "run_smoke normal\nrun_smoke permission-helper\nrun_smoke resolver",
      "run_smoke normal",
    );
  writeFileSync(smokeScript, smokeSource);
  chmodSync(smokeScript, 0o755);

  const evidence = options.malformedPidEvidence
    ? '{"mode":"normal","processIdentifier":"not-a-pid"}'
    : options.invalidEvidence
      ? '{"mode":"normal","processIdentifier":%s}'
      : normalEvidence(0).replace('"processIdentifier":0', '"processIdentifier":%s');
  const evidenceWrite = options.missingEvidence
    ? ":"
    : options.malformedPidEvidence
      ? `printf '${evidence}\\n' > "$output"`
      : `printf '${evidence}\\n' "$$" > "$output"`;
  const completionBehavior = options.completionBehavior ?? "correct";
  const termTrap = completionBehavior === "ignore-term"
    ? `trap 'printf TERM > "${signalMarker}"' TERM`
    : `trap 'printf TERM > "${signalMarker}"; exit 97' TERM`;
  const wrapperExitCode = options.wrapperExitCode ?? 0;
  writeExecutable(
    executable,
    `#!/bin/bash
set -euo pipefail
output=""
acknowledgement=""
completion=""
mode=""
trap 'printf exited > "${appExitMarker}"' EXIT
${termTrap}
while [ "$#" -gt 0 ]; do
  if [ "$1" = --runtime-smoke ]; then mode="$2"; shift 2; continue; fi
  if [ "$1" = --runtime-smoke-output ]; then output="$2"; shift 2; continue; fi
  if [ "$1" = --runtime-smoke-ack ]; then acknowledgement="$2"; shift 2; continue; fi
  if [ "$1" = --runtime-smoke-completion ]; then completion="$2"; shift 2; continue; fi
  shift
done
printf '%s\\n' "$acknowledgement" > "${appAcknowledgementPath}"
printf '%s\\n' "$$" > "${appPid}"
while [ ! -s "${appPid}" ]; do /bin/sleep 0.01; done
'${bunExecutable}' -e '
  import { statSync, writeFileSync } from "node:fs";
  writeFileSync(process.argv[2], (statSync(process.argv[1]).mode & 0o777).toString(8));
' "\${acknowledgement%/*}" "${workdirMode}"
${evidenceWrite}
if [ '${options.stayAliveUntilSignaled ? "yes" : "no"}' = yes ]; then
  while true; do /bin/sleep 0.01; done
elif [ '${completionBehavior}' != ignore ] && [ '${completionBehavior}' != ignore-term ]; then
  while [ ! -e "$acknowledgement" ]; do /bin/sleep 0.01; done
  IFS= read -r challenge < "$acknowledgement"
  completion_challenge="$challenge"
  completion_mode="$mode"
  completion_pid="$$"
  if [ '${completionBehavior}' = wrong-challenge ]; then completion_challenge="wrong-$challenge"; fi
  if [ '${completionBehavior}' = wrong-mode ]; then completion_mode="wrong-$mode"; fi
  if [ '${completionBehavior}' = wrong-pid ]; then completion_pid="$((completion_pid + 1))"; fi
  printf '%s\\n' "$$" > "${completionWriterPid}"
  printf '{"challenge":"%s","mode":"%s","processIdentifier":%s}\\n' \
    "$completion_challenge" "$completion_mode" "$completion_pid" > "$completion.tmp"
  /bin/mv "$completion.tmp" "$completion"
else
  wrapper_pid="$PPID"
  while kill -0 "$wrapper_pid" 2>/dev/null; do /bin/sleep 0.01; done
fi
`,
  );

  writeExecutable(
    openExecutable,
    `#!/bin/bash
set -euo pipefail
trap 'printf exited > "${wrapperExitMarker}"' EXIT
printf '%s\n' "$$" > "${wrapperPid}"
app=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = -W ]; then app="$2"; shift 2; continue; fi
  if [ "$1" = --args ]; then shift; break; fi
  shift
done
"$app/Contents/MacOS/Recordings" "$@" &
launched_pid="$!"
while [ ! -s "${appPid}" ]; do /bin/sleep 0.01; done
if [ "$(sed -n '1p' "${appPid}")" != "$launched_pid" ]; then
  exit 91
fi
if [ '${options.wrapperExitsBeforeAppCompletion ? "yes" : "no"}' = yes ]; then
  exit 29
fi
if wait "$launched_pid"; then app_status=0; else app_status=$?; fi
if [ '${wrapperExitCode}' -ne 0 ]; then exit '${wrapperExitCode}'; fi
exit "$app_status"
`,
  );

  writeExecutable(
    killExecutable,
    `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> '${killLog}'
exec /bin/kill "$@"
`,
  );

  writeExecutable(
    join(bin, "lsof"),
    `#!/bin/bash
set -euo pipefail
pid=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = -p ]; then pid="$2"; shift 2; else shift; fi
done
[ -n "$pid" ] || exit 1
printf 'p%s\\nn/unrelated/first-txt-record\\n' "$pid"
app_pid=""
if [ -s '${appPid}' ]; then IFS= read -r app_pid < '${appPid}'; fi
preexisting_app_pid=""
if [ -s '${preexistingAppPid}' ]; then IFS= read -r preexisting_app_pid < '${preexistingAppPid}'; fi
if [ "$pid" = "$app_pid" ] || [ "$pid" = "$preexisting_app_pid" ]; then
  printf 'n%s\\n' '${executable}'
else
  printf 'n%s\\n' '${openExecutable}'
fi
`,
  );

  const identityChangesAfterCalls = options.appIdentityChangesAfterCalls ?? 1_000_000;
  writeExecutable(
    join(bin, "ps"),
    `#!/bin/bash
set -euo pipefail
if [ "\${1:-}" = -axo ]; then
  if [ -s '${preexistingAppPid}' ]; then
    IFS= read -r preexisting_app_pid < '${preexistingAppPid}'
    printf ' %s %s --runtime-smoke existing\\n' "$preexisting_app_pid" '${executable}'
  fi
  if [ -s '${appPid}' ]; then
    IFS= read -r app_pid < '${appPid}'
    IFS= read -r app_acknowledgement < '${appAcknowledgementPath}'
    printf ' %s %s --runtime-smoke normal --runtime-smoke-ack %s\\n' \
      "$app_pid" '${executable}' "$app_acknowledgement"
  fi
  exit 0
fi
pid=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = -p ]; then pid="$2"; shift 2; else shift; fi
done
[ -n "$pid" ] || exit 1
app_pid=""
if [ -s '${appPid}' ]; then IFS= read -r app_pid < '${appPid}'; fi
preexisting_app_pid=""
if [ -s '${preexistingAppPid}' ]; then IFS= read -r preexisting_app_pid < '${preexistingAppPid}'; fi
if [ "$pid" = "$app_pid" ]; then
  calls=0
  if [ -f '${psCalls}' ]; then IFS= read -r calls < '${psCalls}'; fi
  calls=$((calls + 1))
  printf '%s\\n' "$calls" > '${psCalls}'
  if [ "$calls" -gt '${identityChangesAfterCalls}' ]; then
    printf 'Sat Jul 18 12:00:01 2026\\n'
  else
    printf 'Sat Jul 18 12:00:00 2026\\n'
  fi
elif [ "$pid" = "$preexisting_app_pid" ]; then
  printf 'Sat Jul 18 11:59:00 2026\\n'
else
  printf 'Sat Jul 18 12:00:02 2026\\n'
fi
`,
  );

  if (options.preexistingExactApp) {
    const process = Bun.spawn(["/bin/sleep", "60"], { stderr: "ignore", stdout: "ignore" });
    writeFileSync(preexistingAppPid, `${process.pid}\n`);
  }

  return {
    app,
    appExitMarker,
    appPid,
    completionWriterPid,
    lsofExecutable: join(bin, "lsof"),
    killExecutable,
    killLog,
    openExecutable,
    preexistingAppPid,
    psCalls,
    psExecutable: join(bin, "ps"),
    root,
    signalMarker,
    smokeScript,
    workdirMode,
    wrapperExitMarker,
    wrapperPid,
  };
}

async function runSmoke(fixture: ReturnType<typeof createSmokeFixture>) {
  const smoke = Bun.spawn(
    ["/bin/bash", fixture.smokeScript, fixture.app, bunExecutable],
    {
      env: {
        ...Bun.env,
        HOME: fixture.root,
        SSH_CONNECTION: "fixture-authenticated-ssh",
        RECORDINGS_TEST_SMOKE_ALLOW_NON_DARWIN: "1",
        RECORDINGS_TEST_SMOKE_LSOF_EXECUTABLE: fixture.lsofExecutable,
        RECORDINGS_TEST_SMOKE_KILL_EXECUTABLE: fixture.killExecutable,
        RECORDINGS_TEST_SMOKE_OPEN_EXECUTABLE: fixture.openExecutable,
        RECORDINGS_TEST_SMOKE_PS_EXECUTABLE: fixture.psExecutable,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    smoke.exited,
    new Response(smoke.stdout).text(),
    new Response(smoke.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

describe("macOS runtime smoke process identity", () => {
  test("uses challenge-bound completion with identity-verified failure cleanup", () => {
    const smokeSource = readFileSync(
      join(repositoryRoot, "scripts", "smoke_macos_app.sh"),
      "utf8",
    );
    const appSource = readFileSync(
      join(repositoryRoot, "src", "native", "Recordings", "App", "RecordingsApp.swift"),
      "utf8",
    );
    const launchPlanSource = readFileSync(
      join(
        repositoryRoot,
        "src",
        "native",
        "Recordings",
        "RecordingsLib",
        "PermissionRequestLaunchPlan.swift",
      ),
      "utf8",
    );

    expect(smokeSource).toContain('--runtime-smoke-ack "$acknowledgement"');
    expect(smokeSource).toContain('--runtime-smoke-completion "$completion"');
    expect(smokeSource).toContain("umask 077");
    expect(smokeSource).toContain("crypto.randomUUID()");
    const terminationHelper = smokeSource.slice(
      smokeSource.indexOf("terminate_verified_process()"),
      smokeSource.indexOf("cleanup()"),
    );
    expect(terminationHelper).toContain(
      'capture_process_start_identity "$pid" "$expected_executable"',
    );
    expect(terminationHelper).toContain(
      '[ "$rechecked_start_identity" != "$expected_start_identity" ]',
    );
    expect(terminationHelper).toContain('"$KILL_EXECUTABLE" -TERM "$pid"');
    expect(terminationHelper).toContain('"$KILL_EXECUTABLE" -KILL "$pid"');
    expect(appSource).toContain("runtimeSmokeAcknowledgementPath");
    expect(appSource).toContain("runtimeSmokeCompletionPath");
    expect(appSource).toContain("contentsOfFile: acknowledgementPath");
    const completionWriter = appSource.slice(
      appSource.indexOf("let response = RuntimeSmokeCompletionResponse("),
      appSource.indexOf("Darwin._exit(0)", appSource.indexOf("let response = RuntimeSmokeCompletionResponse(")),
    );
    expect(completionWriter).toContain("responseData.write(");
    expect(completionWriter).toContain("options: .atomic");
    expect(appSource).toContain("Darwin._exit(0)");
    expect(launchPlanSource).toContain('"--runtime-smoke-ack"');
    expect(launchPlanSource).toContain('"--runtime-smoke-completion"');
  });

  test("accepts the exact executable when it is not the first lsof txt record", async () => {
    const fixture = createSmokeFixture();
    const result = await runSmoke(fixture);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('"event":"recordings_runtime_smoke_evidence"');
    expect(readFileSync(fixture.completionWriterPid, "utf8")).toBe(
      readFileSync(fixture.appPid, "utf8"),
    );
    expect(readFileSync(fixture.workdirMode, "utf8")).toBe("700");
  });

  test("does not send PID-directed TERM during normal completion", async () => {
    const fixture = createSmokeFixture();
    const result = await runSmoke(fixture);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(existsSync(fixture.killLog) ? readFileSync(fixture.killLog, "utf8") : "").not.toContain(
      "-TERM ",
    );
  });

  test("does not send PID-directed KILL during cooperative completion", async () => {
    const fixture = createSmokeFixture();
    const result = await runSmoke(fixture);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(existsSync(fixture.killLog) ? readFileSync(fixture.killLog, "utf8") : "").not.toContain(
      "-KILL ",
    );
  });

  test("EXIT cleanup acknowledges the app without signaling its evidence PID", async () => {
    const fixture = createSmokeFixture({
      invalidEvidence: true,
    });
    const result = await runSmoke(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(fixture.signalMarker)).toBeFalse();
  });

  test("terminates the exact live app when PID evidence never appears and the wrapper exits", async () => {
    const fixture = createSmokeFixture({
      missingEvidence: true,
      stayAliveUntilSignaled: true,
      wrapperExitsBeforeAppCompletion: true,
    });
    const result = await runSmoke(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("exited without evidence");
    expect(existsSync(fixture.signalMarker)).toBeTrue();
    expect(existsSync(fixture.appExitMarker)).toBeTrue();
    expect(existsSync(fixture.wrapperExitMarker)).toBeTrue();
    expect(processIsRunning(fixture.appPid)).toBeFalse();
    expect(processIsRunning(fixture.wrapperPid)).toBeFalse();
  });

  test("terminates the exact live app when PID evidence is malformed", async () => {
    const fixture = createSmokeFixture({
      malformedPidEvidence: true,
      preexistingExactApp: true,
      stayAliveUntilSignaled: true,
    });
    const result = await runSmoke(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("reported a process that is not running");
    expect(existsSync(fixture.signalMarker)).toBeTrue();
    expect(existsSync(fixture.appExitMarker)).toBeTrue();
    expect(existsSync(fixture.wrapperExitMarker)).toBeTrue();
    expect(processIsRunning(fixture.appPid)).toBeFalse();
    expect(processIsRunning(fixture.preexistingAppPid)).toBeTrue();
    expect(processIsRunning(fixture.wrapperPid)).toBeFalse();
  });

  test("fails when the app ignores the completion challenge", async () => {
    const fixture = createSmokeFixture({ completionBehavior: "ignore" });
    const startedAt = Date.now();
    const result = await runSmoke(fixture);
    const elapsedMilliseconds = Date.now() - startedAt;
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("completion handshake timed out");
    expect(elapsedMilliseconds).toBeLessThan(5_000);
    expect(existsSync(fixture.completionWriterPid)).toBeFalse();
    expect(existsSync(fixture.signalMarker)).toBeTrue();
    expect(existsSync(fixture.appExitMarker)).toBeTrue();
    expect(existsSync(fixture.wrapperExitMarker)).toBeTrue();
    expect(processIsRunning(fixture.appPid)).toBeFalse();
    expect(processIsRunning(fixture.wrapperPid)).toBeFalse();
  });

  test("refuses to signal a timeout PID whose start identity changed", async () => {
    const fixture = createSmokeFixture({
      completionBehavior: "ignore",
      appIdentityChangesAfterCalls: 6,
    });
    const result = await runSmoke(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("completion handshake timed out");
    expect(result.stderr).toContain("Refusing to signal Recordings.app");
    expect(existsSync(fixture.signalMarker)).toBeFalse();
  });

  test("force-terminates the same verified app when it ignores TERM", async () => {
    const fixture = createSmokeFixture({ completionBehavior: "ignore-term" });
    const result = await runSmoke(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("completion handshake timed out");
    expect(existsSync(fixture.signalMarker)).toBeTrue();
    expect(existsSync(fixture.appExitMarker)).toBeFalse();
    expect(existsSync(fixture.wrapperExitMarker)).toBeTrue();
    expect(processIsRunning(fixture.appPid)).toBeFalse();
    expect(processIsRunning(fixture.wrapperPid)).toBeFalse();
  });

  test("fails when the app returns the wrong completion challenge", async () => {
    const fixture = createSmokeFixture({ completionBehavior: "wrong-challenge" });
    const result = await runSmoke(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("did not provide a valid completion response");
  });

  test("fails when the app returns the wrong completion mode", async () => {
    const fixture = createSmokeFixture({ completionBehavior: "wrong-mode" });
    const result = await runSmoke(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("did not provide a valid completion response");
  });

  test("fails when the app returns the wrong completion PID", async () => {
    const fixture = createSmokeFixture({ completionBehavior: "wrong-pid" });
    const result = await runSmoke(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("did not provide a valid completion response");
  });

  test("fails when the open wrapper exits nonzero after app completion", async () => {
    const fixture = createSmokeFixture({ wrapperExitCode: 23 });
    const result = await runSmoke(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("open -W wrapper exited unsuccessfully");
  });

  test("rechecks the evidence process identity immediately before issuing the challenge", async () => {
    const fixture = createSmokeFixture({ appIdentityChangesAfterCalls: 4 });
    const result = await runSmoke(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("process identity changed before completion challenge");
    expect(existsSync(fixture.signalMarker)).toBeFalse();
  });
});
