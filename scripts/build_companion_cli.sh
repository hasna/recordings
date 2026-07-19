#!/bin/bash
set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "Usage: $0 <output-path> <explicit absolute Bun executable path> [native|universal]" >&2
  exit 2
fi

BUILD_KIND="${3:-native}"
case "$BUILD_KIND" in
  native|universal) ;;
  *)
    echo "Companion CLI build kind must be native or universal." >&2
    exit 2
    ;;
esac

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

select_executable() {
  local system_executable="$1"
  local test_override="${2:-}"
  if [ "$HOST_PLATFORM" = "Darwin" ] || [ -z "$test_override" ]; then
    printf '%s\n' "$system_executable"
  else
    printf '%s\n' "$test_override"
  fi
}

DIRNAME_EXECUTABLE="$(select_executable "$SYSTEM_DIRNAME_EXECUTABLE" "${RECORDINGS_TEST_COMPANION_DIRNAME_EXECUTABLE:-}")"
PWD_EXECUTABLE="$(select_executable "$SYSTEM_PWD_EXECUTABLE" "${RECORDINGS_TEST_COMPANION_PWD_EXECUTABLE:-}")"
CHMOD_EXECUTABLE="$(select_executable "/bin/chmod" "${RECORDINGS_TEST_COMPANION_CHMOD_EXECUTABLE:-}")"
CP_EXECUTABLE="$(select_executable "/bin/cp" "${RECORDINGS_TEST_COMPANION_CP_EXECUTABLE:-}")"
ENV_EXECUTABLE="$(select_executable "/usr/bin/env" "${RECORDINGS_TEST_COMPANION_ENV_EXECUTABLE:-}")"
GREP_EXECUTABLE="$(select_executable "/usr/bin/grep" "${RECORDINGS_TEST_COMPANION_GREP_EXECUTABLE:-}")"
MKDIR_EXECUTABLE="$(select_executable "/bin/mkdir" "${RECORDINGS_TEST_COMPANION_MKDIR_EXECUTABLE:-}")"
MKTEMP_EXECUTABLE="$(select_executable "/usr/bin/mktemp" "${RECORDINGS_TEST_COMPANION_MKTEMP_EXECUTABLE:-}")"
MV_EXECUTABLE="$(select_executable "/bin/mv" "${RECORDINGS_TEST_COMPANION_MV_EXECUTABLE:-}")"
RM_EXECUTABLE="$(select_executable "/bin/rm" "${RECORDINGS_TEST_COMPANION_RM_EXECUTABLE:-}")"
LIPO_EXECUTABLE="$(select_executable "/usr/bin/lipo" "${RECORDINGS_TEST_COMPANION_LIPO_EXECUTABLE:-}")"

for executable_spec in \
  "DIRNAME_EXECUTABLE:$DIRNAME_EXECUTABLE" \
  "PWD_EXECUTABLE:$PWD_EXECUTABLE" \
  "CHMOD_EXECUTABLE:$CHMOD_EXECUTABLE" \
  "CP_EXECUTABLE:$CP_EXECUTABLE" \
  "ENV_EXECUTABLE:$ENV_EXECUTABLE" \
  "GREP_EXECUTABLE:$GREP_EXECUTABLE" \
  "MKDIR_EXECUTABLE:$MKDIR_EXECUTABLE" \
  "MKTEMP_EXECUTABLE:$MKTEMP_EXECUTABLE" \
  "MV_EXECUTABLE:$MV_EXECUTABLE" \
  "RM_EXECUTABLE:$RM_EXECUTABLE"; do
  require_executable "${executable_spec%%:*}" "${executable_spec#*:}"
done
if [ "$BUILD_KIND" = "universal" ]; then
  require_executable "LIPO_EXECUTABLE" "$LIPO_EXECUTABLE"
fi

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

ROOT="$(cd "$("$DIRNAME_EXECUTABLE" "${BASH_SOURCE[0]}")/.." && "$PWD_EXECUTABLE" -P)"
CURRENT_DIRECTORY="$($PWD_EXECUTABLE -P)"
OUTPUT="$1"
case "$OUTPUT" in
  /*) ;;
  *) OUTPUT="${CURRENT_DIRECTORY}/${OUTPUT}" ;;
esac
case "$OUTPUT" in
  */)
    echo "Companion CLI output must be a file path, not a directory path: ${OUTPUT}." >&2
    exit 1
    ;;
