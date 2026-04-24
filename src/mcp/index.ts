// MCP server entrypoint — stdio transport for Claude Code integration.
// All tool logic lives in handlers.ts; this file only wires up the MCP SDK.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { sweepOrphanedSessions, db } from "../db/index.js";
import { loadEmbedder } from "../db/embedding.js";
import {
  handleStoreMessage,
  handleStoreEvent,
  handleGetProjectMemory,
  handleListSessions,
  handleSearchContext,
  handleEndSession,
  getEventBuffer,
} from "./handlers.js";

// ─── Env ──────────────────────────────────────────────────────────────────────

const SESSION_ID = process.env["LLM_MEMORY_SESSION_ID"] ?? null;
const PROJECT_ID = process.env["LLM_MEMORY_PROJECT_ID"] ?? null;

// ─── Startup ──────────────────────────────────────────────────────────────────

// 1. Orphan sweep (synchronous — fast, runs before server starts)
try {
  const closed = sweepOrphanedSessions(60); // 60-minute timeout
  if (closed.length > 0) {
    console.error(`[llm-memory] swept ${closed.length} orphaned session(s)`);
  }
} catch (e) {
  console.error("[llm-memory] orphan sweep failed:", e);
}

// 2. Load embedder in background — don't block server startup
loadEmbedder().catch((e) => {
  console.error("[llm-memory] embedder failed to load (search_context will use keyword fallback):", e);
});

// ─── MCP server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "llm-memory", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// ─── Tool definitions ─────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "store_message",
      description: "Buffer a conversation message for session-end processing.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          role: { type: "string", enum: ["user", "assistant"] },
          content: { type: "string" },
          index: { type: "integer", minimum: 0 },
        },
        required: ["session_id", "role", "content", "index"],
      },
    },
    {
      name: "store_event",
      description: "Record a tool call event (file edit, bash command, etc.) for the current session.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          tool: { type: "string" },
          args: { type: "object" },
          result: { type: "object" },
          success: { type: "boolean" },
        },
        required: ["session_id", "tool"],
      },
    },
    {
      name: "search_context",
      description: "Search past sessions for context relevant to a query. Uses embedding similarity, falls back to keyword search.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          project_id: { type: "string" },
          limit: { type: "integer", minimum: 1, default: 5 },
        },
        required: ["query", "project_id"],
      },
    },
    {
      name: "get_project_memory",
      description: "Return the full project memory document (architecture, conventions, recent work, known issues).",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
        },
        required: ["project_id"],
      },
    },
    {
      name: "list_sessions",
      description: "List recent sessions for a project with their goals and outcomes.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          limit: { type: "integer", minimum: 1, default: 20 },
        },
        required: ["project_id"],
      },
    },
    {
      name: "end_session",
      description: "Signal session end — runs Layer 1→2→3 pipeline, stores digest, updates project memory.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          project_id: { type: "string" },
          outcome: { type: "string", enum: ["completed", "interrupted", "crashed"] },
          exit_code: { type: "integer", nullable: true },
        },
        required: ["session_id", "project_id", "outcome"],
      },
    },
  ],
}));

// ─── Tool dispatch ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  let result: unknown;

  try {
    switch (name) {
      case "store_message":
        result = await handleStoreMessage(args);
        break;
      case "store_event":
        result = await handleStoreEvent(args);
        break;
      case "search_context":
        result = await handleSearchContext(args);
        break;
      case "get_project_memory":
        result = await handleGetProjectMemory(args);
        break;
      case "list_sessions":
        result = await handleListSessions(args);
        break;
      case "end_session":
        result = await handleEndSession(args);
        break;
      default:
        result = { error: `Unknown tool: ${name}`, code: "UNKNOWN_TOOL" };
    }
  } catch (e) {
    console.error(`[llm-memory] tool ${name} threw unexpectedly:`, e);
    result = { error: String(e), code: "INTERNAL_ERROR" };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
  };
});

// ─── SIGTERM — flush and shut down cleanly ────────────────────────────────────

process.on("SIGTERM", async () => {
  console.error("[llm-memory] SIGTERM received — shutting down");

  // If the wrapper set a session ID, trigger session end on SIGTERM —
  // but only if the wrapper hasn't already processed it (digest not yet written).
  if (SESSION_ID && PROJECT_ID) {
    const alreadyDone = db.prepare<[string], { count: number }>(
      "SELECT COUNT(*) as count FROM digests WHERE session_id = ?"
    ).get(SESSION_ID);
    if (!alreadyDone || alreadyDone.count === 0) {
      try {
        await handleEndSession({
          session_id: SESSION_ID,
          project_id: PROJECT_ID,
          outcome: "interrupted",
          exit_code: null,
        });
      } catch (e) {
        console.error("[llm-memory] end_session failed:", e);
      }
    }
  }

  process.exit(0);
});

// ─── Connect ──────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
