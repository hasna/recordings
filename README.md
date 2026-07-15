# @hasna/recordings

Speech-to-text recording tool with MCP and CLI — records, transcribes, and optionally enhances text using AI

[![npm](https://img.shields.io/npm/v/@hasna/recordings)](https://www.npmjs.com/package/@hasna/recordings)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/recordings
```

## macOS App

Recordings ships a **full native macOS app** (SwiftUI, macOS 26 / Liquid Glass) with a
companion menu-bar control. It opens to a **Recordings workspace**: a narrow violet
Liquid-Glass sidebar (Workspace · Library · Projects · Modes · Machines) beside one
continuous canvas with the record hero, transcript library, and detail view. The menu bar
provides recording controls and access to the main window while it is in the background.

- **Record** — large push-to-talk / dictation / command hero with live transcription,
  duration, the active project, and a "just now" strip. Global shortcut (default F5, or
  hold fn) works while the window is in the background.
- **Library** — every past transcript (read straight from the active local or HTTP Store
  the CLI and MCP write), searchable and filterable by project, mode, and machine, with a
  detail pane (copy, paste-into-front-app, audio playback, metadata).
- **Projects** — app projects are registered through the same canonical Store before a
  recording can reference them, preserving referential integrity in local and remote modes.
- **Settings** (⌘,) — OpenAI key, language, recording shortcut, permissions, projects,
  and voice shortcuts.

The app embeds a same-version `recordings` CLI as its data layer, so the CLI, MCP, and app
share one store without depending on a possibly stale global CLI installation.

```bash
# Install an already signed and notarized artifact without changing its signature:
recordings app install --app-source /path/to/Recordings.app --launch

# The first migration from an ad-hoc or different signing identity is explicit:
recordings app install --app-source /path/to/Recordings.app \
  --allow-signing-identity-migration --launch

recordings app open           # launch it
recordings app status         # show install state

# Local debug builds are ad-hoc signed and do not preserve TCC grants across replacements:
recordings app install --mode debug

# Production release builds require a Developer ID identity and a notarytool keychain profile:
cd src/native/Recordings
RECORDINGS_CODESIGN_IDENTITY="Developer ID Application: ..." \
RECORDINGS_NOTARY_KEYCHAIN_PROFILE="recordings-notary" ./build.sh release
swift test                    # run the native test suite
```

The canonical install location is `~/Applications/Recordings.app`. Release installation
verifies the bundle identifier, Developer ID signature, Gatekeeper assessment, and signing
compatibility with the installed app. Migrating once from an ad-hoc build to the stable release
identity requires approving Microphone and Accessibility again; compatible signed updates do not
reset those permissions. The installer never calls `tccutil reset` automatically.

Requires macOS 26+; source builds also require a Swift toolchain (Xcode or Command Line Tools).
Set the OpenAI API key in **Settings** or via `recordings` config;
transcription/enhancement use it.

The app's **Transcription Cleanup** setting controls the same post-processing pipeline as
the CLI and MCP server. Use **Raw** to keep verbatim text only, **Auto** to clean up only
when trigger phrases or instruction patterns are detected, or **Always** to run the
transcriber cleanup prompt for every recording. Global cleanup instructions can be set in
Settings, and project-specific instructions are appended when a project is active.

The native app uses OpenAI realtime transcription for the stop-and-paste path: settled
`gpt-realtime-whisper` text is saved and pasted immediately, while full-file
`gpt-4o-transcribe` remains the bounded quality fallback when realtime is empty,
unsettled, or cannot be saved. Raw and processed transcript fields are still stored
separately, so cleanup instructions never replace the verbatim transcript.

## CLI Usage

```bash
recordings --help
```

- `recordings record`
- `recordings transcribe <file>`
- `recordings transcribe <file> --stream`
- `recordings transcribe <file> --prompt "DALL-E, Hasna, gpt-4o"`
- `recordings transcribe <file> --transcriber-prompt "Clean up punctuation only" --post-processing always`
- `recordings save-text --text-file transcript.txt --source realtime_fast_path`
- `recordings rewrite <text> --instruction "<instruction>"`
- `recordings list --limit 20 --cursor 0`
- `recordings list --verbose`
- `recordings show <id>` / `recordings inspect <id>`
- `recordings search <query> --limit 20 --cursor 0`
- `recordings delete <id>`
- `recordings stats`

### Compact Output

Agent-facing list commands are compact by default. Terminal output shows bounded
rows, short text previews, totals, pagination cursors, and the next detail command
instead of dumping full recording objects.

```bash
recordings list                 # compact rows, default limit 20
recordings list --cursor 20     # next page
recordings list --verbose       # more metadata, still no full transcript dump
recordings show <id>            # full recording detail
recordings inspect <id>         # alias for show
recordings --json list -n 100   # machine-readable records for integrations
```

Terminal list output is capped at 50 rows. JSON list output preserves complete
recording objects and accepts up to 500 rows per page.

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
export RECORDINGS_MODEL=gpt-4o-transcribe
export RECORDINGS_REALTIME_SESSION_MODEL=gpt-realtime
export RECORDINGS_REALTIME_TRANSCRIPTION_MODEL=gpt-realtime-whisper
```

`RECORDINGS_MODEL` is the bounded file-transcription model. Realtime session and realtime
transcription models are separate slots; `recordings check --json` reports all three and
includes `config_warnings` if a model is placed in the wrong slot.

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

## HTTP API (`recordings-serve`)

`recordings-serve` is the self-hosted HTTP API. In cloud mode it is PURE REMOTE
(Amendment A1): the process reads/writes the shared cloud Postgres directly with
API-key auth via [`@hasna/contracts`](https://www.npmjs.com/package/@hasna/contracts).

```bash
recordings-serve --port 8874          # start the API
recordings-serve migrate              # apply the cloud schema, then exit
```

Service surface (unauthenticated): `GET /health`, `GET /ready`, `GET /version`
(each returns `{status, version, mode}`), and `GET /openapi.json` (the OpenAPI
3.1 document the SDK is generated from).

Versioned API (`/v1/*`, API-key auth via `x-api-key` or `Authorization: Bearer`):

| Method | Path | Scope |
| ------ | ---- | ----- |
| GET/POST | `/v1/recordings` | `recordings:read` / `recordings:write` |
| GET/DELETE | `/v1/recordings/:id` | `recordings:read` / `recordings:write` |
| GET | `/v1/stats` | `recordings:read` |
| GET/POST | `/v1/agents` · GET `/v1/agents/:id` | `recordings:read` / `recordings:write` |
| GET/POST | `/v1/projects` · GET `/v1/projects/:id` | `recordings:read` / `recordings:write` |

Env: `HASNA_RECORDINGS_DATABASE_URL` (remote Postgres DSN — enables cloud `/v1`)
and `HASNA_RECORDINGS_API_SIGNING_KEY` (HMAC signing secret for API-key auth).

## SDK

The typed `/v1` client is generated from the serve OpenAPI document
(`bun run generate:sdk`):

```ts
import { RecordingsV1Client } from "@hasna/recordings/sdk";

const client = new RecordingsV1Client({
  baseUrl: process.env.RECORDINGS_API_URL!,
  apiKey: process.env.RECORDINGS_API_KEY!,
});
const { recordings } = await client.listRecordings({ limit: 20 });
```

Useful agent tools include `recordings_status` for safe service/config diagnostics,
`transcribe_audio`, `save_recording`, `list_recordings`, `search_recordings`,
`register_agent`, `heartbeat`, and `set_focus`.

MCP `list_recordings` and `search_recordings` are compact by default. Compact output
is capped at 50 rows, `full=true` metadata rows are capped at 10, previews remain
bounded, and results include next-cursor hints. Use `get_recording { id }` for full
transcript details.

For MCP, `transcribe_audio` accepts `transcription_prompt` (or legacy `prompt`) for STT
context, `transcriber_prompt` for cleanup instructions, and `post_processing_mode` with
`off`, `auto`, or `always`. Tool results preserve `raw_text` and return `processed_text`
only when post-processing actually produced enhanced output.

## Data Directory

Data is stored in `~/.hasna/recordings/`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