esac
if [ -d "$OUTPUT" ]; then
  echo "Companion CLI output must not be an existing directory: ${OUTPUT}." >&2
  exit 1
fi

ENTRY="${ROOT}/src/cli/index.ts"
if [ ! -f "$ENTRY" ]; then
  echo "Recordings CLI source is missing from ${ROOT}." >&2
  exit 1
fi
for required_source in package.json bun.lock bunfig.toml tsconfig.json; do
  if [ ! -f "${ROOT}/${required_source}" ]; then
    echo "Recordings companion build input is missing: ${ROOT}/${required_source}." >&2
    exit 1
  fi
done

WORK_DIR="$($MKTEMP_EXECUTABLE -d /tmp/recordings-companion-build.XXXXXX)"
PUBLISH_OUTPUT=""
cleanup() {
  if [ -n "$PUBLISH_OUTPUT" ]; then
    "$RM_EXECUTABLE" -f "$PUBLISH_OUTPUT"
  fi
  "$RM_EXECUTABLE" -rf "$WORK_DIR"
}
trap cleanup EXIT

BUILD_HOME="$WORK_DIR/home"
BUN_CACHE="$WORK_DIR/bun-cache"
STAGED_ROOT="$WORK_DIR/package"
COMPILE_DIR="$WORK_DIR/compile"
COMPILED_OUTPUT="$COMPILE_DIR/recordings"
COMPILED_ARM64="$COMPILE_DIR/recordings.arm64"
COMPILED_X86_64="$COMPILE_DIR/recordings.x86_64"
"$MKDIR_EXECUTABLE" -p "$BUILD_HOME" "$BUN_CACHE" "$STAGED_ROOT" "$COMPILE_DIR"
"$CP_EXECUTABLE" "$ROOT/package.json" "$ROOT/bun.lock" "$ROOT/bunfig.toml" "$ROOT/tsconfig.json" "$STAGED_ROOT/"
"$CP_EXECUTABLE" -R "$ROOT/src" "$STAGED_ROOT/src"
if [ -d "$ROOT/migrations" ]; then
  "$CP_EXECUTABLE" -R "$ROOT/migrations" "$STAGED_ROOT/migrations"
fi

run_bun() {
  "$ENV_EXECUTABLE" -i \
    HOME="$BUILD_HOME" \
    PATH="$SANITIZED_PATH" \
    TMPDIR="$WORK_DIR" \
    "$BUN_EXECUTABLE" "$@"
}

run_lipo() {
  "$ENV_EXECUTABLE" -i \
    HOME="$BUILD_HOME" \
    PATH="$SANITIZED_PATH" \
    TMPDIR="$WORK_DIR" \
    "$LIPO_EXECUTABLE" "$@"
}

verify_exact_binary_architectures() {
  local binary="$1"
  shift
  local actual_architectures
  local actual_architecture
  local expected_architecture
  local actual_count=0
  local match_count

  if ! actual_architectures="$(run_lipo -archs "$binary")"; then
    echo "Could not read companion CLI architectures: $binary" >&2
    return 1
  fi
  for actual_architecture in $actual_architectures; do
    actual_count=$((actual_count + 1))
    case " $* " in
      *" $actual_architecture "*) ;;
      *)
        echo "Companion CLI contains unsupported architecture: $actual_architecture" >&2
        return 1
        ;;
    esac
  done
  if [ "$actual_count" -ne "$#" ]; then
    echo "Companion CLI architecture count does not match the universal release policy." >&2
    return 1
  fi
  for expected_architecture in "$@"; do
    match_count=0
    for actual_architecture in $actual_architectures; do
      if [ "$actual_architecture" = "$expected_architecture" ]; then
        match_count=$((match_count + 1))
      fi
    done
    if [ "$match_count" -ne 1 ]; then
      echo "Companion CLI must contain exactly one $expected_architecture slice." >&2
      return 1
    fi
  done
}

run_bun install \
  --cwd "$STAGED_ROOT" \
  --production \
  --frozen-lockfile \
  --ignore-scripts \
  --minimum-release-age=604800 \
  --cache-dir "$BUN_CACHE" \
  --no-progress

