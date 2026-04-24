import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import DatabaseConstructor from "better-sqlite3";

import {
  findWorkspaceHash,
  readAntigravitySession,
} from "../../src/wrapper/antigravity.js";
import { findAntigravityElectronPid } from "../../src/wrapper/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createStorageDir(): string {
  return mkdtempSync(join(tmpdir(), "llm-memory-antigravity-storage-"));
}

function writeWorkspaceJson(storageDir: string, hash: string, data: object) {
  const hashDir = join(storageDir, hash);
  mkdirSync(hashDir, { recursive: true });
  writeFileSync(join(hashDir, "workspace.json"), JSON.stringify(data), "utf8");
}

function createStateDb(dbPath: string, indexJson: string) {
  const db = new DatabaseConstructor(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)`);
  db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
    "chat.ChatSessionStore.index",
    indexJson
  );
  db.close();
}

// ─── Test state ───────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

// ─── findWorkspaceHash ────────────────────────────────────────────────────────

describe("findWorkspaceHash", () => {
  it("returns the correct hash when cwd matches a workspace.json folder", () => {
    const storageDir = createStorageDir();
    tempDirs.push(storageDir);

    writeWorkspaceJson(storageDir, "abc123", { folder: "file:///path/to/project-a" });
    writeWorkspaceJson(storageDir, "def456", { folder: "file:///path/to/project-b" });
    writeWorkspaceJson(storageDir, "ghi789", {});

    const result = findWorkspaceHash(storageDir, "/path/to/project-a");
    expect(result).toBe("abc123");
  });

  it("returns null when cwd does not match any entry", () => {
    const storageDir = createStorageDir();
    tempDirs.push(storageDir);

    writeWorkspaceJson(storageDir, "abc123", { folder: "file:///path/to/project-a" });
    writeWorkspaceJson(storageDir, "def456", { folder: "file:///path/to/project-b" });
    writeWorkspaceJson(storageDir, "ghi789", {});

    const result = findWorkspaceHash(storageDir, "/path/to/no-match");
    expect(result).toBeNull();
  });

  it("returns null when workspace.json has no folder field (gracefully skips)", () => {
    const storageDir = createStorageDir();
    tempDirs.push(storageDir);

    writeWorkspaceJson(storageDir, "ghi789", {});

    const result = findWorkspaceHash(storageDir, "/path/to/project-a");
    expect(result).toBeNull();
  });

  it("returns null when storageDir does not exist (no throw)", () => {
    const nonExistentDir = join(tmpdir(), "llm-memory-no-such-dir-" + Date.now());
    expect(() => findWorkspaceHash(nonExistentDir, "/some/cwd")).not.toThrow();
    expect(findWorkspaceHash(nonExistentDir, "/some/cwd")).toBeNull();
  });
});

// ─── readAntigravitySession ───────────────────────────────────────────────────

const CHAT_INDEX_WITH_TWO_REQUESTS = JSON.stringify({
  version: 1,
  entries: {
    "session-1": {
      sessionId: "session-1",
      creationDate: 1000000,
      requests: [
        {
          message: { text: "hello world" },
          response: { value: [{ value: "hi there" }] },
          timestamp: 2000000,
        },
        {
          message: { text: "second question" },
          response: { value: [{ value: "second answer" }] },
          timestamp: 3000000,
        },
      ],
    },
  },
});

describe("readAntigravitySession", () => {
  function setupDb(
    indexJson: string
  ): { storageDir: string; cwd: string; hash: string } {
    const storageDir = createStorageDir();
    tempDirs.push(storageDir);
    const cwd = "/test/project";
    const hash = "testhash001";

    // Write workspace.json so findWorkspaceHash resolves the hash
    writeWorkspaceJson(storageDir, hash, { folder: `file://${cwd}` });

    // Write state.vscdb with the provided index JSON
    const dbPath = join(storageDir, hash, "state.vscdb");
    createStateDb(dbPath, indexJson);

    return { storageDir, cwd, hash };
  }

  it("returns only requests with timestamp >= sessionStartMs", () => {
    const { storageDir, cwd } = setupDb(CHAT_INDEX_WITH_TWO_REQUESTS);

    // sessionStartMs=1500000 → only the second request (timestamp=2000000) and third (3000000) pass
    // But we have two requests: one at 2000000, one at 3000000, both >= 1500000 → 4 messages
    const { messages } = readAntigravitySession(cwd, 1500000, storageDir);
    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("hello world");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("hi there");
    expect(messages[2].role).toBe("user");
    expect(messages[2].content).toBe("second question");
    expect(messages[3].role).toBe("assistant");
    expect(messages[3].content).toBe("second answer");
  });

  it("with sessionStartMs=0 includes all requests → 4 messages", () => {
    const { storageDir, cwd } = setupDb(CHAT_INDEX_WITH_TWO_REQUESTS);

    const { messages } = readAntigravitySession(cwd, 0, storageDir);
    expect(messages).toHaveLength(4);
  });

  it("with sessionStartMs > all timestamps returns [] (filtered out)", () => {
    const { storageDir, cwd } = setupDb(CHAT_INDEX_WITH_TWO_REQUESTS);

    // Both requests have timestamps 2000000 and 3000000, which are < 9000000
    const { messages } = readAntigravitySession(cwd, 9000000, storageDir);
    expect(messages).toHaveLength(0);
  });

  it("empty entries object returns []", () => {
    const emptyIndex = JSON.stringify({ version: 1, entries: {} });
    const { storageDir, cwd } = setupDb(emptyIndex);

    const { messages } = readAntigravitySession(cwd, 0, storageDir);
    expect(messages).toHaveLength(0);
  });

  it("malformed JSON in ItemTable returns [] without throwing", () => {
    const storageDir = createStorageDir();
    tempDirs.push(storageDir);
    const cwd = "/test/project-malformed";
    const hash = "malformedhash";

    writeWorkspaceJson(storageDir, hash, { folder: `file://${cwd}` });

    const dbPath = join(storageDir, hash, "state.vscdb");
    const db = new DatabaseConstructor(dbPath);
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "chat.ChatSessionStore.index",
      "{ this is not valid json !!!"
    );
    db.close();

    expect(() => readAntigravitySession(cwd, 0, storageDir)).not.toThrow();
    const { messages } = readAntigravitySession(cwd, 0, storageDir);
    expect(messages).toHaveLength(0);
  });

  it("request with missing response field is skipped gracefully", () => {
    const indexWithMissingResponse = JSON.stringify({
      version: 1,
      entries: {
        "session-1": {
          sessionId: "session-1",
          creationDate: 1000000,
          requests: [
            {
              message: { text: "question without response" },
              // no response field
              timestamp: 2000000,
            },
            {
              message: { text: "valid question" },
              response: { value: [{ value: "valid answer" }] },
              timestamp: 3000000,
            },
          ],
        },
      },
    });

    const { storageDir, cwd } = setupDb(indexWithMissingResponse);

    expect(() => readAntigravitySession(cwd, 0, storageDir)).not.toThrow();
    const { messages } = readAntigravitySession(cwd, 0, storageDir);
    // First request has no response — skipped. Second request → 2 messages.
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("valid question");
    expect(messages[1].content).toBe("valid answer");
  });

  it("returns [] when no workspace hash matches the cwd", () => {
    const storageDir = createStorageDir();
    tempDirs.push(storageDir);

    // storageDir has no subdirectories → findWorkspaceHash returns null
    const { messages } = readAntigravitySession("/no/such/project", 0, storageDir);
    expect(messages).toHaveLength(0);
  });
});

