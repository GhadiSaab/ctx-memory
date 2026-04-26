import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// We import from the module under test — these don't exist yet, so tests will fail.
import {
  detectInstalledTools,
  createWrapperSymlink,
  injectPathLine,
  forgetProject,
  getAllProjects,
  registerCodexMcp,
} from "../../src/cli/index.js";

// ─── detectInstalledTools ─────────────────────────────────────────────────────

describe("detectInstalledTools", () => {
  it("returns only tools whose executables exist in PATH dirs", () => {
    // Provide a mock PATH dir where only 'claude' (claude-code) and 'gemini' exist.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-"));
    fs.writeFileSync(path.join(tmpDir, "claude"), "", { mode: 0o755 });
    fs.writeFileSync(path.join(tmpDir, "gemini"), "", { mode: 0o755 });
    // 'codex' and 'opencode' are absent.

    const found = detectInstalledTools([tmpDir]);
    expect(found).toContain("claude-code");
    expect(found).toContain("gemini");
    expect(found).not.toContain("codex");
    expect(found).not.toContain("opencode");

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns empty array when no tools found", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-empty-"));
    const found = detectInstalledTools([tmpDir]);
    expect(found).toEqual([]);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("searches multiple PATH dirs and deduplicates", () => {
    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "detect-d1-"));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "detect-d2-"));
    fs.writeFileSync(path.join(dir1, "claude"), "", { mode: 0o755 });
    fs.writeFileSync(path.join(dir2, "claude"), "", { mode: 0o755 }); // duplicate

    const found = detectInstalledTools([dir1, dir2]);
    const claudeCount = found.filter((t) => t === "claude-code").length;
    expect(claudeCount).toBe(1);

    fs.rmSync(dir1, { recursive: true });
    fs.rmSync(dir2, { recursive: true });
  });
});

// ─── createWrapperSymlink ─────────────────────────────────────────────────────

describe("createWrapperSymlink", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symlink-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("creates a symlink pointing at wrapperPath", () => {
    const wrapperPath = "/usr/local/lib/ctx-memory/wrapper-claude.sh";
    createWrapperSymlink("claude", wrapperPath, tmpDir);

    const linkPath = path.join(tmpDir, "claude");
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkPath)).toBe(wrapperPath);
  });

  it("is idempotent — calling twice does not throw and updates the symlink", () => {
    const wrapperPath = "/usr/local/lib/ctx-memory/wrapper-claude.sh";
    createWrapperSymlink("claude", wrapperPath, tmpDir);
    // Call again — should overwrite, not throw.
    expect(() => createWrapperSymlink("claude", wrapperPath, tmpDir)).not.toThrow();

    const linkPath = path.join(tmpDir, "claude");
    expect(fs.readlinkSync(linkPath)).toBe(wrapperPath);
  });

  it("marks an existing wrapper target executable", () => {
    const wrapperPath = path.join(tmpDir, "wrapper.js");
    fs.writeFileSync(wrapperPath, "#!/usr/bin/env node\n", { mode: 0o644 });

    createWrapperSymlink("claude", wrapperPath, tmpDir);

    expect(fs.statSync(wrapperPath).mode & 0o111).not.toBe(0);
  });
});


// ─── injectPathLine ───────────────────────────────────────────────────────────

describe("injectPathLine", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "inject-")),
      ".bashrc"
    );
  });

  it("appends the PATH export line when not present and returns true", () => {
    fs.writeFileSync(tmpFile, "# existing content\n");
    const result = injectPathLine(tmpFile);
    expect(result).toBe(true);
    const content = fs.readFileSync(tmpFile, "utf8");
    expect(content).toContain('export PATH="$HOME/.ctx-memory/bin:$PATH"');
  });

  it("returns false and does not duplicate when line already present", () => {
    fs.writeFileSync(
      tmpFile,
      '# existing\nexport PATH="$HOME/.ctx-memory/bin:$PATH"\n'
    );
    const result = injectPathLine(tmpFile);
    expect(result).toBe(false);
    const content = fs.readFileSync(tmpFile, "utf8");
    const occurrences = (
      content.match(/export PATH="\$HOME\/.ctx-memory\/bin:\$PATH"/g) ?? []
    ).length;
    expect(occurrences).toBe(1);
  });

  it("creates the file if it does not exist", () => {
    const newFile = tmpFile + ".new";
    const result = injectPathLine(newFile);
    expect(result).toBe(true);
    expect(fs.existsSync(newFile)).toBe(true);
    expect(fs.readFileSync(newFile, "utf8")).toContain(
      'export PATH="$HOME/.ctx-memory/bin:$PATH"'
    );
  });
});

// ─── forgetProject ────────────────────────────────────────────────────────────

import {
  db,
  createProject,
  createSession,
  writeDigest,
  insertEvent,
  createKnownIssue,
  addRecentWork,
} from "../../src/db/index.js";
import type { UUID } from "../../src/types/index.js";

