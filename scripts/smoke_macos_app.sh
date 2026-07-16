#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Recordings.app runtime smoke is only supported on macOS." >&2
  exit 1
fi
if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <Recordings.app>" >&2
  exit 2
fi

APP_PATH="$1"
EXECUTABLE="$APP_PATH/Contents/MacOS/Recordings"
if [ ! -x "$EXECUTABLE" ]; then
  echo "Recordings.app runtime smoke executable is missing: $EXECUTABLE" >&2
  exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is required to validate Recordings.app runtime smoke evidence." >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
SMOKE_PID=""
SMOKE_APP_PID=""
cleanup() {
  if [ -n "$SMOKE_APP_PID" ] && kill -0 "$SMOKE_APP_PID" 2>/dev/null; then
    kill -TERM "$SMOKE_APP_PID" 2>/dev/null || true
  fi
  if [ -n "$SMOKE_PID" ] && kill -0 "$SMOKE_PID" 2>/dev/null; then
    kill -TERM "$SMOKE_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

find_smoke_app_pid() {
  local output="$1"
  ps -axo pid=,command= | awk -v executable="$EXECUTABLE" -v output="$output" '
    index($0, executable) && index($0, output) { print $1; exit }
  '
}

run_smoke() {
  local mode="$1"
  local output="$WORK_DIR/${mode}.json"
  local log="$WORK_DIR/${mode}.log"
  local attempt
  local result_pid
  local -a arguments=(--runtime-smoke "$mode" --runtime-smoke-output "$output")
  if [ "$mode" = "permission-helper" ]; then
    arguments=(--request-permissions "${arguments[@]}")
  fi

  open -n -g -W "$APP_PATH" --args "${arguments[@]}" >"$log" 2>&1 &
  SMOKE_PID=$!

  for ((attempt = 0; attempt < 100; attempt++)); do
    if [ -z "$SMOKE_APP_PID" ]; then
      SMOKE_APP_PID="$(find_smoke_app_pid "$output")"
    fi
    [ -f "$output" ] && break
    if ! kill -0 "$SMOKE_PID" 2>/dev/null; then
      wait "$SMOKE_PID" || true
      echo "Recordings.app runtime smoke ${mode} exited without evidence." >&2
      sed -n '1,120p' "$log" >&2
      return 1
    fi
    sleep 0.1
  done
  if [ ! -f "$output" ]; then
    echo "Recordings.app runtime smoke ${mode} timed out." >&2
    sed -n '1,120p' "$log" >&2
    return 1
  fi
  wait "$SMOKE_PID"
  SMOKE_PID=""
  result_pid="$(bun -e 'const value = await Bun.file(process.argv[1]).json(); console.log(value.processIdentifier)' "$output")"
  if [ -n "$SMOKE_APP_PID" ] && [ "$SMOKE_APP_PID" != "$result_pid" ]; then
    echo "Recordings.app runtime smoke ${mode} observed a mismatched app process." >&2
    return 1
  fi
  SMOKE_APP_PID=""

  SMOKE_MODE="$mode" EXPECTED_HELPER="$APP_PATH/Contents/Helpers/recordings" bun -e '
    const path = process.argv[1];
    const mode = process.env.SMOKE_MODE;
    const result = await Bun.file(path).json();
    const fail = (message) => { throw new Error(`${mode}: ${message}`); };
    if (result.mode !== mode) fail("mode mismatch");
    if (result.globalHandlersInstalled !== false) fail("global handlers were installed");
    if (result.permissionRequestsStarted !== 0) fail("permission request path ran");
    if (mode === "normal") {
      if (result.menuBarSurfaceCount !== 1) fail("expected exactly one menu-bar surface");
      if (result.accessibilityMenuBarItemCount !== 1) {
        fail(`expected one accessible menu-bar item, got ${result.accessibilityMenuBarItemCount}`);
      }
      if (result.accessibilityObservationStatus !== "available") {
        fail(`normal menu-bar AX observation was ${result.accessibilityObservationStatus}`);
      }
      if (!result.accessibilityMenuBarLabels.some((label) => label.includes("transcribing"))) {
        fail(`accessible menu-bar label did not render transcribing state: ${JSON.stringify(result.accessibilityMenuBarLabels)}`);
      }
      const expected = ["Recordings", "Recordings, recording", "Recordings, transcribing"];
      if (JSON.stringify(result.renderedStatusLabels) !== JSON.stringify(expected)) {
        fail(`unexpected status labels ${JSON.stringify(result.renderedStatusLabels)}`);
      }
      if (result.windowCreationCount !== 1 || result.windowActivationCount !== 2) {
        fail("retained-window activation path was not exercised twice");
      }
      if (result.retainedWindowReused !== true) fail("main window was not retained");
      if (result.applicationActivationPolicy !== 0) fail("main window did not set regular activation policy");
      if (!result.mainWindowIsVisible || !result.mainWindowCanBecomeKey) {
        fail("retained main window was not visible and capable of becoming key");
      }
      if (!result.applicationIsActive || !result.mainWindowIsKey) {
        fail("Open Recordings did not make the retained window active and key");
      }
    } else if (mode === "resolver") {
      if (result.menuBarSurfaceCount !== 0 || result.globalHandlersInstalled !== false) {
        fail("resolver smoke installed UI surfaces or global handlers");
      }
      if (result.resolvedCompanionPath !== process.env.EXPECTED_HELPER) {
        fail(`resolver selected ${JSON.stringify(result.resolvedCompanionPath)}`);
      }
      if (result.companionCapabilitiesPassed !== true) {
        fail("packaged helper capability contract failed");
      }
    } else {
      if (result.menuBarSurfaceCount !== 0) fail("permission/helper smoke inserted a menu-bar surface");
      if (result.accessibilityObservationStatus !== "absent") {
        fail(`permission/helper AX observation was ${result.accessibilityObservationStatus}`);
      }
      if (result.accessibilityMenuBarItemCount !== 0 || result.accessibilityMenuBarLabels.length !== 0) {
        fail("permission/helper smoke exposed an accessible menu-bar surface");
      }
      if (result.renderedStatusLabels.length !== 0) fail("permission/helper smoke rendered a status label");
      if (result.windowCreationCount !== 0 || result.windowActivationCount !== 0) {
        fail("permission/helper smoke created or activated a window");
      }
      if (result.mainWindowIsVisible || result.mainWindowIsKey) {
        fail("permission/helper smoke exposed a main window");
      }
    }
  ' "$output"
}

run_smoke normal
run_smoke permission-helper
run_smoke resolver
echo "Recordings.app runtime smoke passed: menu bar, retained window, helper isolation, and packaged resolver."
