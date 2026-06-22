# @hasna/recordings

Speech-to-text recording tool with MCP and CLI — records, transcribes, and optionally enhances text using AI

[![npm](https://img.shields.io/npm/v/@hasna/recordings)](https://www.npmjs.com/package/@hasna/recordings)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/recordings
```

## macOS App

Recordings ships a **full native macOS app** (SwiftUI, macOS 26 / Liquid Glass) — not a
menu-bar utility. It opens to a **Recordings workspace**: a narrow violet Liquid-Glass
sidebar (Workspace · Library · Projects · Modes · Storage) beside one continuous canvas
with the record hero, transcript library, and detail view.

- **Record** — large push-to-talk / dictation / command hero with live transcription,
  duration, the active project, and a "just now" strip. Global shortcut (default F5, or
  hold fn) works while the window is in the background.
- **Library** — every past transcript (read straight from the same SQLite/Postgres store
  the CLI and MCP write), searchable and filterable by project, mode, and machine, with a
  detail pane (copy, paste-into-front-app, audio playback, metadata).
- **Storage** — local database status plus one-click local⇄cloud sync.
- **Settings** (⌘,) — OpenAI key, language, recording shortcut, permissions, projects,
  and voice shortcuts.

The app reuses the `recordings` CLI as its data layer, so the CLI, MCP, and app all share
one store.

```bash
# Build + install Recordings.app from the installed package (macOS 26, Swift toolchain):
recordings app install        # builds and installs to ~/.hasna/recordings/Recordings.app
recordings app open           # launch it
recordings app status         # show install state

# From a source checkout:
cd src/native/Recordings && ./build.sh release && open .build/release/Recordings.app
swift test                    # run the native test suite
```

Requires macOS 26+ and a Swift toolchain (Xcode or Command Line Tools). Set the OpenAI API
key in **Settings** or via `recordings` config; transcription/enhancement use it.

## CLI Usage

```bash
recordings --help
```

- `recordings record`
- `recordings transcribe <file>`
- `recordings transcribe <file> --stream`
- `recordings rewrite <text> --instruction "<instruction>"`
- `recordings list`
- `recordings show <id>`
- `recordings search <query>`
- `recordings delete <id>`
- `recordings stats`

## MCP Server

```bash
recordings-mcp
```

## HTTP mode

```bash
recordings-mcp --http              # default port 8873
MCP_HTTP=1 MCP_HTTP_PORT=8873 recordings-mcp
```

Endpoints: `GET /health` → `{"status":"ok","name":"recordings"}`, MCP at `/mcp`.

Useful agent tools include `recordings_status` for safe service/config diagnostics,
`transcribe_audio`, `save_recording`, `list_recordings`, `search_recordings`,
`register_agent`, `heartbeat`, and `set_focus`.

## Storage Sync

This package has native local/remote sync. Local data stays in SQLite under
`~/.hasna/recordings/`; remote sync uses PostgreSQL when
`HASNA_RECORDINGS_DATABASE_URL` is set or `~/.hasna/recordings/storage/config.json` is
configured.

```bash
recordings storage status
recordings storage migrate
recordings storage push
recordings storage pull
```

`RECORDINGS_DATABASE_URL` is accepted as the non-Hasna fallback database URL.

## Data Directory

Data is stored in `~/.hasna/recordings/`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
