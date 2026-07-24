# Changelog

## 0.2.11 (2026-07-24) — maintenance backport for the published 0.2.10 lineage

Fixes the macOS Accessibility/Microphone permission re-prompt loop caused by
code-signing identity churn (observed on station03).

Root cause: the bun `postinstall` rebuilt the native `Recordings.app` from
source on every install and ad-hoc signed it (`codesign --sign -`). An ad-hoc
signature has no certificate chain, so the TCC designated requirement is the
CDHash of that exact binary. Every reinstall produced a new CDHash, which
invalidated the stored TCC grant, and the installer then deliberately ran
`tccutil reset` on the "stale" grant — deleting the user's approval on every
update.

Changes:

- `scripts/install_macos_app.sh` no longer touches TCC permission state at
  all: the `tccutil reset` / stale-permission logic is removed. The installer
  must never delete a user's Microphone or Accessibility decision.
- The installer now detects an installed `Recordings.app` that is signed with
  a real certificate (non-ad-hoc, identifier `com.hasna.recordings`, valid
  signature) and skips the rebuild entirely, preserving the stable identity
  and the TCC grants bound to it. Set `RECORDINGS_FORCE_APP_REINSTALL=1` to
  force a rebuild anyway.
- `src/native/Recordings/build.sh` honors `RECORDINGS_CODESIGN_IDENTITY` so a
  station or CI with a stable signing certificate keeps a constant identity
  across rebuilds. When an explicit identity is requested, a signing failure
  fails the build instead of silently falling back to ad-hoc.

Note: `main` (0.2.11+ unpublished lineage) has since redesigned the macOS
install/update pipeline (no `postinstall` build, Developer ID release
signing, root-owned updater broker). This release is the minimal backport
that stops the permission-destroying behavior in the currently published
package without pulling in that redesign.
