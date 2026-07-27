/**
 * Canonical macOS bundle identity for Recordings.app.
 *
 * Why this module exists at all, rather than the constant living next to its first caller:
 * three branches in the #24-#29 queue each introduced their own copy of this literal —
 * `src/cli/macos-permissions.ts` (#24), `src/lib/capture-probe.ts` (#25) and
 * `src/cli/macos-shortcut.ts` (#26, as `RECORDINGS_BUNDLE_ID`). None of them exists on the
 * base commit, so the duplication is entirely a product of parallel work.
 *
 * The review ruling was "canonical is `RECORDINGS_BUNDLE_IDENTIFIER` in `macos-permissions.ts`".
 * That ruling was made before #25 was known to add a copy in `src/lib`, which is the LOWER
 * layer and re-exports the constant as part of the package's public surface via `src/index.ts`.
 * Honouring the ruling literally would make `src/lib` import from `src/cli`, inverting the
 * dependency direction for a published symbol. So the ruled NAME is kept and the owner moves
 * one layer down to here; `macos-permissions.ts` re-exports it, so the ruled import path still
 * resolves and every caller in the queue ends up on one definition.
 *
 * This identifier is not cosmetic. It is the TCC lookup key, the `tccutil reset` argument, and
 * the value the app's own UserDefaults domain keys on — a bundle that does not carry it is not
 * this app whatever it is named on disk.
 */
export const RECORDINGS_BUNDLE_IDENTIFIER = "com.hasna.recordings";

/**
 * The state `resolveTccGrant()` reports when a TCC database existed but could not be read.
 *
 * Reading the user TCC database requires Full Disk Access (`kTCCServiceSystemPolicyAllFiles`).
 * That grant is a property of the **session's responsible process**, not of the tool you happen
 * to be running. Measured on a fleet Mac: `bun` carries `auth_value=0` — explicitly DENIED — and a
 * Bun script over SSH reads `TCC.db` anyway, because `sshd-keygen-wrapper` holds
 * `SystemPolicyAllFiles auth_value=2` and its children inherit that. So "re-run from a plain ssh
 * shell" is the right remedy for the wrong reason, and the intuitive reason is actively
 * misleading: granting Full Disk Access to `tmux` or `bun` is not what governs the outcome.
 *
 * The failure this state exists for is that a reader inspecting only stdout cannot tell an empty
 * result from a refused one, which is how the CLI came to assert "the app has never requested
 * microphone access" on a machine where the grant row demonstrably existed.
 *
 * The name is deliberately cause-neutral. A non-zero `sqlite3` exit also covers a missing
 * binary, `SQLITE_BUSY`, and a corrupt file — none of which is an authorization problem — so
 * naming Full Disk Access in the state itself would assert a cause that was never established.
 *
 * Kept here, and not as a private literal in each consumer, because it is a value two modules
 * must agree on byte-for-byte: `macos-permissions.ts` produces it and the `check` renderer
 * compares against it to choose a yellow "cannot tell" marker over a red "denied" one. When
 * those two strings drifted apart during the #24 x #25 rebase, the comparison silently became
 * dead code and the renderer fell through to "denied" — telling the operator to grant a
 * permission that was already granted.
 */
export const TCC_DATABASE_UNREADABLE_STATE = "undetermined_tcc_database_unreadable";
