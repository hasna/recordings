# Changelog

## 0.2.12 (2026-07-24) — headless code-signing hardening (0.2.10 maintenance lineage)

Follow-up hardening for the 0.2.11 stable-signing path in
`src/native/Recordings/build.sh`. 0.2.11 made the signing identity stable but
still assumed Hasna infrastructure and could prompt or fail over SSH.

- **The Hasna `secrets` vault CLI is now optional.** 0.2.11 hard-failed the
  build when `secrets` was absent, which broke a plain `npm i -g
  @hasna/recordings` on a Mac with no Hasna infrastructure. Signing material
  (keychain password, certificate, private key) is now read/written through
  `identity_get` / `identity_set`, which use the vault when it is present and
  otherwise fall back to a per-user local store under
  `~/.hasna/recordings/signing` with files created mode 600. A public install
  still gets a stable, certificate-based identity headlessly; the vault is an
  optimization, never a requirement.
- **The keychain password never appears on argv.** `create-keychain`,
  `unlock-keychain`, and `set-key-partition-list` now receive it on STDIN
  instead of `-p` / `-k`, so it is not transiently visible via `ps`.
- **Ephemeral PKCS#12 transport passphrase.** The export→import handoff uses a
  throwaway random passphrase (`-passout stdin` for openssl, `-P` for `security
  import`, which does not read STDIN headlessly) instead of reusing the
  persistent keychain password.
- **Removed the auth-gated `security add-trusted-cert` call.** Trusting the
  self-signed root requires an authorization that can prompt — and be denied —
  over SSH, and it is unnecessary: the build only signs (it never runs
  `codesign --verify`), and codesign signs fine with an untrusted self-signed
  identity located by hash.
- **Stale keychain entries are pruned from the search list.** `codesign`
  iterates the whole user search list, and a dangling reference to a deleted
  keychain makes identity lookup fail with "no identity found" even when the
  identity exists in another listed keychain. The list is now rebuilt from the
  keychains that actually exist on disk, plus the dedicated signing keychain.
- Tests: source-contract assertions for the STDIN password handling, the
  ephemeral p12 passphrase, the removed `add-trusted-cert`, and the optional
  vault; plus two stubbed-toolchain installer tests that run with no `secrets`
  on `PATH` and assert the local store is used and the same identity (and
  therefore the same designated requirement) is reused across a rebuild.

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
  **"Hasna Recordings Signing"** and reuses it on every subsequent build.
  Because the same certificate is reused, the app's TCC designated requirement
  is certificate-based and constant across rebuilds, so Microphone/Accessibility
  grants survive app updates. The build **never** defaults to ad-hoc
  (`--sign -`); if it cannot obtain a stable identity it fails rather than
  churning the identity.
- **Headless (SSH) code-signing.** `build.sh` no longer uses the login keychain
  or `security set-key-partition-list -k ""`. Over SSH the login keychain is
  locked and codesign blocks on an interactive unlock/allow prompt. The build
  now creates/reuses a **dedicated** code-signing keychain at
  `~/.hasna/recordings/signing/recordings-signing.keychain-db` whose password is
  generated once and stored in the secrets vault under
  `hasna/machine/<host>/recordings/signing/keychain_password`. It
  `create-keychain`/`unlock-keychain`s with that known password, imports the
  self-signed identity with `-T /usr/bin/codesign`, adds the keychain to the
  user search list, and runs
  `security set-key-partition-list -S apple-tool:,apple: -k <known-password>`
  so codesign has **non-interactive** key access with no prompt. The signing
  certificate and private key are also persisted (base64) in the vault
  (`.../certificate_pem_b64`, `.../private_key_pem_b64`) so the designated
  requirement stays stable even if the keychain is recreated.
- **Fail-closed on missing entitlements.** `build.sh` now aborts the build if
  `RecordingsLib/Recordings.entitlements` is absent, instead of silently
  skipping signing and shipping an unsigned/unentitled app.
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
