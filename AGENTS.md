<!-- llm-memory: auto-generated, do not edit -->
# Project Memory (from previous sessions)

# Project Memory

## Architecture
- Persistent memory layer for LLM coding agents (Claude Code, Codex, Gemini, OpenCode) backed by SQLite + sqlite-vec, exposed via MCP
- Three-layer pipeline: Layer 1 (pure message/event processing) → Layer 2 (digest ≤500 tokens) → Layer 3 (project memory markdown merge)
- Shell wrapper intercepts tool binaries, spawns MCP sidecar (Claude/OpenCode only), runs pipeline on session end
- Claude: hooks fire live (PostToolUse) + JSONL reader seeds messages post-session
- Codex: post-hoc only — reads ~/.codex/state_5.sqlite + rollout JSONL after session ends
- OpenCode: MCP sidecar + AGENTS.md injection at startup
- AGENTS.md used for context injection for Codex and OpenCode (written before spawning tool)
- Non-interactive subcommands (update, mcp, login, etc.) bypass wrapper entirely via execFileSync
- You want OpenClaw (from Discord) to be able to act directly on your local files instead of only replying with paste-ready output. I’m checking your local OpenClaw/GSD setup to see exactly which permission boundary is blocking that and what to change safely.
- I successfully applied the config-side changes, but `openclaw approvals set` failed because its CLI syntax is different than expected. I’m switching to directly updating `~/.openclaw/exec-approvals.json`, then I’ll verify and restart gateway.
- Now I have the full picture. Here are all the problems:
- ---
- ## Problems Found
- ### 1. Project12 sessions go to wrong project ("ghadi")
- **Root cause:** `/home/ghadi` is a git repo (has `.git/`). When you run `claude` from `/home/ghadi/perso/Project12`, `git rev-parse --show-toplevel` walks up and returns `/home/ghadi` — so the wrapper resolves it to the `ghadi` project instead of creating a `Project12` project.
- **Fix needed in `src/wrapper/project.ts`:** If `gitRoot` is a parent of `cwd` (not the same or a direct project root), fall back to using `cwd` itself.
- ### 2. Architecture/decisions never saved in digests
- **Root cause:** `decisions` in Layer 1 only come from:
- - "confirmation" pattern matches with `extractedDecision`
- - Messages typed as `"decision"`
- When Claude announces architecture, it's just an `assistant` message — Layer 1 never classifies it as a "decision". So `decisions: []` always, nothing reaches Layer 3's architecture section.
- **Fix needed:** Layer 1 needs to extract decisions from assistant messages that match architecture/decision patterns (e.g. "I'll use...", "The architecture is...", "decided to...").
- ### 3. `llm-memory projects list` didn't show Project12
- **Root cause:** Same as #1 — Project12 was never registered. Its sessions went to the `ghadi` project.
- ### 4. No messages captured (0 messages_raw despite JSONL existing)
- **Root cause:** The JSONL reader runs at session end and finds the file by mtime >= sessionStartMs. But the current session's JSONL file is still open/being written, so the mtime check may race. Also, 0 messages in DB means `seedBuffers` with messages never ran (no messages seeded from JSONL).
- ---
- Want me to fix these now? The priority order I'd suggest:
- 1. **Fix #1** (git root leaking to parent) — affects project isolation completely
- 2. **Fix #2** (decisions extraction) — affects architecture/memory quality
- 3. **Fix #4** (messages not seeded) — investigate why JSONL reader returns nothing for recent sessions
- Now fix `tryConfirmation` in patterns.ts to extract a meaningful decision sentence instead of dumping the whole assistan…
- "I'm using" still matches "using " in ARCH_SIGNALS. And "React 19 instead of 18" matches "react". Both are still appeari…
- Clean! But "I'm using Subagent-Driven Development to build KubeQuest task by task" is in Architecture because it matches…
- The real fix is to change the entrypoint guard to use `import.meta.url` instead of `VITEST`, but actually looking at th…
- The fix: check if `argv[1]` ends with `wrapper/index.js` (the only valid case to run `main()`), rather than checking fo…

