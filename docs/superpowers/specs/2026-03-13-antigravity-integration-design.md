# Antigravity Integration Design

**Date:** 2026-03-13
**Status:** Approved
**Goal:** Fix and complete the Antigravity integration so that context is injected at session start and session data is captured at session end — matching the quality of the Claude Code and Codex integrations.

---

## Background

Antigravity is Google's rebranding of Windsurf (by Codeium, acquired by Google). Its AI engine is called Cascade. It is a VS Code-based GUI editor with a `chat` CLI subcommand. Key facts that drive the design:

- `antigravity chat "prompt"` sends the prompt to a running Electron GUI instance via IPC and **exits almost immediately** — it does not block until the session ends
- MCP is supported via `~/.config/Antigravity/User/mcp.json` (format: `{ "servers": { ... } }`) — already configured by the setup wizard. The Electron GUI process connects to this MCP server independently; it is **not** the wrapper's in-process stdio sidecar.
- Antigravity has **no hooks API** (no PostToolUse equivalent like Claude Code)
- Chat sessions (called "trajectories" internally) are persisted in `~/.config/Antigravity/User/workspaceStorage/<hash>/state.vscdb` under the key `chat.ChatSessionStore.index`
- Per-workspace rules are read from `.windsurf/rules/*.md` (Windsurf convention inherited by Antigravity)
- Cascade internally calls sessions "trajectories" and messages/steps "cortex steps"; the VS Code state DB stores a simplified view

### What the Previous Implementation Got Wrong

1. **Rules file written to `.agent/rules/`** — Antigravity does not read this path. The correct path is `.windsurf/rules/`.
2. **Session end triggered by CLI process exit** — the CLI exits fast (before any AI response), so `toolProc.on("exit")` fires before any useful data exists.
3. **No post-hoc session reader** — unlike Claude (JSONL) and Codex (SQLite), there was no mechanism to read what Cascade actually said/did during the session.
4. **Existing test for `injectAntigravityContext` asserts the wrong path** — it checks `.agent/rules/llm-memory.md` and must be updated.

---

## Architecture

Three concrete changes to the existing codebase:

### 1. New file: `src/wrapper/antigravity.ts`

Post-hoc session reader. Called at true session end (Electron GUI exit). Responsibilities:

- `findWorkspaceHash(storageDir, cwd)`: scans `<storageDir>/*/workspace.json` (default: `~/.config/Antigravity/User/workspaceStorage`), finds the entry whose `folder` field (a `file://` URI) matches `cwd`, returns the hash directory name or `null`
- `readAntigravitySession(cwd, sessionStartMs, storageDir?)`: opens the matched `state.vscdb`, reads `chat.ChatSessionStore.index`, filters messages with `timestamp >= sessionStartMs`, maps them to `Message[]`
- Returns `{ messages: Message[] }` — no events (tool call details not available post-hoc; events come from MCP `store_event` calls only)

`storageDir` defaults to `~/.config/Antigravity/User/workspaceStorage` but is injectable for testing.

**`chat.ChatSessionStore.index` schema** (inferred from VS Code chat storage conventions and Windsurf/Cascade internals):

```jsonc
{
  "version": 1,
  "entries": {
    "<sessionId>": {
      "sessionId": "<uuid>",
      "creationDate": 1741123200000,   // ms timestamp
      "requests": [
        {
          "message": {
            "text": "user prompt text",
            "parts": [{ "text": "user prompt text" }]
          },
          "response": {
            "value": [{ "value": "assistant response text" }]
          },
          "timestamp": 1741123210000   // ms timestamp on individual turn
        }
      ]
    }
  }
}
```

The reader maps each `requests` entry to two `Message` objects: `{ role: "user", content: request.message.text }` and `{ role: "assistant", content: request.response.value[0].value }`. Timestamp filtering uses `request.timestamp` (per-turn) if present, falling back to the session `creationDate`.

**Important:** this schema is inferred and must be validated against a real session on first real-world test. The reader must be written defensively — unknown shapes return `[]` without throwing.

### 2. Modified: `src/wrapper/index.ts`

**a) `injectAntigravityContext` — fix rules path and MCP instructions:**
- Write to `.windsurf/rules/llm-memory.md` (primary — what Antigravity actually reads)
- Also write to `.agent/rules/llm-memory.md` (fallback)
- **Rules file content must change:** remove `record_turn` instruction. `record_turn` auto-creates its own session ID, producing a duplicate disconnected session alongside the wrapper's session. Instead, instruct Cascade to use `store_message` with the exact `session_id` from the rules header if it wants to persist anything mid-session. The post-hoc `state.vscdb` reader is the primary capture path; `store_message` (not `record_turn`) is the supplementary MCP path. Remove the `record_turn` mention from the test expectation accordingly.

