# Live E2E Test — Found Issues

Discovered during live session testing on 2026-04-24.

---

## Issue 1 — Context injection for Claude is silently dead

Claude never sees memory from previous sessions. The session-start hook script exists at
`~/.ctx-memory/bin/session-start` and produces correct output when run manually, but it is
not registered in `~/.claude/settings.json`. The wrapper also does not register it at runtime.
So Claude starts every session with no prior context.

**Status:** Fixed — root cause was `ctx-memory setup` wizard never having been run. Running
setup writes the SessionStart hook into `~/.claude/settings.json`. Verified: session correctly
listed all prior sessions in context.

---

## Issue 2 — MCP sidecar for Claude never connects

The wrapper spawns an MCP stdio server as a child process alongside Claude, but passes no
`--mcp-config` flag to Claude. Claude has no way to discover or connect to the sidecar.
All MCP tools (`store_message`, `get_project_memory`, `end_session`, etc.) are unreachable
from within Claude sessions. The sidecar starts and immediately becomes a zombie.

**Status:** Fixed — wrapper now writes a temp `~/.ctx-memory/session-<id>.mcp.json` and
injects `--mcp-config <path>` into Claude's args. Claude spawns and manages the MCP server
itself with proper stdio pipes. Verified: Claude lists all 7 ctx-memory MCP tools live.

---

## Issue 3 — Codex has no MCP connection

Codex uses TOML config (`~/.codex/config.toml`) and has no `--mcp-config` flag like Claude.
The setup wizard never wrote any MCP entry for Codex, so all ctx-memory MCP tools were
unreachable from Codex sessions.

**Status:** Fixed — setup wizard now writes a `[mcp_servers.ctx-memory]` block into
`~/.codex/config.toml` with `env_vars` forwarding the session context. Verified live:
Codex exec lists all 7 ctx-memory MCP tools.

---

## Issue 4 — Hook receiver never fires for Claude

No `PostToolUse` hook pointing to `~/.ctx-memory/bin/hook-receiver` is registered in
`~/.claude/settings.json`. Tool events (file edits, bash commands) are never captured via
hooks. The system falls back entirely to the JSONL reader at session end, which only gives
a post-hoc snapshot with no real-time event stream.

**Status:** Not an issue — hooks are firing correctly. After running `ctx-memory setup`,
the PostToolUse hook is registered. Verified live: `events` table shows `source: hook`
entries for bash commands and file writes captured in real-time during the test session.
