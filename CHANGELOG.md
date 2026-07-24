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
- **Stable signing by default (self-contained).** `src/native/Recordings/build.sh`
  now signs with a STABLE identity even when no environment is set. If
  `RECORDINGS_CODESIGN_IDENTITY` is provided it is honored (and a signing
  failure fails the build — no silent ad-hoc fallback). Otherwise the build
  creates, once, a per-machine self-signed code-signing certificate named
  **"Hasna Recordings Signing"** in the login keychain and reuses it on every
  subsequent build. Because the same certificate is reused, the app's TCC
  designated requirement is certificate-based and constant across rebuilds, so
  Microphone/Accessibility grants survive app updates. The build **never**
  defaults to ad-hoc (`--sign -`); if it cannot obtain a stable identity it
  fails rather than churning the identity.
- **Deterministic, version-aware rebuild skip.** The installer decides whether
  to rebuild by comparing a hash of the native app sources plus the package
  version (stored at `~/.hasna/recordings/.recordings-source-hash`) — NOT the
  app's signature. An identical reinstall (unchanged source/version) is skipped
  so the already-granted app is left untouched. A genuine app update (changed
  source or version) rebuilds and re-signs with the same stable certificate, so
  there is no update-starvation and no need for a force flag; the grants survive
  because the certificate-based designated requirement is unchanged.
  `RECORDINGS_FORCE_APP_REINSTALL=1` still forces a rebuild.
- The `~/Applications` launch-point copy is refreshed (and a running instance
  restarted) on **all** paths, including the skip-rebuild path, so the alternate
  copy never drifts to a stale build.

Note: `main` (0.2.11+ unpublished lineage) has since redesigned the macOS
install/update pipeline (no `postinstall` build, Developer ID release
signing, root-owned updater broker). This release is the minimal backport
that stops the permission-destroying behavior in the currently published
package without pulling in that redesign.
