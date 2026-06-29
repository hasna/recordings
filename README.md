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

## Data Directory

Data is stored in `~/.hasna/recordings/`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
