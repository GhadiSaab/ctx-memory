import { describe, it, expect } from "vitest";
import { processSession, type RawToolEvent } from "../../src/layer1/combiner.js";
import { generateDigest } from "../../src/layer2/digest.js";
import { mergeIntoProjectMemory } from "../../src/layer3/memory.js";
import type { Message, ProjectMemory } from "../../src/types/index.js";

function msg(role: "user" | "assistant", content: string, index: number): Message {
  return {
    id: `msg-${index}` as any,
    session_id: "quality-session" as any,
    role,
    content,
    index,
    timestamp: Date.now() as any,
  };
}

function event(tool: string, args: Record<string, unknown>, result: Record<string, unknown> = {}, success = true): RawToolEvent {
  return { tool, args, result, success, timestamp: Date.now() };
}

function emptyMemory(): ProjectMemory {
  return {
    project_id: "project" as any,
    memory_doc: "",
    architecture: "",
    how_to_test: [],
    conventions: [],
    known_issues: [],
    recent_work: [],
    updated_at: 0 as any,
  };
}

function run(messages: Message[], events: RawToolEvent[] = []) {
  const layer1 = processSession(messages, events);
  const digest = generateDigest(layer1, "completed", 0);
  const memory = mergeIntoProjectMemory(emptyMemory(), digest, "quality-session");
  return { layer1, digest, memory };
}

describe("digest quality regressions", () => {
  it("extracts real implementation decisions from JWT, pagination, and body parsing sessions", () => {
    const { digest, memory } = run([
      msg("user", "add auth, pagination, and fix the no-body crash", 0),
      msg("assistant", "Implemented JWT auth with HttpOnly refresh-token cookies.", 1),
      msg("assistant", "Added cursor pagination with limit and nextCursor response metadata.", 2),
      msg("assistant", "Fixed request body parsing by treating empty request bodies as an empty object.", 3),
    ], [
      event("edit_file", { path: "src/auth.ts" }),
      event("edit_file", { path: "src/pagination.ts" }),
      event("edit_file", { path: "src/body.ts" }),
      event("bash", { command: "npx jest auth pagination body" }, { stdout: "3 passed" }, true),
    ]);

    expect(digest.decisions.join("\n")).toMatch(/JWT auth/i);
    expect(digest.decisions.join("\n")).toMatch(/cursor pagination/i);
    expect(digest.decisions.join("\n")).toMatch(/body parsing/i);
    expect(memory.architecture).toMatch(/JWT auth|cursor pagination|body parsing/i);
  });

  it("does not store assistant scratch-work or skill dumps as errors or known issues", () => {
    const { digest, memory } = run([
      msg("user", "use TDD and fix pagination", 0),
      msg("assistant", "Now I need to update the tests to cover the new pagination behavior.", 1),
      msg("assistant", "Also add a test for the no-body crash case:", 2),
      msg("user", "Base directory for this skill: /home/ghadi/.claude/plugins/cache/tdd/SKILL.md\n# TDD\nFollow these instructions.", 3),
      msg("assistant", "Added cursor pagination and body parsing guards.", 4),
    ], [
      event("edit_file", { path: "src/pagination.ts" }),
      event("bash", { command: "npx jest pagination" }, { stdout: "1 passed" }, true),
    ]);

    const poisoned = [
      ...digest.errors_encountered,
      ...memory.known_issues.map((issue) => issue.description),
    ].join("\n");
    expect(poisoned).not.toMatch(/Now I need|Also add a test|Base directory for this skill|SKILL.md/);
    expect(memory.known_issues).toHaveLength(0);
  });

  it("produces non-empty keywords for a single-message task", () => {
    const { digest } = run([
      msg("user", "Implement JWT authentication middleware with refresh tokens", 0),
    ]);

    expect(digest.keywords).toEqual(expect.arrayContaining(["jwt", "authentication", "middleware"]));
  });

  it("canonicalizes near-duplicate test commands in How to Test", () => {
    const { memory } = run([
      msg("user", "run tests", 0),
    ], [
      event("bash", { command: "npx jest tests/auth.test.ts --runInBand" }, { stdout: "1 passed" }, true),
      event("bash", { command: "npx jest tests/auth.test.ts" }, { stdout: "1 passed" }, true),
    ]);

    expect(memory.how_to_test.filter((command) => command === "npx jest tests/auth.test.ts")).toHaveLength(1);
  });

  it("does not add a failed test run as a Known Issue", () => {
    // A failing test mid-session is transient — the dev is iterating.
    // It must not survive into Known Issues.
    const { memory } = run([
      msg("user", "fix the pagination bug and make tests pass", 0),
      msg("assistant", "Fixed cursor pagination. Running tests now.", 1),
    ], [
      event("bash", { command: "npm test -- --testPathPattern=server 2>&1 | tail -60" }, { stdout: "1 failed" }, false),
      event("bash", { command: "npm test -- --testPathPattern=server 2>&1 | tail -20" }, { stdout: "1 passed" }, true),
    ]);

    const issueDescriptions = memory.known_issues.map((i) => i.description).join("\n");
    expect(issueDescriptions).not.toMatch(/npm test|testPathPattern|tail/);
    expect(memory.known_issues.filter((i) => i.resolved_at === null)).toHaveLength(0);
  });

  it("deduplicates pipe-variant test commands in How to Test", () => {
    // "npm test | tail -60" and "npm test | tail -20" are the same base command.
    // Only one canonical entry should appear.
    const { memory } = run([
      msg("user", "run the server tests", 0),
    ], [
      event("bash", { command: "npm test -- --testPathPattern=server 2>&1 | tail -60" }, { stdout: "1 passed" }, true),
      event("bash", { command: "npm test -- --testPathPattern=server 2>&1 | tail -20" }, { stdout: "1 passed" }, true),
    ]);

    const serverTestCommands = memory.how_to_test.filter((c) => c.includes("testPathPattern=server"));
    expect(serverTestCommands).toHaveLength(1);
    expect(serverTestCommands[0]).toBe("npm test -- --testPathPattern=server");
  });

  it("keeps test-shape work out of Architecture while promoting durable auth architecture", () => {
    const { memory } = run([
      msg("user", "fix the auth tests and document the auth architecture", 0),
      msg("assistant", "These two tests need to be updated to match the new request shape.", 1),
      msg("assistant", "JWT authentication with refresh token cookies is the session strategy.", 2),
    ], [
      event("edit_file", { path: "src/auth.ts" }),
      event("bash", { command: "npm test -- --testPathPattern=auth" }, { stdout: "1 passed" }, true),
    ]);

    expect(memory.architecture).toContain("JWT authentication with refresh token cookies");
    expect(memory.architecture).not.toMatch(/tests need to be updated|request shape/i);
  });
});
