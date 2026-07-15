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
cleanup() {
  if [ -n "$SMOKE_PID" ] && kill -0 "$SMOKE_PID" 2>/dev/null; then
    kill -TERM "$SMOKE_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

run_smoke() {
  local mode="$1"
  local output="$WORK_DIR/${mode}.json"
  local log="$WORK_DIR/${mode}.log"
  local attempt
  local -a arguments=(--runtime-smoke "$mode" --runtime-smoke-output "$output")
  if [ "$mode" = "permission-helper" ]; then
    arguments=(--request-permissions "${arguments[@]}")
  fi

  "$EXECUTABLE" "${arguments[@]}" >"$log" 2>&1 &
  SMOKE_PID=$!

  for ((attempt = 0; attempt < 100; attempt++)); do
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

  SMOKE_MODE="$mode" bun -e '
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
      if (result.applicationIsActive && !result.mainWindowIsKey) {
        fail("active application did not make the retained main window key");
      }
    } else {
      if (result.menuBarSurfaceCount !== 0) fail("permission/helper smoke inserted a menu-bar surface");
      if (result.accessibilityMenuBarItemCount !== 0) {
        fail(`permission/helper smoke exposed ${result.accessibilityMenuBarItemCount} menu-bar items`);
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
echo "Recordings.app runtime smoke passed: menu bar, status states, retained window, helper isolation."