// ─── findAntigravityElectronPid ───────────────────────────────────────────────

describe("findAntigravityElectronPid", () => {
  it("returns the PID when a process with antigravity in cmd and matching cwd exists", () => {
    const cwd = "/home/user/my-project";
    const result = findAntigravityElectronPid(cwd, () => [
      { pid: 1001, cmd: "/usr/bin/antigravity --user-data-dir /home/user/my-project/data" },
      { pid: 1002, cmd: "/usr/bin/code --type=renderer" },
    ]);
    expect(result).toBe(1001);
  });

  it("returns null when no process matches", () => {
    const cwd = "/home/user/my-project";
    const result = findAntigravityElectronPid(cwd, () => [
      { pid: 2001, cmd: "/usr/bin/code --type=renderer" },
      { pid: 2002, cmd: "/usr/bin/node server.js" },
    ]);
    expect(result).toBeNull();
  });

  it("returns null when processList is empty", () => {
    const result = findAntigravityElectronPid("/some/cwd", () => []);
    expect(result).toBeNull();
  });

  it("matches on --user-data-dir containing Antigravity even if cwd path not in cmd", () => {
    const cwd = "/home/user/other-project";
    const result = findAntigravityElectronPid(cwd, () => [
      {
        pid: 3001,
        cmd: "/usr/lib/antigravity/antigravity --user-data-dir /home/user/.config/Antigravity/User",
      },
    ]);
    // cmd contains "antigravity" AND --user-data-dir contains "Antigravity"
    expect(result).toBe(3001);
  });

  it("does not match a process that has cwd but lacks antigravity in cmd", () => {
    const cwd = "/home/user/my-project";
    const result = findAntigravityElectronPid(cwd, () => [
      { pid: 4001, cmd: `/usr/bin/some-other-editor ${cwd}` },
    ]);
    expect(result).toBeNull();
  });
});