function makeProject(name?: string) {
  const n = name ?? `test-proj-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return createProject({
    name: n,
    path: `/tmp/test-${Date.now()}`,
    git_remote: null,
    path_hash: `hash-${Date.now()}-${Math.random()}`,
  });
}

describe("forgetProject — soft delete", () => {
  it("resets memory_doc to NULL and removes known_issues + recent_work rows", () => {
    const project = makeProject();
    const pid = project.id as UUID;

    // Insert memory doc, known issue, recent work
    db.prepare("UPDATE projects SET memory_doc = ? WHERE id = ?").run(
      "# some memory",
      pid
    );
    createKnownIssue({ project_id: pid, description: "bug A" });
    const session = createSession({ project_id: pid, tool: "claude-code" });
    addRecentWork({
      project_id: pid,
      session_id: session.id,
      summary: "did stuff",
    });

    forgetProject(pid, false);

    const row = db
      .prepare("SELECT memory_doc FROM projects WHERE id = ?")
      .get(pid) as { memory_doc: string | null };
    expect(row.memory_doc).toBeNull();

    const issues = db
      .prepare("SELECT * FROM known_issues WHERE project_id = ?")
      .all(pid);
    expect(issues).toHaveLength(0);

    const work = db
      .prepare("SELECT * FROM recent_work WHERE project_id = ?")
      .all(pid);
    expect(work).toHaveLength(0);

    // Project row itself still exists
    const proj = db
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(pid);
    expect(proj).toBeTruthy();

    // Session row still exists (soft delete only)
    const sess = db
      .prepare("SELECT * FROM sessions WHERE project_id = ?")
      .all(pid);
    expect(sess.length).toBeGreaterThan(0);
  });
});

describe("forgetProject — hard delete", () => {
  it("removes sessions, digests, events too, in addition to soft-forget behavior", () => {
    const project = makeProject();
    const pid = project.id as UUID;

    db.prepare("UPDATE projects SET memory_doc = ? WHERE id = ?").run(
      "# some memory",
      pid
    );
    createKnownIssue({ project_id: pid, description: "bug B" });

    const session = createSession({ project_id: pid, tool: "claude-code" });
    const sid = session.id;

    // Insert a digest
    writeDigest({
      session_id: sid,
      goal: "did things",
      keywords: [],
      files_modified: ["src/foo.ts"],
      decisions: [],
      errors_encountered: [],
      outcome: null,
      estimated_tokens: 50,
    });

    // Insert an event
    insertEvent({
      session_id: sid,
      type: "file_modified",
      payload: { type: "file_modified", path: "src/foo.ts", operation: "edit", diffSummary: null },
      weight: 0.5,
      source: "hook",
    });

    addRecentWork({
      project_id: pid,
      session_id: sid,
      summary: "hard stuff",
    });

    forgetProject(pid, true);

    const sessions = db
      .prepare("SELECT * FROM sessions WHERE project_id = ?")
      .all(pid);
    expect(sessions).toHaveLength(0);

    const digests = db
      .prepare("SELECT * FROM digests WHERE session_id = ?")
      .all(sid);
    expect(digests).toHaveLength(0);

    const events = db
      .prepare("SELECT * FROM events WHERE session_id = ?")
      .all(sid);
    expect(events).toHaveLength(0);

    const issues = db
      .prepare("SELECT * FROM known_issues WHERE project_id = ?")
      .all(pid);
    expect(issues).toHaveLength(0);

    const work = db
      .prepare("SELECT * FROM recent_work WHERE project_id = ?")
      .all(pid);
    expect(work).toHaveLength(0);

    const row = db
      .prepare("SELECT memory_doc FROM projects WHERE id = ?")
      .get(pid) as { memory_doc: string | null };
    expect(row.memory_doc).toBeNull();

    // Project row itself still exists
    const proj = db.prepare("SELECT * FROM projects WHERE id = ?").get(pid);
    expect(proj).toBeTruthy();
  });
});

// ─── getProjectByName ─────────────────────────────────────────────────────────

import { getProjectByName } from "../../src/cli/index.js";

describe("getProjectByName", () => {
  it("finds a project by exact name match", () => {
    const project = makeProject();
    const found = getProjectByName(project.name);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(project.id);
  });

  it("returns null when no project matches", () => {
    const result = getProjectByName("definitely-does-not-exist-xyz-9999");
    expect(result).toBeNull();
  });
});

// ─── getAllProjects ───────────────────────────────────────────────────────────

describe("getAllProjects", () => {
  it("returns all projects with session_count and last_active_at", () => {
    const project = makeProject();
    const pid = project.id as UUID;

    // No sessions yet
    const before = getAllProjects();
    const entry = before.find((p) => p.id === pid);
    expect(entry).toBeTruthy();
    expect(entry!.session_count).toBe(0);
    expect(entry!.last_active_at).toBeNull();

    // Add a session
    createSession({ project_id: pid, tool: "claude-code" });
    const after = getAllProjects();
    const entry2 = after.find((p) => p.id === pid);
    expect(entry2!.session_count).toBe(1);
    expect(entry2!.last_active_at).not.toBeNull();
  });

  it("includes project name and path", () => {
    const project = makeProject();
    const all = getAllProjects();
    const entry = all.find((p) => p.id === project.id);
    expect(entry!.name).toBe(project.name);
    expect(entry!.path).toBe(project.path);
  });
});
