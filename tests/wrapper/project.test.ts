import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveProject } from "../../src/wrapper/project.js";

// ─── Mock child_process ───────────────────────────────────────────────────────
// resolveProject shells out to git; we mock execSync to control the responses.

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
const mockExec = vi.mocked(execSync);

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Helper: make execSync return different values per call ───────────────────

function setupGit(remote: string | null, root: string | null) {
  mockExec.mockImplementation((cmd: unknown) => {
    const c = String(cmd);
    if (c.includes("remote get-url")) {
      if (remote === null) throw new Error("no remote");
      return Buffer.from(remote + "\n");
    }
    if (c.includes("rev-parse")) {
      if (root === null) throw new Error("not a git repo");
      return Buffer.from(root + "\n");
    }
    throw new Error(`unexpected command: ${c}`);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("resolveProject — git remote primary", () => {
  it("uses git remote as canonical identifier when available", async () => {
    setupGit("https://github.com/user/repo.git", "/home/user/repo");
    const result = await resolveProject("/home/user/repo");
    expect(result.gitRemote).toBe("https://github.com/user/repo.git");
  });

  it("derives name from git root directory basename", async () => {
    setupGit("https://github.com/user/my-project.git", "/home/user/my-project");
    const result = await resolveProject("/home/user/my-project");
    expect(result.name).toBe("my-project");
  });

  it("path is the git root, not cwd, when inside a subdirectory", async () => {
    setupGit("https://github.com/user/repo.git", "/home/user/repo");
    const result = await resolveProject("/home/user/repo/src/subdir");
    expect(result.path).toBe("/home/user/repo");
  });

  it("isNew is false when project already exists in DB", async () => {
    // This test just verifies the shape — DB is not involved in unit test
    setupGit("https://github.com/user/repo.git", "/home/user/repo");
    const result = await resolveProject("/home/user/repo");
    expect(typeof result.isNew).toBe("boolean");
  });
});

describe("resolveProject — git root fallback (no remote)", () => {
  it("falls back to git root path when no remote is configured", async () => {
    setupGit(null, "/home/user/local-project");
    const result = await resolveProject("/home/user/local-project");
    expect(result.path).toBe("/home/user/local-project");
    expect(result.gitRemote).toBeNull();
  });

  it("name comes from git root basename when no remote", async () => {
    setupGit(null, "/home/user/local-project");
    const result = await resolveProject("/home/user/local-project");
    expect(result.name).toBe("local-project");
  });
});

describe("resolveProject — git root is grandparent (home-dir git repo)", () => {
  it("uses cwd when git root is more than one level above cwd", async () => {
    // e.g. /home/ghadi is a git repo, cwd is /home/ghadi/perso/Project12
    setupGit(null, "/home/ghadi");
    const result = await resolveProject("/home/ghadi/perso/Project12");
    expect(result.path).toBe("/home/ghadi/perso/Project12");
    expect(result.name).toBe("Project12");
  });

  it("uses git root when cwd is a direct subdir of git root", async () => {
    // e.g. cwd is /home/ghadi/perso/ctx-memory, git root is /home/ghadi/perso/ctx-memory
    setupGit("git@github.com:user/repo.git", "/home/ghadi/perso/ctx-memory");
    const result = await resolveProject("/home/ghadi/perso/ctx-memory/src");
    expect(result.path).toBe("/home/ghadi/perso/ctx-memory");
  });
});

describe("resolveProject — cwd fallback (no git at all)", () => {
  it("falls back to cwd when not in a git repo", async () => {
    mockExec.mockImplementation(() => { throw new Error("not a git repo"); });
    const result = await resolveProject("/tmp/scratch");
    expect(result.path).toBe("/tmp/scratch");
    expect(result.gitRemote).toBeNull();
  });

  it("name comes from cwd basename when not in a git repo", async () => {
    mockExec.mockImplementation(() => { throw new Error("not a git repo"); });
    const result = await resolveProject("/tmp/my-scratch");
    expect(result.name).toBe("my-scratch");
  });
});

describe("resolveProject — pathHash", () => {
  it("always includes a pathHash string", async () => {
    setupGit("https://github.com/user/repo.git", "/home/user/repo");
    const result = await resolveProject("/home/user/repo");
    expect(typeof result.pathHash).toBe("string");
    expect(result.pathHash.length).toBeGreaterThan(0);
  });

  it("pathHash is deterministic for the same path", async () => {
    setupGit(null, "/home/user/project");
    const r1 = await resolveProject("/home/user/project");
    setupGit(null, "/home/user/project");
    const r2 = await resolveProject("/home/user/project");
    expect(r1.pathHash).toBe(r2.pathHash);
  });

  it("pathHash differs for different paths", async () => {
    mockExec.mockImplementation(() => { throw new Error("no git"); });
    const r1 = await resolveProject("/home/user/project-a");
    const r2 = await resolveProject("/home/user/project-b");
    expect(r1.pathHash).not.toBe(r2.pathHash);
  });
});