**b) `findAntigravityElectronPid(cwd, processList?)` — new function:**
- Accepts an optional `processList` provider `() => Array<{ pid: number; cmd: string }>` for testability (defaults to reading `/proc/*/cmdline` on Linux, `ps aux` output on other platforms)
- Searches for a process with `antigravity` in the command and the workspace `cwd` path (or `--user-data-dir` matching `~/.config/Antigravity`) in its args
- Returns `number | null`

**c) Session lifetime tracking — replace CLI exit trigger:**

The current `toolProc.on("exit")` handler calls `signalSessionEnd`, kills `mcpProc`, and calls `process.exit(code ?? 0)`. For Antigravity the CLI exits fast, so the handler must **not** call `process.exit()` immediately — instead it must keep the wrapper process alive while polling the Electron GUI PID. `setInterval` keeps the Node.js event loop alive automatically; there is no need for a keepalive reference.

```
toolProc.on("exit", async (code) => {
  if (tool !== "antigravity") {
    // existing behavior for all other tools
    await signalSessionEnd(...);
    mcpProc?.kill();
    process.exit(code ?? 0);
    return;
  }

  // Antigravity: CLI exits fast, poll the Electron GUI process
  const pid = findAntigravityElectronPid(cwd);
  if (pid === null) {
    await signalSessionEnd(...);
    process.exit(0);
    return;
  }

  const MAX_WAIT_MS = 8 * 60 * 60 * 1000; // 8 hours
  const POLL_INTERVAL_MS = 2000;
  const deadline = Date.now() + MAX_WAIT_MS;
  const poll = setInterval(async () => {
    const stillAlive = isProcessAlive(pid);
    const timedOut = Date.now() >= deadline;
    if (!stillAlive || timedOut) {
      clearInterval(poll);
      await signalSessionEnd(...);
      process.exit(0);
    }
  }, POLL_INTERVAL_MS);
});
```

**Wrapper process visibility:** while polling, the wrapper Node.js process remains alive in `ps` output. This is intentional — it is the session tracker. Users who notice it can ignore it; it exits automatically when the Antigravity window closes or after 8 hours.

`isProcessAlive(pid)`: sends signal 0 (`process.kill(pid, 0)`) — returns `true` if process exists, `false` if ESRCH.

The 8-hour timeout handles the case where a user keeps the window open all day. On timeout, the pipeline runs with whatever data exists.

**d) MCP sidecar: NOT spawned for Antigravity**
`supportsMcp` stays `tool === "claude" || tool === "opencode"`. Antigravity's MCP calls go to a separately-running `llm-memory` MCP server (configured via `mcp.json`), not the wrapper's in-process sidecar. This means live MCP capture goes directly to DB (via the standalone MCP server process) and does **not** use in-memory buffers. Consequence: `messageBuffers`/`eventBuffers` will always be empty for Antigravity — the `state.vscdb` post-hoc reader is the real data source. MCP calls from Cascade still persist to DB correctly via the standalone server.

### 3. `signalSessionEnd` — Antigravity branch in `src/wrapper/index.ts`

`signalSessionEnd` already has `if (tool === "codex")` and `if (tool === "claude")` branches that call their respective readers and seed buffers. The new Antigravity branch:

```typescript
if (tool === "antigravity") {
  try {
    const { messages } = await readAntigravitySession(cwd, sessionStartMs);
    if (messages.length > 0) {
      // Seed messages into the session buffer (events stay empty — no post-hoc events)
      seedBuffers(sessionId, messages, []);
    }
  } catch { /* best-effort */ }
}
```

No `classifyToolEvent` call needed (unlike Codex/Claude which may also seed events). The rest of `signalSessionEnd` — `loadEmbedder()` and `handleEndSession()` — runs unchanged after this branch.

### 4. No changes needed elsewhere

