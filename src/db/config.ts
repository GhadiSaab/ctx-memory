// Config key-value store — returns defaults when key is absent, only writes on change.

import { db } from "./connection.js";
import { ConfigSchema } from "../types/index.js";
import type { Config } from "../types/index.js";

// ─── Defaults (derived from zod schema) ──────────────────────────────────────

const DEFAULT_CONFIG = ConfigSchema.parse({}) as Config;

// ─── Statements ───────────────────────────────────────────────────────────────

const stmtGet = db.prepare<[string], { value: string }>(`
  SELECT value FROM config WHERE key = ?
`);

const stmtSet = db.prepare<[string, string, number]>(`
  INSERT INTO config (key, value, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);

const stmtGetAll = db.prepare<[], { key: string; value: string }>(`
  SELECT key, value FROM config
`);

// ─── API ──────────────────────────────────────────────────────────────────────

export function getConfigValue<K extends keyof Config>(key: K): Config[K] {
  const row = stmtGet.get(key as string);
  if (!row) {
    return DEFAULT_CONFIG[key];
  }
  return JSON.parse(row.value) as Config[K];
}

export function setConfigValue<K extends keyof Config>(key: K, value: Config[K]): void {
  stmtSet.run(key as string, JSON.stringify(value), Date.now());
}

/** Returns the full resolved config — DB values merged over defaults. */
export function getConfig(): Config {
  const rows = stmtGetAll.all();
  const overrides: Partial<Record<string, unknown>> = {};
  for (const row of rows) {
    overrides[row.key] = JSON.parse(row.value);
  }
  return ConfigSchema.parse({ ...DEFAULT_CONFIG, ...overrides });
}
