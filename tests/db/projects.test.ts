import { describe, it, expect, beforeEach } from "vitest";
import {
  createProject,
  getProjectById,
  getProjectByGitRemote,
  getProjectByPathHash,
  upsertMemoryDoc,
} from "../../src/db/index.js";
import { clearDb } from "./helpers.js";

beforeEach(clearDb);

describe("createProject", () => {
  it("creates a project identified by git_remote", () => {
    const p = createProject({
      name: "my-repo",
      path: "/home/user/my-repo",
      git_remote: "git@github.com:user/my-repo.git",
      path_hash: "abc123",
    });

    expect(p.id).toBeTypeOf("string");
    expect(p.name).toBe("my-repo");
    expect(p.git_remote).toBe("git@github.com:user/my-repo.git");
    expect(p.path_hash).toBe("abc123");
    expect(p.memory_doc).toBeNull();
    expect(p.created_at).toBeGreaterThan(0);
    expect(p.updated_at).toBe(p.created_at);
  });

  it("creates a project identified by path_hash only (no git remote)", () => {
    const p = createProject({
      name: "local-only",
      path: "/tmp/local-only",
      git_remote: null,
      path_hash: "sha256-of-path",
    });

    expect(p.git_remote).toBeNull();
    expect(p.path_hash).toBe("sha256-of-path");
  });

  it("rejects duplicate git_remote", () => {
    createProject({ name: "a", path: "/a", git_remote: "git@github.com:u/r.git", path_hash: "h1" });
    expect(() =>
      createProject({ name: "b", path: "/b", git_remote: "git@github.com:u/r.git", path_hash: "h2" })
    ).toThrow();
  });

  it("rejects duplicate path_hash", () => {
    createProject({ name: "a", path: "/a", git_remote: null, path_hash: "same-hash" });
    expect(() =>
      createProject({ name: "b", path: "/b", git_remote: null, path_hash: "same-hash" })
    ).toThrow();
  });
});

describe("getProjectById", () => {
  it("returns the project when it exists", () => {
    const created = createProject({ name: "x", path: "/x", git_remote: null, path_hash: "hx" });
    const found = getProjectById(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.name).toBe("x");
  });

  it("returns null for an unknown id", () => {
    expect(getProjectById("00000000-0000-0000-0000-000000000000" as any)).toBeNull();
  });
});

describe("getProjectByGitRemote", () => {
  it("finds project by git remote", () => {
    const remote = "git@github.com:org/repo.git";
    createProject({ name: "repo", path: "/repo", git_remote: remote, path_hash: "hr" });
    const found = getProjectByGitRemote(remote);
    expect(found).not.toBeNull();
    expect(found!.git_remote).toBe(remote);
  });

  it("returns null when remote does not exist", () => {
    expect(getProjectByGitRemote("git@github.com:nobody/nothing.git")).toBeNull();
  });
});

describe("getProjectByPathHash", () => {
  it("finds project by path hash", () => {
    createProject({ name: "p", path: "/p", git_remote: null, path_hash: "unique-hash" });
    const found = getProjectByPathHash("unique-hash");
    expect(found).not.toBeNull();
    expect(found!.path_hash).toBe("unique-hash");
  });

  it("returns null when hash does not exist", () => {
    expect(getProjectByPathHash("nonexistent")).toBeNull();
  });
});

describe("upsertMemoryDoc", () => {
  it("stores and overwrites the memory doc", () => {
    const p = createProject({ name: "doc", path: "/doc", git_remote: null, path_hash: "hd" });

    upsertMemoryDoc(p.id, "# Initial memory");
    expect(getProjectById(p.id)!.memory_doc).toBe("# Initial memory");

    upsertMemoryDoc(p.id, "# Updated memory");
    expect(getProjectById(p.id)!.memory_doc).toBe("# Updated memory");
  });
});