- MCP handlers, DB schema, Layer 1/2/3 pipeline, CLI setup wizard — all unchanged
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
   [wrapper: spawns CLI child — exits fast ~immediately]
        │
   [wrapper: findAntigravityElectronPid(cwd)]
        │
        ├─ PID found → start polling loop (max 8h)
        └─ PID not found → fire signalSessionEnd() immediately
        │
   [meanwhile: Cascade reads .windsurf/rules/llm-memory.md]
        ├─ calls get_project_memory MCP tool at session start (via standalone MCP server → DB)
        └─ may call store_message with exact session_id mid-session (→ DB directly, not via buffers)
        │   (record_turn is NOT used — it creates a duplicate disconnected session)
        │
   [Electron GUI exits OR 8h timeout]
        │
   [signalSessionEnd()]
        ├─ readAntigravitySession(cwd, sessionStartMs)
        │       ├─ find workspaceStorage hash for cwd
        │       ├─ read state.vscdb → chat.ChatSessionStore.index
        │       └─ filter entries with timestamp >= sessionStartMs → Message[]
        │
        ├─ messageBuffers.get(sessionId) is always empty for Antigravity
        │   → if reader returned messages, seed them as messages buffer
        │
        └─→ handleEndSession() → Layer1→2→3 pipeline → digest + memory_doc written
```

---

## Error Handling

All reader and injection logic is best-effort — never throws, never blocks the session.

| Scenario | Behavior |
|---|---|
| `state.vscdb` not found (no workspace hash match) | Skip post-hoc read; pipeline runs with empty messages |
| `state.vscdb` parse/read error | Log warning, return `[]` |
| Schema doesn't match expected shape | Return `[]` (defensive parsing) |
| No sessions newer than `sessionStartMs` | Return `[]`; pipeline still runs |
| Rules write fails (permissions, read-only fs) | Log warning, continue — MCP still works |
| Electron PID not found | Fire session end immediately on CLI exit |
| Multiple Antigravity windows open | Match by workspace path in process args; if ambiguous, skip polling (use CLI exit trigger) |
| Electron already exited before PID lookup | `isProcessAlive` returns false immediately → fire session end |
| SIGKILL (uncatchable) | Polling detects process gone within 2s → session end fires normally |
| 8-hour timeout | Fire session end with whatever data exists |

---

## Testing

### New: `tests/wrapper/antigravity.test.ts`

- `findWorkspaceHash`: temp dir with 3 mock `workspace.json` files → returns correct hash for matching `cwd`, returns `null` for no match, handles missing `folder` field
- `readAntigravitySession`: mock `state.vscdb` with known `chat.ChatSessionStore.index` JSON:
  - Returns correct `Message[]` (user + assistant pairs) filtered by `sessionStartMs`
  - Empty `entries` → returns `[]`
  - Malformed JSON / wrong schema → returns `[]` without throwing
  - Missing `response` on a request → skips that turn gracefully
- `findAntigravityElectronPid`: injected mock process list:
  - Finds correct PID when `antigravity` process with matching cwd exists
  - Returns `null` when no match

### Updated: `tests/wrapper/index.test.ts`

- **Update** existing `injectAntigravityContext` test: change path assertion from `.agent/rules/llm-memory.md` to `.windsurf/rules/llm-memory.md`
- **Add** assertion that `.agent/rules/llm-memory.md` is also written (fallback)
- **Update** content assertion: replace `expect(content).toContain("record_turn")` with `expect(content).toContain("store_message")` — `record_turn` is no longer instructed in the rules file

### No new integration test

The existing session pipeline integration test covers Layer1→2→3. The Antigravity reader feeds into the same `seedBuffers` path already covered by the Codex integration path tests.

---

## Files Changed

| File | Change |
|---|---|
| `src/wrapper/antigravity.ts` | **New** — `findWorkspaceHash`, `readAntigravitySession` |
| `src/wrapper/index.ts` | Fix `injectAntigravityContext` paths + rules content (remove `record_turn`); add `findAntigravityElectronPid`, `isProcessAlive`; replace CLI exit trigger with Electron PID polling loop; add Antigravity branch in `signalSessionEnd` |
| `tests/wrapper/antigravity.test.ts` | **New** — unit tests for reader and PID-finder |
| `tests/wrapper/index.test.ts` | Update existing `injectAntigravityContext` test (path + content assertions) + add fallback path assertion |

---

## Open Question (for first real-world test)

The `chat.ChatSessionStore.index` schema is inferred. On first real Antigravity chat session, inspect the actual JSON in `state.vscdb` and update `readAntigravitySession` to match the real field names. The defensive parser will return `[]` safely if the schema doesn't match — this just means no post-hoc messages until the schema is confirmed.
