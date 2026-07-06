# @hasna/recordings

Speech-to-text recording tool with MCP and CLI — records, transcribes, and optionally enhances text using AI

[![npm](https://img.shields.io/npm/v/@hasna/recordings)](https://www.npmjs.com/package/@hasna/recordings)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/recordings
```

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
recordings-mcp --http              # default port 8829
MCP_HTTP=1 MCP_HTTP_PORT=8829 recordings-mcp
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

## Storage Sync

This package has native local/remote sync. Local data stays in SQLite under
`~/.hasna/recordings/`; remote sync uses PostgreSQL when
`HASNA_RECORDINGS_DATABASE_URL` is set or `~/.hasna/recordings/storage/config.json` is
configured.

The optional config file uses a `postgres` object:

```json
{
  "mode": "remote",
  "postgres": {
    "host": "db.example",
    "port": 5432,
    "username": "recordings",
    "password_env": "RECORDINGS_DATABASE_PASSWORD",
    "ssl": true
  }
}
```

```bash
recordings storage status
recordings storage migrate
recordings storage push
recordings storage pull
```

`RECORDINGS_DATABASE_URL` is accepted as the non-Hasna fallback database URL.
`HASNA_RECORDINGS_STORAGE_CONFIG` can point automation at a non-default storage
config file.

## Data Directory

Data is stored in `~/.hasna/recordings/`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
