# shellcheck shell=bash
# Shared reader for the local-only approved-target policy. Sourced by both
# scripts/install_macos_app.sh and src/native/Recordings/build.sh, so the two shell
# entry points cannot drift apart.
#
# This is a SECOND implementation of the same rules as localOnlyApprovedTargets() in
# scripts/macos_artifact.ts, not a shared one — shell cannot call that function without
# spawning bun inside argument validation. The two are kept behaviourally equivalent by
# an executing contract test ("the shell reader and the TypeScript reader agree on every
# policy shape"), which is the only thing that actually holds them together. If you
# change the rules here, change them there and extend that test.
#
# Rules: reject anything that is not a regular file (a symlinked policy is refused, not
# followed), strip an optional UTF-8 BOM from the FIRST line only and a trailing CR from
# every line, trim ASCII space and tab only, reject any NUL byte, drop blank and comment
# lines, then require every target to be a well-formed short hostname, unique, and never
# the release fleet target. Anything else fails closed.
#
# Three of those rules exist because the two readers disagreed and the disagreement was
# provable, not theoretical:
#   * SYMLINKS. `[ -L ]` here refused a symlinked policy while readFileSync() there
#     followed it, so a symlink pointing at a widened allowlist was rejected by the
#     shell and silently honoured by TypeScript. Both now refuse; a symlink is never a
#     legitimate shape for package-local policy data shipped inside the tarball.
#     ASCII-ONLY TRIM. This used to trim [[:space:]], while TypeScript trims /[\t ]/
#     only. Enumerated, that split 21 of 36 whitespace rows, and in every one of them
#     THIS reader accepted a target TypeScript rejects — build gate open, install
#     validator closed. [[:space:]] covers VT (0x0b), FF (0x0c) and CR, and in a UTF-8
#     locale it also matched U+1680, U+2000, U+2002, U+2009, U+205F, U+2028, U+2029 and
#     U+3000. Both now trim space and tab only and leave everything else in place for the
#     hostname shape to reject. This one change closes all 21 rows on its own.
#   * BOM POSITION. This used to strip a BOM from every line while TypeScript strips one
#     only at offset 0, so a BOM on the second line was accepted here and rejected there.
#     A U+FEFF anywhere but the very start of the file is a zero-width no-break space,
#     not a byte-order mark, and both readers now reject it.
#
# LC_ALL/LANG are pinned to C for the duration of this function as defence in depth, and
# NOT as the fix for anything above. Measured on glibc/bash: with the ASCII-only trim in
# place, removing this pin changes no verdict in the whitespace table, and `[a-z0-9-]`
# rejected uppercase identically under C, C.UTF-8 and en_US.UTF-8 — so no divergence here
# is attributable to it. What it does buy is that the rules below are byte rules stated as
# byte rules: bracket expressions in bash patterns are collation- and locale-dependent in
# principle (restoring [[:space:]] under this pin still leaves 5 divergent rows, versus 21
# without it), so pinning keeps a future edit that reaches for a character class from
# quietly handing the caller's locale a say in the policy. It is also the idiom this repo
# already uses: scripts/install_macos_app.sh:4-6 exports LC_ALL=C, LANG=C and TZ=UTC0.
#
# Be aware, if you are deciding whether to keep this line: NO TEST IN THIS REPOSITORY
# FAILS IF YOU DELETE IT. It is unguarded by construction — on this platform every
# observable rule above is already locale-independent, so any test written for it would
# pass with the pin removed and would be a guard that protects nothing.

# read_local_only_targets <policy-path> <out-list-var> <out-match-var> <requested-target>
# Sets <out-list-var> to a comma-separated list for error messages and
# <out-match-var> to 1 when <requested-target> is approved. Returns non-zero with a
# message on stderr when the policy itself is unusable.
read_local_only_targets() {
  local LC_ALL=C LANG=C
  local policy_path="$1"
  local list_var="$2"
  local match_var="$3"
  local requested="$4"

  if [ ! -f "$policy_path" ] || [ -L "$policy_path" ]; then
    echo "Local-only approved target policy is missing." >&2
    return 1
  fi

  # `read` silently discards NUL bytes, so "station03\0station99" would otherwise be
  # accepted as the single target "station03station99" — quietly dropping station03 from
  # the allowlist. `read -d ''` succeeds only when it finds a NUL, so this fails closed.
  if IFS= read -r -d '' _ < "$policy_path"; then
    echo "Local-only approved target policy contains a NUL byte." >&2
    return 1
  fi

  local line target list="" matched=0 first_line=1
  local blanks=$' \t'
  local -a seen=()
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$first_line" -eq 1 ]; then
      line="${line#$'\xef\xbb\xbf'}"
      first_line=0
    fi
    line="${line%$'\r'}"
    # Trim ASCII space and tab only, so an indented entry or comment behaves the same
    # here as it does in the TypeScript reader. Deliberately not [[:space:]]: that also
    # covers VT and FF, which TypeScript's /[\t ]/ leaves in place to be rejected.
    line="${line#"${line%%[!$blanks]*}"}"
    line="${line%"${line##*[!$blanks]}"}"
    case "$line" in '' | '#'*) continue ;; esac
    target="$line"
    case "$target" in
      *[!a-z0-9-]* | [!a-z]* | *-)
        echo "Local-only approved target policy has an invalid target name: ${target}" >&2
        return 1
        ;;
    esac
    if [ "${#target}" -lt 3 ] || [ "${#target}" -gt 32 ]; then
      echo "Local-only approved target policy has an invalid target name: ${target}" >&2
      return 1
    fi
    if [ "$target" = "fleet" ]; then
      echo "Local-only approved target policy must not list the release fleet target." >&2
      return 1
    fi
    local previous
    for previous in ${seen[@]+"${seen[@]}"}; do
      if [ "$previous" = "$target" ]; then
        echo "Local-only approved target policy has duplicate targets." >&2
        return 1
      fi
    done
    seen+=("$target")
    list="${list:+${list}, }${target}"
    if [ "$target" = "$requested" ]; then
      matched=1
    fi
  done < "$policy_path"

  if [ -z "$list" ]; then
    echo "Local-only approved target policy lists no targets." >&2
    return 1
  fi

  printf -v "$list_var" '%s' "$list"
  printf -v "$match_var" '%s' "$matched"
}
