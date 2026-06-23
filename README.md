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

The app's **Transcription Cleanup** setting controls the same post-processing pipeline as
the CLI and MCP server. Use **Raw** to keep verbatim text only, **Auto** to clean up only
when trigger phrases or instruction patterns are detected, or **Always** to run the
transcriber cleanup prompt for every recording. Global cleanup instructions can be set in
Settings, and project-specific instructions are appended when a project is active.

## CLI Usage

```bash
recordings --help
```

- `recordings record`
- `recordings transcribe <file>`
- `recordings transcribe <file> --stream`
- `recordings transcribe <file> --prompt "DALL-E, Hasna, gpt-4o"`
- `recordings transcribe <file> --transcriber-prompt "Clean up punctuation only" --post-processing always`
- `recordings rewrite <text> --instruction "<instruction>"`
- `recordings list`
- `recordings show <id>`
- `recordings search <query>`
- `recordings delete <id>`
- `recordings stats`

### Transcription Prompts

Recordings separates speech-to-text context from post-transcription cleanup:

- `--prompt` / `transcription_prompt` is passed to the OpenAI audio transcription
  request as vocabulary or context. Use it for names, acronyms, technical terms, or
  preceding segment context.
- `--transcriber-prompt` / `transcriber_prompt` is used after raw transcription by the
  text transcriber pipeline. Use it for cleanup, formatting, tone, summaries, or
  transformations.
- `--post-processing off|auto|always` controls whether cleanup runs. `--no-enhance` is a
  compatibility alias for `off`.

Examples:

```bash
# Verbatim dictation, no cleanup
recordings transcribe meeting.wav --post-processing off

# Better STT recognition for names and acronyms, still verbatim
recordings transcribe demo.wav --prompt "Hasna, Alumia, DALL-E, gpt-4o"

# Always clean up punctuation and paragraphs after raw transcription
recordings transcribe note.wav \
  --post-processing always \
  --transcriber-prompt "Fix punctuation and paragraph breaks. Preserve the speaker's meaning."

# Auto mode only cleans up when the transcript asks for it, such as "say it better"
recordings transcribe draft.wav --post-processing auto
```

Persistent config can be stored in `~/.hasna/recordings/config.json` or a project-local
`.recordings/config.json`:

```json
{
  "transcription_prompt": "Hasna, Alumia, gpt-4o",
  "transcriber_prompt": "Clean up grammar and format as concise Markdown notes.",
  "post_processing_mode": "always",
  "enhancement_model": "gpt-4o"
}
```

Environment overrides are also supported:

```bash
export RECORDINGS_TRANSCRIPTION_PROMPT="Hasna, DALL-E, gpt-4o"
export RECORDINGS_TRANSCRIBER_PROMPT="Format as polished meeting notes"
export RECORDINGS_POST_PROCESSING_MODE=always
export RECORDINGS_TRANSCRIBER_MODEL=gpt-4o
```

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

For MCP, `transcribe_audio` accepts `transcription_prompt` (or legacy `prompt`) for STT
context, `transcriber_prompt` for cleanup instructions, and `post_processing_mode` with
`off`, `auto`, or `always`. Tool results preserve `raw_text` and return `processed_text`
only when post-processing actually produced enhanced output.

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
