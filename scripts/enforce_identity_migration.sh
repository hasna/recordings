# shellcheck shell=bash
# Shared enforcement for the designated-requirement (code identity) migration gate,
# sourced by scripts/install_macos_app.sh.
#
# Replacing an installed app whose designated requirement the candidate does not
# satisfy is what makes macOS treat the candidate as a different program: the
# Microphone and Accessibility grants recorded against the installed requirement stop
# applying. That is true for every artifact policy, not only for release. Local-only
# artifacts are ad-hoc signed (src/native/Recordings/build.sh sets CODESIGN_IDENTITY="-"),
# so their designated requirement is CDHash-based and a local-only install over a
# certificate-rooted bundle always destroys the grant. This gate therefore lives in one
# function that the installer calls unconditionally, rather than in policy-gated
# conditionals that a new policy can silently escape.
#
# It is deliberately a pure function of already-computed values with no side effects and
# no macOS-only tools, so the whole decision table is executable on any host — see
# src/__tests__/identity-migration-guard.test.ts. Every input is validated before it is
# interpreted: an empty, unset, or unrecognised value denies. There is no default-allow
# branch.
#
# The two approvals are distinct on purpose. --allow-signing-identity-migration approves a
# release signer rotation and is bound to exact operator-supplied old/new digests;
# --allow-adhoc-identity-migration approves an ad-hoc local-only replacement. Approving
# one is not approving the other, so neither flag is honoured for the other policy.

# recordings_enforce_identity_migration <artifact-policy> <identity-migration> \
#   <allow-release-migration> <allow-adhoc-migration> <previous-identity-sha256> \
#   <candidate-identity-sha256> <expected-old-identity-sha256> <expected-new-identity-sha256>
# Returns 0 only when replacing the installed app is explicitly permitted, and non-zero
# with a message on stderr in every other case, including malformed input.
recordings_enforce_identity_migration() {
  if [ "$#" -ne 8 ]; then
    echo "Identity-migration enforcement received ${#} arguments instead of 8." >&2
    return 1
  fi
  local artifact_policy="$1"
  local identity_migration="$2"
  local allow_release_migration="$3"
  local allow_adhoc_migration="$4"
  local previous_identity_sha256="$5"
  local candidate_identity_sha256="$6"
  local expected_old_identity_sha256="$7"
  local expected_new_identity_sha256="$8"

  # `[ x -eq y ]` on a non-numeric value is a fatal syntax error under `set -e` in some
  # shells and a silent 0 in others, so the three state bits are shape-checked here
  # instead of being fed straight to an arithmetic test.
  case "$identity_migration" in
    0 | 1) ;;
    *)
      echo "Identity-migration state ${identity_migration:-<empty>} is not a 0/1 decision; refusing to replace the installed app." >&2
      return 1
      ;;
  esac
  case "$allow_release_migration" in
    0 | 1) ;;
    *)
      echo "Release identity-migration approval ${allow_release_migration:-<empty>} is not a 0/1 decision." >&2
      return 1
      ;;
  esac
  case "$allow_adhoc_migration" in
    0 | 1) ;;
    *)
      echo "Ad-hoc identity-migration approval ${allow_adhoc_migration:-<empty>} is not a 0/1 decision." >&2
      return 1
      ;;
  esac

  # An unrecognised policy — including an empty one — has no approval flag and therefore
  # cannot be approved. Denying here is what keeps a future policy from inheriting the
  # release-only gating that made this gate unenforced for local_only.
  local approval
  case "$artifact_policy" in
    release) approval="$allow_release_migration" ;;
    local_only) approval="$allow_adhoc_migration" ;;
    *)
      echo "Identity-migration enforcement does not recognise the artifact policy ${artifact_policy:-<empty>}." >&2
      return 1
      ;;
  esac

  if [ "$identity_migration" -eq 1 ] && [ "$approval" -ne 1 ]; then
    if [ "$artifact_policy" = "release" ]; then
      echo "Candidate and existing app designated requirements are not mutually compatible; review the signer change and rerun once with --allow-signing-identity-migration." >&2
    else
      echo "Candidate and existing app designated requirements are not mutually compatible (installed ${previous_identity_sha256} -> candidate ${candidate_identity_sha256}); this local-only artifact is ad-hoc signed, so replacing the installed app voids its Microphone and Accessibility grants. Rerun once with --allow-adhoc-identity-migration to accept that." >&2
    fi
    return 1
  fi
  # An approval that is not needed means the operator and the installer disagree about
  # what is being replaced, and one of them is wrong. It also stops automation from
  # carrying the flag permanently, which would turn the gate back into a no-op.
  if [ "$identity_migration" -eq 0 ] && [ "$approval" -eq 1 ]; then
    echo "Identity migration approval was supplied but no identity migration is required." >&2
    return 1
  fi
  # Release migrations are additionally pinned to the exact operator-approved pair. A
  # local-only candidate is ad-hoc, so its digest is derived from a CDHash that changes
  # with every build; pinning it would only restate the artifact in hand. The distinct
  # approval flag carries that consent instead.
  if [ "$artifact_policy" = "release" ] && [ "$identity_migration" -eq 1 ] && {
       [ "$previous_identity_sha256" != "$expected_old_identity_sha256" ] ||
       [ "$candidate_identity_sha256" != "$expected_new_identity_sha256" ];
     }; then
    echo "Signing identity migration does not match the exact operator-approved old/new identities." >&2
    return 1
  fi
  return 0
}
