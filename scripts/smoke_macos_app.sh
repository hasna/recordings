#!/bin/bash
set -euo pipefail
umask 077

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <Recordings.app> <explicit absolute Bun executable path>" >&2
  exit 2
fi

HOST_UNAME_EXECUTABLE="/usr/bin/uname"
SYSTEM_DIRNAME_EXECUTABLE="/usr/bin/dirname"
SYSTEM_PWD_EXECUTABLE="/bin/pwd"
SANITIZED_PATH="/usr/bin:/bin:/usr/sbin:/sbin"

require_executable() {
  local label="$1"
  local executable="$2"
  case "$executable" in
    /*) ;;
    *)
      echo "$label must be configured as an absolute executable path." >&2
      exit 1
      ;;
  esac
  if [ ! -f "$executable" ] || [ ! -x "$executable" ]; then
    echo "$label is missing or is not an executable file: $executable" >&2
    exit 1
  fi
}

require_executable "HOST_UNAME_EXECUTABLE" "$HOST_UNAME_EXECUTABLE"
require_executable "SYSTEM_DIRNAME_EXECUTABLE" "$SYSTEM_DIRNAME_EXECUTABLE"
require_executable "SYSTEM_PWD_EXECUTABLE" "$SYSTEM_PWD_EXECUTABLE"
HOST_PLATFORM="$("$HOST_UNAME_EXECUTABLE" -s)"
readonly HOST_PLATFORM

if [ "$HOST_PLATFORM" != "Darwin" ] && [ "${RECORDINGS_TEST_SMOKE_ALLOW_NON_DARWIN:-0}" != "1" ]; then
  echo "Recordings.app runtime smoke is only supported on macOS." >&2
  exit 1
fi

select_executable() {
  local system_executable="$1"
  local test_override="${2:-}"
  if [ "$HOST_PLATFORM" = "Darwin" ] || [ -z "$test_override" ]; then
    printf '%s\n' "$system_executable"
  else
    printf '%s\n' "$test_override"
  fi
}

DIRNAME_EXECUTABLE="$(select_executable "$SYSTEM_DIRNAME_EXECUTABLE" "${RECORDINGS_TEST_SMOKE_DIRNAME_EXECUTABLE:-}")"
PWD_EXECUTABLE="$(select_executable "$SYSTEM_PWD_EXECUTABLE" "${RECORDINGS_TEST_SMOKE_PWD_EXECUTABLE:-}")"
BASENAME_EXECUTABLE="$(select_executable "/usr/bin/basename" "${RECORDINGS_TEST_SMOKE_BASENAME_EXECUTABLE:-}")"
ENV_EXECUTABLE="$(select_executable "/usr/bin/env" "${RECORDINGS_TEST_SMOKE_ENV_EXECUTABLE:-}")"
LSOF_EXECUTABLE="$(select_executable "/usr/sbin/lsof" "${RECORDINGS_TEST_SMOKE_LSOF_EXECUTABLE:-}")"
KILL_EXECUTABLE="$(select_executable "/bin/kill" "${RECORDINGS_TEST_SMOKE_KILL_EXECUTABLE:-}")"
MKTEMP_EXECUTABLE="$(select_executable "/usr/bin/mktemp" "${RECORDINGS_TEST_SMOKE_MKTEMP_EXECUTABLE:-}")"
MV_EXECUTABLE="$(select_executable "/bin/mv" "${RECORDINGS_TEST_SMOKE_MV_EXECUTABLE:-}")"
OPEN_EXECUTABLE="$(select_executable "/usr/bin/open" "${RECORDINGS_TEST_SMOKE_OPEN_EXECUTABLE:-}")"
PS_EXECUTABLE="$(select_executable "/bin/ps" "${RECORDINGS_TEST_SMOKE_PS_EXECUTABLE:-}")"
RM_EXECUTABLE="$(select_executable "/bin/rm" "${RECORDINGS_TEST_SMOKE_RM_EXECUTABLE:-}")"
SED_EXECUTABLE="$(select_executable "/usr/bin/sed" "${RECORDINGS_TEST_SMOKE_SED_EXECUTABLE:-}")"
SLEEP_EXECUTABLE="$(select_executable "/bin/sleep" "${RECORDINGS_TEST_SMOKE_SLEEP_EXECUTABLE:-}")"
TR_EXECUTABLE="$(select_executable "/usr/bin/tr" "${RECORDINGS_TEST_SMOKE_TR_EXECUTABLE:-}")"

for executable_spec in \
  "DIRNAME_EXECUTABLE:$DIRNAME_EXECUTABLE" \
  "PWD_EXECUTABLE:$PWD_EXECUTABLE" \
  "BASENAME_EXECUTABLE:$BASENAME_EXECUTABLE" \
  "ENV_EXECUTABLE:$ENV_EXECUTABLE" \
  "LSOF_EXECUTABLE:$LSOF_EXECUTABLE" \
  "KILL_EXECUTABLE:$KILL_EXECUTABLE" \
  "MKTEMP_EXECUTABLE:$MKTEMP_EXECUTABLE" \
  "MV_EXECUTABLE:$MV_EXECUTABLE" \
  "OPEN_EXECUTABLE:$OPEN_EXECUTABLE" \
  "PS_EXECUTABLE:$PS_EXECUTABLE" \
  "RM_EXECUTABLE:$RM_EXECUTABLE" \
  "SED_EXECUTABLE:$SED_EXECUTABLE" \
  "SLEEP_EXECUTABLE:$SLEEP_EXECUTABLE" \
  "TR_EXECUTABLE:$TR_EXECUTABLE"; do
  require_executable "${executable_spec%%:*}" "${executable_spec#*:}"
done

BUN_EXECUTABLE="$2"
require_bun_executable() {
  local executable="$1"
  require_executable "BUN_EXECUTABLE" "$executable"
  if ! "$ENV_EXECUTABLE" -i \
    HOME="/tmp" \
    PATH="$SANITIZED_PATH" \
    "$executable" -e '
      import { realpathSync, statSync } from "node:fs";
      const expected = process.argv[1];
      const actual = process.execPath;
      if (!expected || realpathSync(actual) !== realpathSync(expected)) process.exit(66);
      if (!statSync(actual).isFile()) process.exit(66);
      if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(Bun.version)) process.exit(66);
    ' "$executable"; then
    echo "BUN_EXECUTABLE did not identify the Bun executable that actually ran." >&2
    exit 1
  fi
}
require_bun_executable "$BUN_EXECUTABLE"

HOME_DIRECTORY="${HOME:-}"
case "$HOME_DIRECTORY" in
  /*) ;;
  *)
    echo "Recordings.app runtime smoke requires an absolute HOME path." >&2
    exit 1
    ;;
esac
if [ ! -d "$HOME_DIRECTORY" ]; then
  echo "Recordings.app runtime smoke HOME is not a directory: $HOME_DIRECTORY" >&2
  exit 1
fi

APP_PARENT="$(cd -P "$("$DIRNAME_EXECUTABLE" "$1")" && "$PWD_EXECUTABLE" -P)"
APP_PATH="$APP_PARENT/$("$BASENAME_EXECUTABLE" "$1")"
EXECUTABLE="$APP_PATH/Contents/MacOS/Recordings"
if [ ! -x "$EXECUTABLE" ]; then
  echo "Recordings.app runtime smoke executable is missing: $EXECUTABLE" >&2
  exit 1
fi

WORK_DIR="$($MKTEMP_EXECUTABLE -d /tmp/recordings-runtime-smoke.XXXXXX)"
SMOKE_MAX_ATTEMPTS=100
SMOKE_COMPLETION_ATTEMPTS=200
SMOKE_CLEANUP_ATTEMPTS=20
SMOKE_CLEANUP_BIND_ATTEMPTS=3
SMOKE_FOCUS_EVIDENCE="strict"
if [ -n "${SSH_CONNECTION:-}" ]; then
  SMOKE_FOCUS_EVIDENCE="ssh-unavailable"
fi
SMOKE_PID=""
SMOKE_PID_START_IDENTITY=""
SMOKE_APP_PID=""
SMOKE_APP_PID_START_IDENTITY=""
SMOKE_APP_IDENTITIES_BEFORE_LAUNCH=""
SMOKE_ACK_PATH=""

process_start_identity() {
  local pid="$1"
  "$PS_EXECUTABLE" -o lstart= -p "$pid" 2>/dev/null | "$TR_EXECUTABLE" -d '\n'
}

process_has_exact_executable() {
  local pid="$1"
  local expected_executable="$2"
  local observed_executable
  while IFS= read -r observed_executable; do
    [ "$observed_executable" = "$expected_executable" ] && return 0
  done < <(
    "$LSOF_EXECUTABLE" -a -p "$pid" -d txt -Fn 2>/dev/null |
      "$SED_EXECUTABLE" -n 's/^n//p'
  )
  return 1
}

capture_process_start_identity() {
  local pid="$1"
  local expected_executable="$2"
  local start_before
  local start_after
  kill -0 "$pid" 2>/dev/null || return 1
  start_before="$(process_start_identity "$pid")"
  [ -n "$start_before" ] || return 1
  process_has_exact_executable "$pid" "$expected_executable" || return 1
  start_after="$(process_start_identity "$pid")"
  [ -n "$start_after" ] && [ "$start_before" = "$start_after" ] || return 1
  printf '%s\n' "$start_before"
}

process_records_for_exact_executable() {
  local expected_executable="$1"
  local required_argument="${2:-}"
  local process_listing
  local pid
  local command
  local start_identity
  if ! process_listing="$("$PS_EXECUTABLE" -axo pid=,command= -ww 2>/dev/null)"; then
    return 1
  fi
  while read -r pid command; do
    [[ "${pid:-}" =~ ^[1-9][0-9]*$ ]] || continue
    case "$command" in
      "$expected_executable"|"$expected_executable "*)
        if [ -n "$required_argument" ]; then
          case " $command " in
            *" $required_argument "*) ;;
            *) continue ;;
          esac
        fi
        if start_identity="$(capture_process_start_identity "$pid" "$expected_executable")"; then
          printf '%s\t%s\n' "$pid" "$start_identity"
        fi
        ;;
    esac
  done <<< "$process_listing"
}

process_identity_existed_before_launch() {
  local candidate_pid="$1"
  local candidate_start_identity="$2"
  local pid
  local start_identity
  while IFS=$'\t' read -r pid start_identity; do
    if [ "$pid" = "$candidate_pid" ] && [ "$start_identity" = "$candidate_start_identity" ]; then
      return 0
    fi
  done <<< "$SMOKE_APP_IDENTITIES_BEFORE_LAUNCH"
  return 1
}

bind_new_exact_app_process() {
  local current_records
  local pid
  local start_identity
  local candidate_pid=""
  local candidate_start_identity=""
  local candidate_count=0
  [ -z "$SMOKE_APP_PID" ] || return 0
  current_records="$(
    process_records_for_exact_executable "$EXECUTABLE" "$SMOKE_ACK_PATH"
  )" || return 1
  while IFS=$'\t' read -r pid start_identity; do
    [ -n "$pid" ] || continue
    process_identity_existed_before_launch "$pid" "$start_identity" && continue
    candidate_pid="$pid"
    candidate_start_identity="$start_identity"
    candidate_count=$((candidate_count + 1))
  done <<< "$current_records"
  [ "$candidate_count" -eq 1 ] || return 1
  SMOKE_APP_PID="$candidate_pid"
  SMOKE_APP_PID_START_IDENTITY="$candidate_start_identity"
}

write_atomic_text_file() {
  local destination="$1"
  local contents="$2"
  local temporary="${destination}.tmp.$$"
  printf '%s\n' "$contents" > "$temporary"
  "$MV_EXECUTABLE" -f "$temporary" "$destination"
}

wait_for_process_exit() {
  local pid="$1"
  local attempts="$2"
  local attempt
  for ((attempt = 0; attempt < attempts; attempt++)); do
    kill -0 "$pid" 2>/dev/null || return 0
    "$SLEEP_EXECUTABLE" 0.1
  done
  ! kill -0 "$pid" 2>/dev/null
}

terminate_verified_process() {
  local label="$1"
  local pid="$2"
  local expected_executable="$3"
  local expected_start_identity="$4"
  local rechecked_start_identity

  kill -0 "$pid" 2>/dev/null || return 0
  if ! rechecked_start_identity="$(capture_process_start_identity "$pid" "$expected_executable")" ||
    [ "$rechecked_start_identity" != "$expected_start_identity" ]; then
    echo "Refusing to signal ${label}: its process identity changed." >&2
    return 1
  fi

  "$KILL_EXECUTABLE" -TERM "$pid" 2>/dev/null || true
  wait_for_process_exit "$pid" "$SMOKE_CLEANUP_ATTEMPTS" && return 0

  if ! rechecked_start_identity="$(capture_process_start_identity "$pid" "$expected_executable")" ||
    [ "$rechecked_start_identity" != "$expected_start_identity" ]; then
    echo "Refusing to force-terminate ${label}: its process identity changed." >&2
    return 1
  fi
  "$KILL_EXECUTABLE" -KILL "$pid" 2>/dev/null || true
  if ! wait_for_process_exit "$pid" "$SMOKE_CLEANUP_ATTEMPTS"; then
    echo "Could not reap verified ${label} process ${pid}." >&2
    return 1
  fi
}

cleanup() {
  local exit_status=$?
  local binding_attempt
  trap - EXIT
  if [ -n "$SMOKE_ACK_PATH" ] && [ ! -e "$SMOKE_ACK_PATH" ]; then
    write_atomic_text_file "$SMOKE_ACK_PATH" "cleanup-$$" 2>/dev/null || true
  fi
  if [ -n "$SMOKE_PID" ]; then
    wait_for_process_exit "$SMOKE_PID" "$SMOKE_CLEANUP_ATTEMPTS" || true
    if [ -z "$SMOKE_APP_PID" ]; then
      for ((binding_attempt = 0; binding_attempt < SMOKE_CLEANUP_BIND_ATTEMPTS; binding_attempt++)); do
        bind_new_exact_app_process && break
        "$SLEEP_EXECUTABLE" 0.1
      done
    fi
    if [ -n "$SMOKE_APP_PID" ] && [ -n "$SMOKE_APP_PID_START_IDENTITY" ]; then
      terminate_verified_process \
        "Recordings.app" \
        "$SMOKE_APP_PID" \
        "$EXECUTABLE" \
        "$SMOKE_APP_PID_START_IDENTITY" || true
    fi
    if ! wait_for_process_exit "$SMOKE_PID" "$SMOKE_CLEANUP_ATTEMPTS" &&
      [ -n "$SMOKE_PID_START_IDENTITY" ]; then
      terminate_verified_process \
        "open -W wrapper" \
        "$SMOKE_PID" \
        "$OPEN_EXECUTABLE" \
        "$SMOKE_PID_START_IDENTITY" || true
    fi
  fi
  if [ -n "$SMOKE_PID" ] && ! kill -0 "$SMOKE_PID" 2>/dev/null; then
    wait "$SMOKE_PID" 2>/dev/null || true
  fi
  "$RM_EXECUTABLE" -rf "$WORK_DIR"
  return "$exit_status"
}
trap cleanup EXIT

run_smoke() {
  local mode="$1"
  local output="$WORK_DIR/${mode}.json"
  local acknowledgement="$WORK_DIR/${mode}.ack"
  local completion="$WORK_DIR/${mode}.completion.json"
  local log="$WORK_DIR/${mode}.log"
  local attempt
  local challenge
  local completion_attempt
  local rechecked_start_identity
  local result_pid
  local result_pid_start_identity
  local wrapper_status
  local -a arguments=(
    --runtime-smoke "$mode"
    --runtime-smoke-output "$output"
    --runtime-smoke-ack "$acknowledgement"
    --runtime-smoke-completion "$completion"
  )
  if [ "$mode" = "permission-helper" ]; then
    arguments=(--request-permissions "${arguments[@]}")
  fi

  SMOKE_PID=""
  SMOKE_PID_START_IDENTITY=""
  SMOKE_APP_PID=""
  SMOKE_APP_PID_START_IDENTITY=""
  SMOKE_APP_IDENTITIES_BEFORE_LAUNCH=""
  SMOKE_ACK_PATH="$acknowledgement"
  if ! SMOKE_APP_IDENTITIES_BEFORE_LAUNCH="$(
    process_records_for_exact_executable "$EXECUTABLE"
  )"; then
    echo "Recordings.app runtime smoke ${mode} could not inventory exact app processes before launch." >&2
    return 1
  fi

  "$ENV_EXECUTABLE" -i \
    HOME="$HOME_DIRECTORY" \
    PATH="$SANITIZED_PATH" \
    TMPDIR="$WORK_DIR" \
    "$OPEN_EXECUTABLE" -n -W "$APP_PATH" --args "${arguments[@]}" >"$log" 2>&1 &
  SMOKE_PID=$!
  SMOKE_PID_START_IDENTITY="$(
    capture_process_start_identity "$SMOKE_PID" "$OPEN_EXECUTABLE"
  )" || SMOKE_PID_START_IDENTITY=""

  for ((attempt = 0; attempt < SMOKE_MAX_ATTEMPTS; attempt++)); do
    if [ -z "$SMOKE_APP_PID" ]; then
      bind_new_exact_app_process || true
    fi
    if [ -f "$output" ]; then
      result_pid="$("$ENV_EXECUTABLE" -i HOME="$HOME_DIRECTORY" PATH="$SANITIZED_PATH" TMPDIR="$WORK_DIR" \
        "$BUN_EXECUTABLE" -e 'const value = await Bun.file(process.argv[1]).json(); console.log(value.processIdentifier)' "$output")"
      if ! [[ "$result_pid" =~ ^[1-9][0-9]*$ ]] || ! kill -0 "$result_pid" 2>/dev/null; then
        echo "Recordings.app runtime smoke ${mode} reported a process that is not running." >&2
        return 1
      fi
      if ! result_pid_start_identity="$(
        capture_process_start_identity "$result_pid" "$EXECUTABLE"
      )"; then
        echo "Recordings.app runtime smoke ${mode} reported a process outside the exact app path." >&2
        return 1
      fi
      if process_identity_existed_before_launch "$result_pid" "$result_pid_start_identity"; then
        echo "Recordings.app runtime smoke ${mode} reported an app process that predated this launch." >&2
        return 1
      fi
      if [ -n "$SMOKE_APP_PID" ] && {
        [ "$result_pid" != "$SMOKE_APP_PID" ] ||
          [ "$result_pid_start_identity" != "$SMOKE_APP_PID_START_IDENTITY" ];
      }; then
        echo "Recordings.app runtime smoke ${mode} evidence did not match the exact launched app process." >&2
        return 1
      fi
      SMOKE_APP_PID="$result_pid"
      SMOKE_APP_PID_START_IDENTITY="$result_pid_start_identity"
      if [ -z "$SMOKE_PID_START_IDENTITY" ]; then
        SMOKE_PID_START_IDENTITY="$(
          capture_process_start_identity "$SMOKE_PID" "$OPEN_EXECUTABLE"
        )" || SMOKE_PID_START_IDENTITY=""
      fi
      break
    fi
    if ! kill -0 "$SMOKE_PID" 2>/dev/null; then
      echo "Recordings.app runtime smoke ${mode} exited without evidence." >&2
      "$SED_EXECUTABLE" -n '1,120p' "$log" >&2
      return 1
    fi
    "$SLEEP_EXECUTABLE" 0.1
  done
  if [ ! -f "$output" ]; then
    echo "Recordings.app runtime smoke ${mode} timed out." >&2
    "$SED_EXECUTABLE" -n '1,120p' "$log" >&2
    return 1
  fi
  if [ -z "$SMOKE_APP_PID" ]; then
    echo "Recordings.app runtime smoke ${mode} did not bind evidence to the exact app process." >&2
    return 1
  fi

  "$ENV_EXECUTABLE" -i \
    HOME="$HOME_DIRECTORY" \
    PATH="$SANITIZED_PATH" \
    TMPDIR="$WORK_DIR" \
    SMOKE_MODE="$mode" \
    SMOKE_FOCUS_EVIDENCE="$SMOKE_FOCUS_EVIDENCE" \
    EXPECTED_HELPER="$APP_PATH/Contents/Helpers/recordings" \
    "$BUN_EXECUTABLE" -e '
    const path = process.argv[1];
    const mode = process.env.SMOKE_MODE;
    const result = await Bun.file(path).json();
    const fail = (message) => { throw new Error(`${mode}: ${message}`); };
    let focusEvidenceStatus = "available";
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
        if (process.env.SMOKE_FOCUS_EVIDENCE !== "ssh-unavailable") {
          fail("Open Recordings did not make the retained window active and key");
        }
        focusEvidenceStatus = "ssh-unavailable";
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
    console.log(JSON.stringify({
      event: "recordings_runtime_smoke_evidence",
      mode,
      focusEvidenceStatus: mode === "normal" ? focusEvidenceStatus : "not-applicable",
      applicationIsActive: result.applicationIsActive,
      mainWindowIsKey: result.mainWindowIsKey,
    }));
  ' "$output"

  if [ -e "$completion" ]; then
    echo "Recordings.app runtime smoke ${mode} produced completion before the challenge." >&2
    return 1
  fi
  challenge="$("$ENV_EXECUTABLE" -i HOME="$HOME_DIRECTORY" PATH="$SANITIZED_PATH" TMPDIR="$WORK_DIR" \
    "$BUN_EXECUTABLE" -e 'console.log(crypto.randomUUID())')"
  if ! rechecked_start_identity="$(
    capture_process_start_identity "$result_pid" "$EXECUTABLE"
  )" || [ "$rechecked_start_identity" != "$result_pid_start_identity" ]; then
    echo "Recordings.app runtime smoke ${mode} process identity changed before completion challenge." >&2
    return 1
  fi
  write_atomic_text_file "$acknowledgement" "$challenge"

  for ((completion_attempt = 0; completion_attempt < SMOKE_COMPLETION_ATTEMPTS; completion_attempt++)); do
    kill -0 "$SMOKE_PID" 2>/dev/null || break
    "$SLEEP_EXECUTABLE" 0.1
  done
  if kill -0 "$SMOKE_PID" 2>/dev/null; then
    echo "Recordings.app runtime smoke ${mode} completion handshake timed out." >&2
    return 1
  fi
  if wait "$SMOKE_PID" 2>/dev/null; then
    wrapper_status=0
  else
    wrapper_status=$?
  fi
  SMOKE_PID=""
  SMOKE_PID_START_IDENTITY=""
  SMOKE_APP_PID=""
  SMOKE_APP_PID_START_IDENTITY=""
  if [ "$wrapper_status" -ne 0 ]; then
    echo "Recordings.app runtime smoke ${mode} open -W wrapper exited unsuccessfully (${wrapper_status})." >&2
    "$SED_EXECUTABLE" -n '1,120p' "$log" >&2
    return 1
  fi

  if ! "$ENV_EXECUTABLE" -i \
    HOME="$HOME_DIRECTORY" \
    PATH="$SANITIZED_PATH" \
    TMPDIR="$WORK_DIR" \
    SMOKE_CHALLENGE="$challenge" \
    SMOKE_MODE="$mode" \
    SMOKE_PROCESS_IDENTIFIER="$result_pid" \
    "$BUN_EXECUTABLE" -e '
      try {
        const response = await Bun.file(process.argv[1]).json();
        if (response.challenge !== process.env.SMOKE_CHALLENGE) throw new Error("challenge mismatch");
        if (response.mode !== process.env.SMOKE_MODE) throw new Error("mode mismatch");
        if (response.processIdentifier !== Number(process.env.SMOKE_PROCESS_IDENTIFIER)) {
          throw new Error("process identifier mismatch");
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    ' "$completion"; then
    echo "Recordings.app runtime smoke ${mode} did not provide a valid completion response." >&2
    return 1
  fi

  SMOKE_ACK_PATH=""
}

run_smoke normal
run_smoke permission-helper
run_smoke resolver
echo "Recordings.app runtime smoke passed: menu bar, retained window, helper isolation, and packaged resolver."
