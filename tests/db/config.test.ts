import { describe, it, expect, beforeEach } from "vitest";
import { getConfigValue, setConfigValue, getConfig } from "../../src/db/index.js";
import { clearDb } from "./helpers.js";

beforeEach(clearDb);

describe("getConfigValue", () => {
  it("returns the schema default when the key has never been set", () => {
    expect(getConfigValue("db_path")).toBe("~/.llm-memory/memory.db");
    expect(getConfigValue("store_raw_messages")).toBe(false);
    expect(getConfigValue("max_digest_tokens")).toBe(500);
    expect(getConfigValue("embedding_model")).toBe("Xenova/all-MiniLM-L6-v2");
    expect(getConfigValue("embedding_enabled")).toBe(true);
    expect(getConfigValue("max_recent_work_entries")).toBe(10);
    expect(getConfigValue("log_level")).toBe("info");
  });

  it("returns the stored value after it has been set", () => {
    setConfigValue("store_raw_messages", true);
    expect(getConfigValue("store_raw_messages")).toBe(true);
  });

  it("returns updated value after overwrite", () => {
    setConfigValue("max_digest_tokens", 300);
    expect(getConfigValue("max_digest_tokens")).toBe(300);

    setConfigValue("max_digest_tokens", 400);
    expect(getConfigValue("max_digest_tokens")).toBe(400);
  });
});

describe("setConfigValue", () => {
  it("persists string values correctly", () => {
    setConfigValue("log_level", "debug");
    expect(getConfigValue("log_level")).toBe("debug");
  });

  it("persists boolean values correctly", () => {
    setConfigValue("embedding_enabled", false);
    expect(getConfigValue("embedding_enabled")).toBe(false);
  });

  it("persists number values correctly", () => {
    setConfigValue("max_recent_work_entries", 25);
    expect(getConfigValue("max_recent_work_entries")).toBe(25);
  });
});

describe("getConfig", () => {
  it("returns defaults for all keys when config table is empty", () => {
    const config = getConfig();
    expect(config.db_path).toBe("~/.llm-memory/memory.db");
    expect(config.store_raw_messages).toBe(false);
    expect(config.max_digest_tokens).toBe(500);
    expect(config.embedding_model).toBe("Xenova/all-MiniLM-L6-v2");
    expect(config.embedding_enabled).toBe(true);
    expect(config.max_recent_work_entries).toBe(10);
    expect(config.log_level).toBe("info");
  });

  it("merges stored values over defaults", () => {
    setConfigValue("log_level", "warn");
    setConfigValue("max_digest_tokens", 200);

    const config = getConfig();
    expect(config.log_level).toBe("warn");
    expect(config.max_digest_tokens).toBe(200);
    // Unset keys still use defaults
    expect(config.store_raw_messages).toBe(false);
    expect(config.embedding_enabled).toBe(true);
  });
});
