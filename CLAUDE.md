# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A fully local CLI tool giving coding agents (Claude Code, Codex, Gemini CLI, OpenCode) persistent memory across sessions. When a new session starts in a project, the agent automatically knows what was worked on before, what decisions were made, what errors were hit, and what files were touched — without re-explaining anything. Zero cloud, zero telemetry. Everything lives in `~/.llm-memory/store.db`.

**End-to-end flow:**
1. Shell wrapper intercepts `claude` (or codex/gemini/opencode), detects project via git remote/path, sets env vars, spawns real agent as child process
2. MCP server starts alongside — injects a tiny context header (~30 tokens), exposes `search_context()` and `get_project_memory()` tools
3. During session: hooks fire on every tool call (file edits, bash commands, etc.), messages buffered in memory
4. On session end (clean/Ctrl-C/crash): Layer 1 → Layer 2 → Layer 3 pipeline runs, embedding stored, next session can retrieve all of it

## Build Plan Status

```
Step 1  ✅  Project scaffold + dependencies
Step 2  ✅  Shared types
Step 3  ✅  Database layer (schema, CRUD, vector search, orphan sweep)
Step 5  ✅  Structural feature extractor
Step 6  ✅  Keyword scorer + dictionaries
Step 7  ✅  Positional analyzer
Step 8  ✅  Pattern detector
Step 9  ✅  TF-IDF keyword extractor
Step 10 ✅  Tool event classifier
Step 11 ✅  Weight combiner → Layer1Output
Step 12 ✅  Layer 2 digest generator
Step 13 ✅  Layer 3 project memory merger
Step 14 ✅  Embedding: MiniLM + sqlite-vec
Step 15 ✅  MCP server (5 tools + session end handler) — src/mcp/handlers.ts + src/mcp/index.ts
Step 16 ✅  Integration test — tests/integration/session.test.ts
Step 17 ✅  Shell wrapper — src/wrapper/{detect,project,index}.ts
Step 18 ✅  Per-tool hook plugins — src/hooks/{receiver,claude,gemini,opencode,index}.ts
Step 19 ✅  CLI wizard — src/cli/index.ts (detectInstalledTools, createWrapperSymlink, injectPathLine, forgetProject, getAllProjects + bin entry)
```

**Phase 2** (after Phase 1 validated): shell wrappers per-tool, CLI wizard (`npm install -g`), per-tool hook plugins.

**Validation gates before Phase 2:** Layer 1 weights make sense on real transcripts, digest is useful as context, project memory stays coherent across 5 sequential merges, MCP tools respond <10ms (search_context <50ms), orphan sweep works correctly.

## Commands

```bash
# Build
npm run build        # tsc compile to dist/
npm run dev          # tsc --watch

# Test
npm test             # vitest (watch mode)
npm run test:run     # vitest run (CI/single-shot)

# Run a single test file
npx vitest run tests/layer1/structural.test.ts

# Run MCP server
npm run mcp          # node dist/mcp/index.js
```

The DB path defaults to `~/.llm-memory/store.db` and can be overridden with `LLM_MEMORY_DB_PATH`.

## Live E2E Testing

The preferred way to validate changes is live real-time testing — run an actual tool session through the wrapper and inspect the DB. Do NOT just run unit tests; unit tests don't verify the pipeline actually works end-to-end.

```bash
# Test project (isolated, has git remote)
cd /tmp/llm-memory-livetest

# Claude — verify MCP tools are connected
~/.llm-memory/bin/claude -p "List all MCP tools from the llm-memory server. If none, say MCP NOT CONNECTED."

# Claude — verify context injection (prior sessions visible)
~/.llm-memory/bin/claude -p "What do you know about this project from previous sessions? List everything from your memory context."

# Codex — verify MCP tools are connected
~/.llm-memory/bin/codex exec "List all MCP tools from the llm-memory server. If none, say MCP NOT CONNECTED."

# Check DB after a session
sqlite3 ~/.llm-memory/store.db "SELECT id, tool, outcome FROM sessions ORDER BY started_at DESC LIMIT 5;"
sqlite3 ~/.llm-memory/store.db "SELECT content FROM messages_raw ORDER BY rowid DESC LIMIT 5;"
sqlite3 ~/.llm-memory/store.db "SELECT substr(summary,1,100) FROM digests ORDER BY rowid DESC LIMIT 3;"
```

After every code change: build (`npm run build`), then run the relevant live test above before committing.

## Architecture

This project is a persistent memory layer for LLM coding tools (Claude Code, Codex, Gemini, etc.) backed by SQLite and exposed via MCP. It processes session data through a three-layer pipeline before storing it.

### Three-Layer Pipeline

```
Messages + Tool Events
        │
   [Layer 1] src/layer1/       — pure, no I/O
        ├── structural.ts      — feature extraction per message
        ├── positional.ts      — weight by position in conversation
        ├── keywords.ts        — keyword scoring & category classification
        ├── tfidf.ts           — TF-IDF keyword extraction
        ├── patterns.ts        — conversation pattern detection
        ├── events.ts          — tool event → ExtractedEvent
        └── combiner.ts        — assembles Layer1Output (main entry point)
        │
        ▼ Layer1Output (never stored, in-memory contract)
        │
   [Layer 2] src/layer2/
        └── digest.ts          — compresses to Layer2Digest (≤500 tokens), stored in DB
        │
        ▼ Layer2Digest
        │
   [Layer 3] src/layer3/
        └── memory.ts          — merges digest into ProjectMemory, serializes/deserializes markdown
```

- **Layer 1** (`processSession`): pure function — takes `Message[]` + `RawToolEvent[]`, returns `Layer1Output`. Never stored.
- **Layer 2** (`generateDigest`): pure function — compresses Layer1Output to ≤500 tokens. Stored in `digests` table.
- **Layer 3** (`mergeIntoProjectMemory`, `serializeMemory`, `deserializeMemory`): pure functions — merges digest into `ProjectMemory`, serializes to markdown stored in `projects.memory_doc`.

### Database (`src/db/`)

Single shared `db` instance from `src/db/connection.ts`. All other modules import from `src/db/index.ts` only. Schema is created at startup via `db.exec()` in `connection.ts`.

Key tables: `projects`, `sessions`, `events`, `digests`, `messages_raw`, `known_issues`, `recent_work`, `config`.

Vector search uses the `sqlite-vec` extension with a `session_embeddings` virtual table (384-dim, all-MiniLM-L6-v2 embeddings).

### Types (`src/types/`)

All types are imported from `src/types/index.ts` only — never from sub-files directly. Runtime Zod schemas for validation are exported alongside TypeScript types from `config.ts`.

### Key Design Constraints

- All Layer 1, 2, and 3 functions are **pure** — no I/O, no side effects, never throw.
- Digests must stay **under 500 tokens** (`estimated_tokens`).
- Layer 3 project memory keeps at most 10 `recent_work` entries and 20 `conventions`.
- `sessions.keywords` and JSON array columns are stored as JSON strings in SQLite.
- `NodeNext` module resolution: all local imports must use `.js` extensions.
