# Live E2E Test — Found Issues

Discovered during live session testing on 2026-04-24.

---

## Issue 1 — Context injection for Claude is silently dead

Claude never sees memory from previous sessions. The session-start hook script exists at
`~/.llm-memory/bin/session-start` and produces correct output when run manually, but it is
not registered in `~/.claude/settings.json`. The wrapper also does not register it at runtime.
So Claude starts every session with no prior context.

**Status:** Under investigation

---

## Issue 2 — MCP sidecar for Claude never connects

The wrapper spawns an MCP stdio server as a child process alongside Claude, but passes no
`--mcp-config` flag to Claude. Claude has no way to discover or connect to the sidecar.
All MCP tools (`store_message`, `get_project_memory`, `end_session`, etc.) are unreachable
from within Claude sessions. The sidecar starts and immediately becomes a zombie.

**Status:** Open

---

## Issue 3 — Codex `exec` subcommand is bypassed

`codex exec` is explicitly in the bypass list in `shouldBypass()`. The wrapper passes it
straight through with no session tracking, no AGENTS.md injection, and no pipeline run at exit.
Only interactive `codex` (no subcommand) goes through the full wrapper flow — but that requires
a real TTY and cannot be tested non-interactively.

**Status:** Open

---

## Issue 4 — Hook receiver never fires for Claude

No `PostToolUse` hook pointing to `~/.llm-memory/bin/hook-receiver` is registered in
`~/.claude/settings.json`. Tool events (file edits, bash commands) are never captured via
hooks. The system falls back entirely to the JSONL reader at session end, which only gives
a post-hoc snapshot with no real-time event stream.

**Status:** Open
