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

if ! "$OUTPUT" project register --help >/dev/null 2>&1; then
  echo "Companion CLI is missing the project register command." >&2
  exit 1
fi
if ! "$OUTPUT" save-text --help >/dev/null 2>&1; then
  echo "Companion CLI is missing the save-text command." >&2
  exit 1
fi
if ! "$OUTPUT" transcribe --help | grep -Fq -- "--post-processing"; then
  echo "Companion CLI is missing transcribe --post-processing." >&2
  exit 1
fi

chmod 0755 "$OUTPUT"
echo "Built Recordings companion CLI ${ACTUAL_VERSION}: ${OUTPUT}"
