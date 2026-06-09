# ctx-memory

> Persistent memory for LLM coding agents — zero cloud, zero telemetry.

[![CI](https://github.com/GhadiSaab/ctx-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/GhadiSaab/ctx-memory/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ctx-memory.svg)](https://www.npmjs.com/package/ctx-memory)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/GhadiSaab/ctx-memory/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-blue.svg)](https://www.typescriptlang.org/)

When you start a new session, the agent already knows what you worked on last time: decisions made, files touched, errors hit, conventions learned. Everything lives in a local SQLite database at `~/.ctx-memory/store.db`.

## Supported Tools

| Tool | Integration | Status |
|---|---|---|
| [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) | Hooks + MCP sidecar + context injection | ✅ Full |
| [OpenAI Codex](https://openai.com/index/codex-cli/) | Post-hoc session analysis | ✅ Full |
| [Gemini CLI](https://ai.google.dev/gemini-cli) | Hooks + context injection | ✅ Full |
| [OpenCode](https://opencode.ai) | MCP sidecar + AGENTS.md injection | ✅ Full |

## Quick Start

```bash
# Install globally
npm install -g ctx-memory

# Run the interactive setup wizard
ctx-memory setup
```

The setup wizard:
1. Detects which tools are installed (`claude`, `codex`, `gemini`, `opencode`)
2. Asks which ones to integrate
3. Writes hook configs for each selected tool
4. Creates wrapper symlinks in `~/.ctx-memory/bin/`
5. Adds `~/.ctx-memory/bin` to your PATH via `~/.bashrc` / `~/.zshrc`

Restart your shell (or `source ~/.bashrc`), then use your tools as normal — memory is automatic.

## How It Works

A shell wrapper intercepts your coding tool, spawns an MCP sidecar, and runs a three-layer processing pipeline when the session ends:

```
┌─────────────────────────────────────────────────────────────────┐
│                    ctx-memory Pipeline                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Session Starts                                                 │
│       │                                                         │
│       ▼                                                         │
│  ┌───────────────────────────────────────┐                     │
│  │  Shell Wrapper                        │                     │
│  │  • Intercepts tool binary             │                     │
│  │  • Detects project (git/path)         │                     │
│  │  • Spawns MCP sidecar                 │                     │
│  └───────────────────┬───────────────────┘                     │
│                      │                                          │
│                      ▼                                          │
│  ┌───────────────────────────────────────┐                     │
│  │  MCP Server (sidecar)                 │                     │
│  │  • Injects prior context (~30 tokens) │                     │
│  │  • Exposes memory tools to agent      │                     │
│  │  • Buffers messages & events live     │                     │
│  └───────────────────┬───────────────────┘                     │
│                      │                                          │
│                      ▼  (session ends)                          │
│  ┌───────────────────────────────────────┐                     │
│  │  Layer 1: Process                     │                     │
│  │  • Extract features from messages     │                     │
│  │  • Score keywords, detect patterns    │                     │
│  │  • Classify tool events               │                     │
│  │  • Combine → Layer1Output (in-memory) │                     │
│  └───────────────────┬───────────────────┘                     │
│                      │                                          │
│                      ▼                                          │
│  ┌───────────────────────────────────────┐                     │
│  │  Layer 2: Compress                    │                     │
│  │  • Compress to ≤500-token digest      │                     │
│  │  • Store in SQLite + embeddings       │                     │
│  └───────────────────┬───────────────────┘                     │
│                      │                                          │
│                      ▼                                          │
│  ┌───────────────────────────────────────┐                     │
│  │  Layer 3: Merge                       │                     │
│  │  • Merge digest into Project Memory   │                     │
│  │  • Serialize to markdown              │                     │
│  └───────────────────────────────────────┘                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Key constraint:** All Layer 1/2/3 functions are pure — no I/O, no side effects, never throw.

## Usage

```bash
# Interactive setup (first time)
ctx-memory setup

# Check status and configuration
ctx-memory status

# List all tracked projects
ctx-memory projects list

# View full memory doc for a project
ctx-memory projects show myproject

# Reset project memory (keeps session history)
ctx-memory projects forget myproject

# Nuke everything for a project
ctx-memory projects forget myproject --hard
```

### Using with the MCP Server Standalone

To use the MCP server with Claude Code without the wrapper, add this to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "ctx-memory": {
      "command": "node",
      "args": ["/path/to/ctx-memory/dist/src/mcp/index.js"]
    }
  }
}
```

### MCP Tools

| Tool | Description |
|---|---|
| `store_message` | Buffer a conversation message for processing at session end |
| `store_event` | Record a tool call event (file edit, bash command, etc.) |
| `search_context` | Search past sessions by semantic similarity or keywords |
| `get_project_memory` | Return the full project memory document |
| `list_sessions` | List recent sessions with goals and outcomes |
| `end_session` | Finalize a session and run the Layer 1 → Layer 2 → Layer 3 pipeline |

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CTX_MEMORY_DB_PATH` | `~/.ctx-memory/store.db` | Path to the SQLite database |

### Storage

All data is stored locally in a single SQLite database using WAL mode with foreign keys enabled. Vector search uses the `sqlite-vec` extension with **all-MiniLM-L6-v2** embeddings (384-dimensional).

### Project Resolution

Projects are resolved by:
1. **Path hash** — unique per project directory
2. **Git remote** — fallback for cross-machine consistency

This prevents cross-project pollution and ensures your work on different repos stays separate.

## Architecture

```
src/
  cli/        — setup wizard, status, projects commands
  db/         — SQLite schema + CRUD (projects, sessions, events, digests, memory)
  layer1/     — pure message/event processing → weighted Layer1Output
  layer2/     — digest compression to ≤500 tokens → Layer2Digest
  layer3/     — merge digest into ProjectMemory markdown
  mcp/        — MCP server (handlers + stdio entry point)
  wrapper/    — shell wrapper (intercepts tool invocation, manages session lifecycle)
  hooks/      — hook config writers for Claude / Gemini / OpenCode
  types/      — shared TypeScript types + Zod runtime schemas
```

## Development

### Prerequisites

- Node.js 18+
- npm 9+

### Setup

```bash
git clone https://github.com/GhadiSaab/ctx-memory.git
cd ctx-memory
npm install
```

### Build & Test

```bash
npm run build          # Compile TypeScript to dist/
npm run dev            # Watch mode (tsc --watch)
npm run lint           # ESLint (zero warnings)

npm run test:run       # Run all tests (450+ tests, single-shot)
npm test               # Watch mode (vitest)
npx vitest run tests/path/to/file.test.ts  # Run a single test file
```

### Live E2E Testing

The preferred way to validate changes is **live real-time testing** — run an actual tool session through the wrapper and inspect the database:

```bash
# Set up a test project
cd /tmp/ctx-memory-livetest
git init && git remote add origin https://example.com/test.git

# Test Claude — verify MCP tools are connected
~/.ctx-memory/bin/claude -p "List all MCP tools from the ctx-memory server."

# Test Claude — verify context injection
~/.ctx-memory/bin/claude -p "What do you know about this project from previous sessions?"

# Inspect the database after a session
sqlite3 ~/.ctx-memory/store.db \
  "SELECT id, tool, outcome FROM sessions ORDER BY started_at DESC LIMIT 5;"
```

### Run MCP Server Standalone

```bash
npm run mcp    # node dist/src/mcp/index.js
```

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Write tests for your changes
4. Run `npm run test:run` to verify all tests pass
5. Run `npm run lint` to check code style
6. Commit and push your changes
7. Open a [Pull Request](https://github.com/GhadiSaab/ctx-memory/pulls)

See our [issue templates](https://github.com/GhadiSaab/ctx-memory/issues/new/choose) for reporting bugs or requesting features.

## License

[MIT](LICENSE) — Ghadi Saab
