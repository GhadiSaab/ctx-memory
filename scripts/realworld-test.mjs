#!/usr/bin/env node
// Real-world integration test — runs the full pipeline against actual Claude
// JSONL session files in ~/.claude/projects/ and reports pass/fail per check.
//
// Usage:
//   node scripts/realworld-test.mjs
//   node scripts/realworld-test.mjs --project ctx-memory
//   node scripts/realworld-test.mjs --verbose

import { readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const verbose = args.includes("--verbose") || args.includes("-v");
const filterProject = (() => {
  const i = args.indexOf("--project");
  return i >= 0 ? args[i + 1] : null;
})();

// ─── Imports (from local dist/) ───────────────────────────────────────────────

const base = `file://${process.cwd()}/dist/src`;

const [
  { readClaudeSession },
  { processSession },
  { generateDigest },
  { mergeIntoProjectMemory, serializeMemory, deserializeMemory },
  { resolveProject },
] = await Promise.all([
  import(`${base}/wrapper/claude.js`),
  import(`${base}/layer1/combiner.js`),
  import(`${base}/layer2/digest.js`),
  import(`${base}/layer3/memory.js`),
  import(`${base}/wrapper/project.js`),
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const RESET  = "\x1b[0m";
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";

function pass(label) { return `  ${GREEN}✓${RESET} ${label}`; }
function fail(label, detail) { return `  ${RED}✗${RESET} ${label}${detail ? `  ${DIM}(${detail})${RESET}` : ""}`; }
function warn(label, detail) { return `  ${YELLOW}~${RESET} ${label}${detail ? `  ${DIM}(${detail})${RESET}` : ""}`; }

function decodeCwdFromDir(dirName) {
  // -home-ghadi-perso-ctx-memory → /home/ghadi/perso/ctx-memory
  if (!dirName.startsWith("-")) return null;
  return dirName.replace(/-/g, "/");
}

function getJsonlFiles(projectDir) {
  try {
    return readdirSync(projectDir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => join(projectDir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs); // newest first
  } catch {
    return [];
  }
}

// ─── Per-session checks ───────────────────────────────────────────────────────

function checkSession(jsonlPath, cwd) {
  const mtime = statSync(jsonlPath).mtimeMs;
  // sessionStartMs = 1ms before the file's mtime so readClaudeSession always matches it
  const sessionStartMs = mtime - 1;
  const sessionId = "realworld-test-" + basename(jsonlPath, ".jsonl");

  const results = [];
  let data, layer1, digest;

  // Check 1: JSONL reader
  try {
    data = readClaudeSession(cwd, sessionId, sessionStartMs);
    if (!data || data.messages.length === 0) {
      results.push(warn("JSONL reader — 0 messages", "session may be empty or progress-only"));
      return { results, passed: 0, failed: 0, warned: 1 };
    }
    results.push(pass(`JSONL reader — ${data.messages.length} messages, ${data.events.length} events`));
  } catch (e) {
    results.push(fail("JSONL reader threw", e.message));
    return { results, passed: 0, failed: 1, warned: 0 };
  }

  // Check 2: Layer 1
  try {
    layer1 = processSession(data.messages, []);
    results.push(pass(`Layer 1 — goal: ${layer1.goal ? `"${layer1.goal.slice(0, 60)}…"` : "null"}`));
  } catch (e) {
    results.push(fail("Layer 1 threw", e.message));
    return { results, passed: 1, failed: 1, warned: 0 };
  }

  // Check 3: goal extracted
  if (layer1.goal && layer1.goal.length > 0) {
    results.push(pass(`Goal extracted (${layer1.goal.length} chars)`));
  } else {
    results.push(warn("No goal extracted", "session may be too short or no user messages"));
  }

  // Check 4: decisions
  if (layer1.decisions.length > 0) {
    results.push(pass(`Decisions extracted — ${layer1.decisions.length} found`));
    if (verbose) {
      for (const d of layer1.decisions) {
        results.push(`       ${DIM}· ${d.slice(0, 80)}${RESET}`);
      }
    }
  } else {
    results.push(warn("No decisions extracted", "no decision-signal phrases in messages"));
  }

  // Check 5: Layer 2 digest
  try {
    digest = generateDigest(layer1, "completed", 0);
    if (digest.estimated_tokens > 500) {
      results.push(fail(`Digest too large`, `${digest.estimated_tokens} tokens > 500`));
    } else {
      results.push(pass(`Digest OK — ${digest.estimated_tokens} tokens`));
    }
  } catch (e) {
    results.push(fail("Layer 2 threw", e.message));
    return { results, passed: results.filter(r => r.startsWith("  \x1b[32m")).length, failed: 1, warned: 0 };
  }

  // Check 6: files_modified
  if (digest.files_modified.length > 0) {
    results.push(pass(`Files tracked — ${digest.files_modified.length}: ${digest.files_modified.slice(0,3).join(", ")}`));
  } else {
    results.push(warn("No files_modified", "no file write/edit events in session"));
  }

  // Check 7: Layer 3 memory merge
  try {
    const emptyMemory = {
      project_id: "test-project-id",
      memory_doc: "",
      architecture: "",
      conventions: [],
      known_issues: [],
      recent_work: [],
      updated_at: 0,
    };
    const merged = mergeIntoProjectMemory(emptyMemory, digest, sessionId);
    const doc = serializeMemory(merged);
    if (doc.length > 50) {
      results.push(pass(`Layer 3 memory doc — ${doc.length} chars`));
      if (verbose) {
        results.push(`\n${DIM}${doc.slice(0, 400)}${doc.length > 400 ? "\n…" : ""}${RESET}\n`);
      }
    } else {
      results.push(warn("Memory doc very short", `only ${doc.length} chars`));
    }
  } catch (e) {
    results.push(fail("Layer 3 threw", e.message));
  }

  const passed = results.filter(r => r.includes("\x1b[32m✓")).length;
  const failed = results.filter(r => r.includes("\x1b[31m✗")).length;
  const warned = results.filter(r => r.includes("\x1b[33m~")).length;
  return { results, passed, failed, warned };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const claudeProjectsDir = join(homedir(), ".claude", "projects");
if (!existsSync(claudeProjectsDir)) {
  console.error(`No ~/.claude/projects directory found.`);
  process.exit(1);
}

const projectDirs = readdirSync(claudeProjectsDir)
  .filter(d => {
    if (filterProject && !d.includes(filterProject)) return false;
    // skip the root "-" dir
    return d !== "-";
  })
  .map(d => ({ name: d, cwd: decodeCwdFromDir(d), dir: join(claudeProjectsDir, d) }))
  .filter(p => p.cwd !== null);

console.log(`\n${BOLD}ctx-memory real-world test${RESET}`);
console.log(`${DIM}Running pipeline on real Claude JSONL sessions${RESET}\n`);

let totalPassed = 0, totalFailed = 0, totalWarned = 0, totalSessions = 0;
const failedProjects = [];

for (const project of projectDirs) {
  const files = getJsonlFiles(project.dir);
  if (files.length === 0) continue;

  // Test only the most recent JSONL per project (to keep runtime reasonable)
  const jsonlPath = files[0];
  totalSessions++;

  console.log(`${BOLD}${project.name}${RESET}  ${DIM}${jsonlPath}${RESET}`);

  const { results, passed, failed, warned } = checkSession(jsonlPath, project.cwd);
  for (const r of results) console.log(r);

  totalPassed += passed;
  totalFailed += failed;
  totalWarned += warned;
  if (failed > 0) failedProjects.push(project.name);

  console.log();
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log("─".repeat(70));
console.log(`${BOLD}Results across ${totalSessions} projects${RESET}`);
console.log(`  ${GREEN}✓ ${totalPassed} passed${RESET}   ${YELLOW}~ ${totalWarned} warnings${RESET}   ${RED}✗ ${totalFailed} failed${RESET}`);

if (failedProjects.length > 0) {
  console.log(`\n${RED}Failed projects:${RESET}`);
  for (const p of failedProjects) console.log(`  - ${p}`);
}

console.log();
process.exit(totalFailed > 0 ? 1 : 0);