if [ "$BUILD_KIND" = "universal" ]; then
  (
    cd "$COMPILE_DIR"
    run_bun build \
      --compile \
      --target="bun-darwin-arm64" \
      --reject-unresolved \
      --no-compile-autoload-dotenv \
      --no-compile-autoload-bunfig \
      --no-compile-autoload-tsconfig \
      --no-compile-autoload-package-json \
      "$STAGED_ROOT/src/cli/index.ts" \
      --outfile "$COMPILED_ARM64"
    run_bun build \
      --compile \
      --target="bun-darwin-x64" \
      --reject-unresolved \
      --no-compile-autoload-dotenv \
      --no-compile-autoload-bunfig \
      --no-compile-autoload-tsconfig \
      --no-compile-autoload-package-json \
      "$STAGED_ROOT/src/cli/index.ts" \
      --outfile "$COMPILED_X86_64"
  )
  run_lipo -create "$COMPILED_ARM64" "$COMPILED_X86_64" -output "$COMPILED_OUTPUT"
  verify_exact_binary_architectures "$COMPILED_OUTPUT" arm64 x86_64
else
  (
    cd "$COMPILE_DIR"
    run_bun build \
      --compile \
      --reject-unresolved \
      --no-compile-autoload-dotenv \
      --no-compile-autoload-bunfig \
      --no-compile-autoload-tsconfig \
      --no-compile-autoload-package-json \
      "$STAGED_ROOT/src/cli/index.ts" \
      --outfile "$COMPILED_OUTPUT"
  )
fi

EXPECTED_VERSION="$(
  cd "$STAGED_ROOT"
  run_bun -e 'const pkg = await Bun.file("package.json").json(); process.stdout.write(pkg.version)'
)"
run_output() {
  "$ENV_EXECUTABLE" -i \
    HOME="$BUILD_HOME" \
    PATH="$SANITIZED_PATH" \
    TMPDIR="$WORK_DIR" \
    "$COMPILED_OUTPUT" "$@"
}
ACTUAL_VERSION="$(run_output --version)"

if [ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "Companion CLI version mismatch: expected ${EXPECTED_VERSION}, got ${ACTUAL_VERSION}." >&2
  exit 1
fi

require_command() {
  if ! run_output "$@" --help >/dev/null 2>&1; then
    echo "Companion CLI is missing command: $*." >&2
    exit 1
  fi
}

require_flag() {
  local command_name="$1"
  local flag="$2"
  shift 2
  if ! run_output "$@" --help | "$GREP_EXECUTABLE" -Fq -- "$flag"; then
    echo "Companion CLI is missing ${command_name} ${flag}." >&2
    exit 1
  fi
}

# Keep this contract in lockstep with every command and option emitted by the Swift app.
for command in list show search stats delete transcribe save-text rewrite; do
  require_command "$command"
done
require_command project register

require_flag "root" "--json"
require_flag "root" "--project"
for flag in --name --path --description; do
  require_flag "project register" "$flag" project register
done
for flag in -n --limit --offset; do
  require_flag "list" "$flag" list
done
require_flag "search" "-n" search
require_flag "search" "--limit" search
for flag in --post-processing --prompt --transcriber-prompt --language --recording-id --transcription-model --transcriber-model --enhancement-model --enhance-triggers-json --keyword-transforms-json; do
  require_flag "transcribe" "$flag" transcribe
done
for flag in --text-file --source --model-used --post-processing --audio-path --duration-ms --language --transcriber-prompt --recording-id --transcription-model --transcriber-model --enhancement-model --enhance-triggers-json --keyword-transforms-json; do
  require_flag "save-text" "$flag" save-text
done
for flag in --instruction --post-processing --language --prompt --transcriber-prompt --transcription-model --transcriber-model --enhancement-model --enhance-triggers-json --keyword-transforms-json; do
  require_flag "rewrite" "$flag" rewrite
done

OUTPUT_DIRECTORY="$("$DIRNAME_EXECUTABLE" "$OUTPUT")"
"$MKDIR_EXECUTABLE" -p "$OUTPUT_DIRECTORY"
PUBLISH_OUTPUT="$($MKTEMP_EXECUTABLE "$OUTPUT_DIRECTORY/.recordings-companion.XXXXXX")"
"$MV_EXECUTABLE" "$COMPILED_OUTPUT" "$PUBLISH_OUTPUT"
"$CHMOD_EXECUTABLE" 0755 "$PUBLISH_OUTPUT"
run_bun -e '
  import { renameSync } from "node:fs";
  renameSync(process.argv[1], process.argv[2]);
' "$PUBLISH_OUTPUT" "$OUTPUT"
PUBLISH_OUTPUT=""
echo "Built Recordings companion CLI ${ACTUAL_VERSION}: ${OUTPUT}"
