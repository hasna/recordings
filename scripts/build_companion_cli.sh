#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <output-path>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="$1"
case "$OUTPUT" in
  /*) ;;
  *) OUTPUT="${PWD}/${OUTPUT}" ;;
esac

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is required to build the Recordings companion CLI." >&2
  exit 1
fi

if [ -f "${ROOT}/src/cli/index.ts" ]; then
  ENTRY="${ROOT}/src/cli/index.ts"
elif [ -f "${ROOT}/dist/cli/index.js" ]; then
  ENTRY="${ROOT}/dist/cli/index.js"
else
  echo "Recordings CLI source is missing from ${ROOT}." >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT")"
rm -f "$OUTPUT"
(
  cd "$ROOT"
  bun build --compile "$ENTRY" --outfile "$OUTPUT"
)

EXPECTED_VERSION="$(
  cd "$ROOT"
  bun -e 'const pkg = await Bun.file("package.json").json(); process.stdout.write(pkg.version)'
)"
ACTUAL_VERSION="$($OUTPUT --version)"

if [ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "Companion CLI version mismatch: expected ${EXPECTED_VERSION}, got ${ACTUAL_VERSION}." >&2
  exit 1
fi

require_command() {
  if ! "$OUTPUT" "$@" --help >/dev/null 2>&1; then
    echo "Companion CLI is missing command: $*." >&2
    exit 1
  fi
}

require_flag() {
  local command_name="$1"
  local flag="$2"
  shift 2
  if ! "$OUTPUT" "$@" --help | grep -Fq -- "$flag"; then
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
for flag in --post-processing --transcriber-prompt; do
  require_flag "transcribe" "$flag" transcribe
done
for flag in --text-file --source --model-used --post-processing --audio-path --duration-ms --language --transcriber-prompt; do
  require_flag "save-text" "$flag" save-text
done
require_flag "rewrite" "--instruction" rewrite

chmod 0755 "$OUTPUT"
echo "Built Recordings companion CLI ${ACTUAL_VERSION}: ${OUTPUT}"
