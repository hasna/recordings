# Changelog

All notable changes to `@hasna/recordings` are documented here.

This project is pre-1.0. Following semver's pre-1.0 convention, a **minor** bump
(`0.x.0`) signals a breaking change; patch bumps (`0.x.y`) do not.

## 0.3.0 — unreleased

**This release is breaking.** It is numbered `0.3.0` rather than `0.2.15`
because `0.2.15` would have shipped the removal below under a patch number.
`0.2.15` was written into `package.json` on 2026-07-27 and never published — npm
`latest` is still `0.2.14` — and the breaking commit landed two days later, on
2026-07-29, under that already-bumped number. Nothing is being retracted here;
the number is being corrected before it ships.

### Breaking — deployment modes are removed (`8ef9ed8`)

`local | self_hosted | cloud`, and the surviving `remote` / `hybrid` aliases,
are gone. They described *where* something ran, which is an operational fact
rather than a product variant. Two independent, role-named switches replace all
five words:

| role | variable | values |
| --- | --- | --- |
| server data backend | `HASNA_RECORDINGS_STORAGE_MODE` | `sqlite` \| `postgresql` |
| client store | `HASNA_RECORDINGS_CLIENT_STORE` | `sqlite` \| `http` |

A retired mode word is now a **hard error** naming the variable to set and the
exact value to set it to — it is not silently normalized. That silent
normalization was the actual defect: the client rewrote `self_hosted | remote |
hybrid` to `cloud` without a word, and the server treated only `remote | hybrid`
as Postgres while every other value — including `self_hosted`, including a typo
— fell through to "is a `DATABASE_URL` set?", discarding the operator's stated
intent. The same variable was also read by two entrypoints with opposite
meanings.

Specific incompatibilities:

- `HASNA_RECORDINGS_STORAGE_MODE` / `RECORDINGS_STORAGE_MODE` now take
  `sqlite` | `postgresql`. A retired mode word throws.
- Client routing moved to `HASNA_RECORDINGS_CLIENT_STORE` /
  `RECORDINGS_CLIENT_STORE` (`sqlite` | `http`). The `API_URL` + `API_KEY`
  auto-flip is unchanged.
- `Store.mode`: `"local" | "cloud-http"` → `"sqlite" | "http"`. Same for
  `TransportResolution.transport` and `describeActiveStore().transport`.
- `TransportResolution.mode` → `.requested`; `.deprecatedAlias` removed — it
  existed only to carry the silently-normalized word.
- Exported type `StorageMode` → `ClientStore`; `defaultCloudBaseUrl` →
  `defaultApiBaseUrl`.
- `isCloudModeEnabled` → `isPostgresBackendEnabled` (plus `resolveDataBackend`,
  `configuredDataBackend`, `DataBackend`).
- `/health`, `/ready`, `/version` report `mode: "sqlite" | "postgresql"` (was
  `"local" | "remote"`). Field names are unchanged.
- An explicit `STORAGE_MODE=sqlite` now wins over a present `DATABASE_URL`.
  Previously `local` there was ignored entirely and the DSN decided.

The client still keeps exactly two stores and still never opens Postgres: there
is no client-side `PostgresStore` and none is added. The shared Postgres dataset
is reachable only through the server's `/v1` API.

`hasna.contract.json` `storage.mode` is deliberately unchanged — that enum
belongs to `hasna/contracts`. `@hasna/contracts` is not bumped.

### Also in this release

`0.3.0` carries 164 commits since the `0.2.15` version bump and 39 user-visible
`feat`/`fix` commits since the published `0.2.14`, including the macOS updater
and paste-coordinator work, the local-station Developer ID signing fix so TCC
grants survive, `noUncheckedIndexedAccess` type strictness, declared `engines`,
and the manual desktop snapshot export command.

## 0.2.14 and earlier

Not documented here; this file starts at `0.3.0`. See the git history and the
GitHub release notes for prior versions.
