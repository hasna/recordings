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
# followed) or not readable, strip an optional UTF-8 BOM from the FIRST line only and a
# trailing CR from every line, trim ASCII space and tab only, reject any NUL byte, drop
# blank and comment lines, then require every target to be a well-formed short hostname,
# unique, and never the release fleet target. Anything else fails closed.
#
# Four of those rules exist because the two readers disagreed and the disagreement was
# provable, not theoretical:
#   * SYMLINKS. `[ -L ]` here refused a symlinked policy while readFileSync() there
#     followed it, so a symlink pointing at a widened allowlist was rejected by the
#     shell and silently honoured by TypeScript. Both now refuse; a symlink is never a
#     legitimate shape for package-local policy data shipped inside the tarball. Note the
#     granularity: only the FINAL path component is checked, so a policy reached through a
#     symlinked package root — which is what pnpm and yarn produce — still resolves.
#   * ASCII-ONLY TRIM. This used to trim [[:space:]], while TypeScript trims /[\t ]/
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
#   * PHASE ORDER. See the four numbered phases below.
#
# DO NOT DELETE the `local LC_ALL=C LANG=C` below. It is not decoration, and the platform
# where it matters is not the platform you are probably reading this on.
#
# `[a-z0-9-]` and `[!a-z]` are bracket RANGES, and range endpoints in a shell pattern are
# resolved by collation, not by byte value. Under a UTF-8 locale collation interleaves case
# (a A b B c C …), so `[a-z]` matches uppercase and `STATION07` — which the TypeScript
# reader rejects unconditionally — parses here as a valid target. That is this reader's
# whole failure mode: build gate open, install validator closed.
#
# The `globasciiranges` shopt forces ASCII semantics for ranges regardless of locale, which
# is what hides this on a modern Linux box. Be precise about WHICH bash, because the obvious
# summary is wrong: per bash's own NEWS, the option was INTRODUCED in 4.3 (§4.3 e.) but only
# became ENABLED BY DEFAULT in 5.0 (§5.0 hh.). So bash 4.3 and 4.4 are exposed exactly as 3.2
# is unless someone opts in, and it is only from 5.0 that the pin "looks like it does
# nothing". macOS ships /bin/bash 3.2.57, which has no such option at all — and
# src/native/Recordings/build.sh is `#!/bin/bash` and exports NO locale of its own, so on
# the Mac that actually builds artifacts this function-local pin is the only thing standing
# between the caller's LANG and the allowlist. (scripts/install_macos_app.sh:4-6 exports
# LC_ALL=C/LANG=C/TZ=UTC0, so the installer is covered independently; the builder is not.)
#
# Measured, emulating 3.2 range semantics with `shopt -u globasciiranges` under
# LC_ALL=en_US.UTF-8, on a policy containing STATION07:
#   pinned   -> "invalid target name: STATION07"        (agrees with TypeScript)
#   unpinned -> ACCEPTED, list=[STATION07], matched=1   (TypeScript still rejects)
# That case is an executing test: "the shell reader stays byte-exact under a hostile
# locale" in src/__tests__/local-only-target-policy.test.ts. An earlier revision of this
# comment claimed the pin was unguarded and protected nothing; that was measured only on
# bash 5.2 with globasciiranges on, which is the configuration that hides the problem.

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

  # A mode-000 policy passes the test above (`-f` needs no read permission) and then made
  # every redirection below fail with bash's own "Permission denied" and no reader message,
  # while the TypeScript reader raised a raw EACCES out of readFileSync. Same fail-closed
  # outcome, two unrecognizable errors; both readers now say this instead.
  if [ ! -r "$policy_path" ]; then
    echo "Local-only approved target policy is not readable." >&2
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
  local -a targets=()
  # Counted as they are collected rather than asked of the array afterwards. See Phase 1.
  local target_count=0
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
    targets+=("$line")
    target_count=$((target_count + 1))
  done < "$policy_path"

  # The remaining rules run in FOUR SEPARATE PHASES, in this order, and the order is load
  # bearing: it is the order localOnlyApprovedTargets() uses in scripts/macos_artifact.ts.
  # This reader used to validate each line completely before reading the next, so a policy
  # breaking two rules at once got whichever complaint came first by LINE while TypeScript
  # got whichever came first by RULE — "fleet\nfleet\n" was "must not list the release
  # fleet target" here and "has duplicate targets" there. Both still refused every such
  # policy, so no gate ever opened on it, but two readers cannot be called one policy while
  # they disagree about what is wrong, and the contract test that compares refusal reasons
  # is only honest if the phase order matches. Measured over 1500 multi-violation policies:
  # 160 reason divergences before this restructure, 0 after, 0 verdict divergences in both.

  # Phase 1: any targets at all.
  #
  # A plain counter, not `${#targets[@]}`. This is the ONE test reachable with an empty
  # array, and both callers run `set -euo pipefail` (src/native/Recordings/build.sh:5,
  # scripts/install_macos_app.sh:2) on a platform whose /bin/bash is 3.2.57. Whether the
  # LENGTH form of an empty-array expansion is safe under `set -u` in 3.2 is something
  # nobody here can execute — there is no macOS and no bash 3.2 on this machine — so this
  # sidesteps the question instead of asserting an answer to it. An earlier revision of
  # this very file was talked into deleting a load-bearing line by a confident comment
  # about behaviour nobody had run; a counter costs nothing and needs no such claim.
  if [ "$target_count" -eq 0 ]; then
    echo "Local-only approved target policy lists no targets." >&2
    return 1
  fi

  # Phase 2: every name well formed. Shape and length are one regex on the TypeScript side,
  # so they share this message and are checked together, target by target in order.
  #
  # `${targets[@]+"${targets[@]}"}` and not the plainer `"${targets[@]}"`: both callers run
  # `set -euo pipefail` (src/native/Recordings/build.sh:5, scripts/install_macos_app.sh:2) and
  # macOS ships /bin/bash 3.2.57, where expanding an EMPTY array under `set -u` is an
  # "unbound variable" error rather than an empty list. Phase 1 above already returned for the
  # empty case, so no loop here is reachable with an empty array today — this keeps the
  # property PROVABLE rather than dependent on that ordering surviving the next edit. If it
  # ever did fire, the caller would die with bash's `unbound variable` instead of
  # "lists no targets", which is precisely the unrecognizable-error class this reader exists
  # to eliminate. The remaining `${#targets[@]}` uses are inside Phase 3's arithmetic, which
  # this function only reaches once Phase 1 has proven the array non-empty.
  for target in ${targets[@]+"${targets[@]}"}; do
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
  done

  # Phase 3: no duplicates.
  local index other
  for ((index = 0; index < ${#targets[@]}; index++)); do
    for ((other = index + 1; other < ${#targets[@]}; other++)); do
      if [ "${targets[index]}" = "${targets[other]}" ]; then
        echo "Local-only approved target policy has duplicate targets." >&2
        return 1
      fi
    done
  done

  # Phase 4: never the release fleet target.
  for target in ${targets[@]+"${targets[@]}"}; do
    if [ "$target" = "fleet" ]; then
      echo "Local-only approved target policy must not list the release fleet target." >&2
      return 1
    fi
  done

  for target in ${targets[@]+"${targets[@]}"}; do
    list="${list:+${list}, }${target}"
    if [ "$target" = "$requested" ]; then
      matched=1
    fi
  done

  printf -v "$list_var" '%s' "$list"
  printf -v "$match_var" '%s' "$matched"
}
