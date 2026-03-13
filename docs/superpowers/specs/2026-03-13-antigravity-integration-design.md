# Antigravity Integration Design

**Date:** 2026-03-13
**Status:** Approved
**Goal:** Fix and complete the Antigravity integration so that context is injected at session start and session data is captured at session end — matching the quality of the Claude Code and Codex integrations.

---

## Background

Antigravity is Google's rebranding of Windsurf (by Codeium, acquired by Google). Its AI engine is called Cascade. It is a VS Code-based GUI editor with a `chat` CLI subcommand. Key facts that drive the design:

- `antigravity chat "prompt"` sends the prompt to a running Electron GUI instance via IPC and **exits almost immediately** — it does not block until the session ends
- MCP is supported via `~/.config/Antigravity/User/mcp.json` (format: `{ "servers": { ... } }`) — already configured by the setup wizard
- Antigravity has **no hooks API** (no PostToolUse equivalent like Claude Code)
- Chat sessions are persisted in `~/.config/Antigravity/User/workspaceStorage/<hash>/state.vscdb` under the key `chat.ChatSessionStore.index`
- Per-workspace rules are read from `.windsurf/rules/*.md` (Windsurf convention inherited by Antigravity)

### What the Previous Implementation Got Wrong

1. **Rules file written to `.agent/rules/`** — Antigravity does not read this path. The correct path is `.windsurf/rules/`.
2. **Session end triggered by CLI process exit** — the CLI exits fast (before any AI response), so `toolProc.on("exit")` fires before any useful data exists.
3. **No post-hoc session reader** — unlike Claude (JSONL) and Codex (SQLite), there was no mechanism to read what Cascade actually said/did during the session.

---

## Architecture

Three concrete changes to the existing codebase:

### 1. New file: `src/wrapper/antigravity.ts`

Post-hoc session reader. Called at true session end (Electron GUI exit). Responsibilities:

- `findWorkspaceHash(cwd)`: scans `~/.config/Antigravity/User/workspaceStorage/*/workspace.json`, finds the entry whose `folder` field (a `file://` URI) matches `cwd`, returns the hash directory name
- `readAntigravitySession(cwd, sessionStartMs)`: opens the matched `state.vscdb`, reads `chat.ChatSessionStore.index`, filters sessions/messages created after `sessionStartMs`, returns `Message[]`
- Returns `{ messages: Message[] }` — no events (tool call details are not exposed post-hoc; events come from MCP `store_event` calls only)

### 2. Modified: `src/wrapper/index.ts`

Three changes:

**a) `injectAntigravityContext` — fix rules path:**
- Write to `.windsurf/rules/llm-memory.md` (primary — what Antigravity actually reads)
- Also write to `.agent/rules/llm-memory.md` (fallback — in case future versions support it)
- Rules file content: project memory from previous sessions + MCP instructions (session_id, project_id, how to call `record_turn`)

**b) `findAntigravityElectronPid(cwd)` — new function:**
- Searches running processes for an Antigravity Electron process
- Matches by workspace path in process args or by `--user-data-dir`
- Returns the PID, or `null` if not found

**c) Session lifetime tracking:**
- After the CLI child process exits quickly, call `findAntigravityElectronPid(cwd)`
- If a PID is found: poll every 2 seconds until it exits, then fire `signalSessionEnd()`
- If no PID found: fire `signalSessionEnd()` immediately (treat CLI exit as session end)
- `signalSessionEnd()` for Antigravity calls `readAntigravitySession(cwd, sessionStartMs)` and seeds messages buffer if MCP captured nothing

### 3. No changes needed elsewhere

- MCP handlers already accept `tool: "antigravity"` and handle `record_turn` / `store_message`
- DB schema, Layer 1/2/3 pipeline, CLI setup wizard — all unchanged
- `mcp.json` registration already correct

---

## Data Flow

```
antigravity chat "prompt"
        │
   [wrapper: injectAntigravityContext(cwd, projectId, sessionId)]
        ├─ writes .windsurf/rules/llm-memory.md   (primary)
        └─ writes .agent/rules/llm-memory.md      (fallback)
        │
   [wrapper: createSession() in DB]
        │
   [wrapper: spawns CLI child — exits fast]
        │
   [wrapper: findAntigravityElectronPid(cwd)]
        │
        ├─ PID found → poll every 2s until Electron exits
        └─ PID not found → treat CLI exit as session end
        │
   [meanwhile: Cascade reads rules file]
        ├─ calls get_project_memory MCP tool at session start
        └─ calls record_turn / store_message during session (live capture)
        │
   [Electron GUI exits (window closed / killed / crashed)]
        │
   [signalSessionEnd()]
        ├─ readAntigravitySession(cwd, sessionStartMs)
        │       ├─ find workspaceStorage hash for cwd
        │       ├─ read state.vscdb → chat.ChatSessionStore.index
        │       └─ filter entries created after sessionStartMs → Message[]
        │
        ├─ if messageBuffer empty AND reader returned messages → seedBuffers()
        │
        └─→ handleEndSession() → Layer1→2→3 pipeline → digest + memory_doc written
```

---

## Error Handling

All reader and injection logic is best-effort — never throws, never blocks the session.

| Scenario | Behavior |
|---|---|
| `state.vscdb` not found (no workspace match) | Skip post-hoc read; rely on MCP-captured messages only |
| `state.vscdb` parse/read error | Log warning, return `[]` |
| No sessions newer than `sessionStartMs` | Return `[]`; pipeline still runs with MCP data |
| Rules write fails (permissions, read-only fs) | Log warning, continue — session still works via MCP |
| Electron PID not found | Fire session end immediately on CLI exit |
| Multiple Antigravity windows open | Match by workspace path; if ambiguous, use most recently started |
| Electron already exited before PID lookup | Treat as immediate session end |
| SIGKILL (uncatchable) | Best-effort only — pipeline may not fire; MCP-captured data already in DB |

---

## Testing

### New: `tests/wrapper/antigravity.test.ts`

- `findWorkspaceHash`: temp dir with mock `workspace.json` files → returns correct hash for matching `cwd`, returns `null` for no match
- `readAntigravitySession`: mock `state.vscdb` with known `chat.ChatSessionStore.index` JSON → correct `Message[]` filtered by `sessionStartMs`
- Empty `entries` → returns `[]`
- Malformed JSON in DB → returns `[]` without throwing

### Extended: `tests/wrapper/index.test.ts`

- `injectAntigravityContext` writes to both `.windsurf/rules/llm-memory.md` AND `.agent/rules/llm-memory.md`
- `findAntigravityElectronPid`: tested with injected mock process list (function accepts a process-list provider for testability)

### No new integration test

The existing session pipeline integration test covers Layer1→2→3. The Antigravity reader feeds into the same `seedBuffers` path already tested by the Codex integration path.

---

## Files Changed

| File | Change |
|---|---|
| `src/wrapper/antigravity.ts` | **New** — `findWorkspaceHash`, `readAntigravitySession` |
| `src/wrapper/index.ts` | Fix `injectAntigravityContext` paths; add `findAntigravityElectronPid`; fix session lifetime tracking |
| `tests/wrapper/antigravity.test.ts` | **New** — unit tests for reader functions |
| `tests/wrapper/index.test.ts` | Extend with new Antigravity wrapper tests |