## Known Issues
- [ ] Here's the full picture:
- [ ] The config was modified at 08:00 today — that's when the remote was removed (just now, by us). No trace of llm-memory in there. Let me check if `git remote get-url origin` on `/home/ghadi` could have triggered a side effect, or if the claude JSONL reader is running `git` commands in wrong directories.
- [ ] Let me investigate all three issues systematically.
- [ ] Found it. Multiple problems confirmed. Let me check the digest issue too:
- [ ] Let me look at the AGENTS.md for project 21 and the relevant source files to understand what's broken.
- [ ] I can see exactly what's broken. Multiple issues:
- [ ] Confirmed. The brainstorming skill Q&A is getting classified wrong — questions like "What tech stack do you want to use?…
- [ ] I’m adding targeted tests around the exact bug: `antigravity chat` behind global options should stay wrapped, while non-…
- [ ] [llm-memory] wrapper fatal error: Error: [llm-memory] Unknown tool 'llm-memory' — wrapper only supports: claude, codex, …
- [ ] The guard is there and correct. But notice in the stack trace it says `at file:///home/ghadi/perso/llm-memory/dist/src/w…

## Conventions
- DB path: ~/.llm-memory/store.db, override with LLM_MEMORY_DB_PATH
- Build: npm run build (tsc → dist/src/). rootDir=. so output is dist/src/ not dist/
- Tests: npm run test:run (vitest run). 455 tests passing.
- Hook receiver must exit in <500ms
- MCP sidecar only spawned for Claude and OpenCode (Codex/Gemini would steal stdin)
- Project resolution: path-hash first, git remote as fallback (prevents cross-project pollution)
- You want OpenClaw (from Discord) to be able to act directly on your local files instead of only replying with paste-ready output. I’m checking your local OpenClaw/GSD setup to see exactly which permission boundary is blocking that and what to change safely.
- I successfully applied the config-side changes, but `openclaw approvals set` failed because its CLI syntax is different than expected. I’m switching to directly updating `~/.openclaw/exec-approvals.json`, then I’ll verify and restart gateway.
- Now I have the full picture. Here are all the problems:
- Now fix the combiner to extract a decision sentence rather than the full message:
- Now fix `tryConfirmation` in patterns.ts to extract a meaningful decision sentence instead of dumping the whole assistan…
- Also fix the duplication — decisions that go into Architecture shouldn't also go into Conventions. Let me look at that l…
- "I'm using" still matches "using " in ARCH_SIGNALS. And "React 19 instead of 18" matches "react". Both are still appeari…
- Clean! But "I'm using Subagent-Driven Development to build KubeQuest task by task" is in Architecture because it matches…
- I’m reading the project instructions and the local `AGENTS.md`/`CLAUDE.md` first so I can ground the Antigravity work i…
- There are two concrete clues now: Antigravity has a real `chat` CLI we can wrap, and it appears to support MCP via conf…
- I’m dumping those values now; if they point to persisted transcript blobs, we can build real post-hoc ingestion instead…
- I’m moving to edits: code first for the tool registry and wrapper, then the MCP/session fix, then targeted tests so the…
- I’m editing the support matrix now. The first pass adds Antigravity everywhere the code treats tools as a closed set, a…
- Does this testing plan look right?

## Recent Work
- [2026-03-19] deactivate llm memory from my pc completly for the moment, return all path to how they were for all the tools gemini, opencode, etc etc
- [2026-03-13] use @docs/superpowers/specs/2026-03-13-antigravity-integration-design.md to know what to do and implement everything in it
- [2026-03-13] i tried implemnting support for antigravity but i think i didnt do it the right way. do some reaseach. what could be the best way to integrate this tool for antigravity use
- [2026-03-12] i tried implemnting support for antigravity but i think i didnt do it the right way. do some reaseach. what could be the best way to integrate this tool for antigravity use
- [2026-03-10] check agents.md and claude.md to understand what is this project.
- [2026-03-09] bro this is just not working. look for project 21 for example, i ran somethings with claude coede then somethings with codex, look at the agents.md file it generated inside of this project its ass the architectur part means nothing, and like veerything is mixed up
- [2026-03-06] add a ci to this project that run the tests that are already here.
- [2026-03-06] remove the origin of llm memory in git for my home file it is cuasing problems
- [2026-03-06] why cant openclaw have acces to this And to answer your question clearly: from this Discord session, I still can’t directly edit your Obsidian files (no local filesystem/shell access here).
- [2026-03-06] whats the plan for this project use llm memory to know
<!-- /llm-memory -->