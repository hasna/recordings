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
- `recordings list`
- `recordings show <id>`
- `recordings search <query>`
- `recordings delete <id>`
- `recordings stats`

## MCP Server

```bash
recordings-mcp
```

17 tools available.

## Cloud Sync

This package supports cloud sync via `@hasna/cloud`:

```bash
cloud setup
cloud sync push --service recordings
cloud sync pull --service recordings
```

## Data Directory

Data is stored in `~/.hasna/recordings/`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
