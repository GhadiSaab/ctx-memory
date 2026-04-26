#!/usr/bin/env node
// quality-test.mjs — end-to-end output quality validator for the ctx-memory pipeline.
//
// Tests the full pipeline (Layer 1 → 2 → 3) on synthetic "hard" scenarios that
// mirror real-world bad patterns (brainstorming Q&A, skill dumps, long assistant replies).
// Then optionally tests against real Claude JSONL sessions.
//
// Each check produces a pass/fail/warn result. Exit code 1 if any hard failures.
//
// Usage:
//   node scripts/quality-test.mjs           # synthetic only
//   node scripts/quality-test.mjs --real    # also run against real JSONL sessions
//   node scripts/quality-test.mjs --verbose # show full memory_doc output

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const verbose   = args.includes("--verbose") || args.includes("-v");
const realWorld = args.includes("--real");

// ─── Colors ───────────────────────────────────────────────────────────────────

const R = "\x1b[0m";
const G = "\x1b[32m";
const RD = "\x1b[31m";
const Y = "\x1b[33m";
const B = "\x1b[1m";
const D = "\x1b[2m";

function ok(msg)   { return `  ${G}✓${R} ${msg}`; }
function fail(msg, why) { return `  ${RD}✗${R} ${msg}${why ? `  ${D}(${why})${R}` : ""}`; }
function warn(msg, why) { return `  ${Y}~${R} ${msg}${why ? `  ${D}(${why})${R}` : ""}`; }

// ─── Load pipeline functions ──────────────────────────────────────────────────

const base = `file://${process.cwd()}/dist/src`;

const [
  { processSession },
  { generateDigest },
  { mergeIntoProjectMemory, serializeMemory },
] = await Promise.all([
  import(`${base}/layer1/combiner.js`),
  import(`${base}/layer2/digest.js`),
  import(`${base}/layer3/memory.js`),
]);

// ─── Run pipeline on messages ─────────────────────────────────────────────────

function runPipeline(messages, events = []) {
  const stamped = messages.map((m, i) => ({
    id: `msg-${i}`,
    session_id: "test-session",
    role: m.role,
    content: m.content,
    index: i,
    timestamp: BigInt(Date.now() + i),
  }));
  const layer1 = processSession(stamped, events);
  const digest = generateDigest(layer1, "completed", 0);
  const emptyMem = {
    project_id: "test-project",
    memory_doc: "",
    architecture: "",
    conventions: [],
    known_issues: [],
    recent_work: [],
    updated_at: 0,
  };
  const memory = mergeIntoProjectMemory(emptyMem, digest, "test-session");
  return { layer1, digest, memory };
}

// ─── Quality checks ───────────────────────────────────────────────────────────

// Returns array of result strings; true failures are tagged with [FAIL]
function qualityChecks(label, { layer1, digest, memory }, extraChecks = []) {
  const results = [];
  const doc = memory.memory_doc;

  // 1. Digest token budget
  if (digest.estimated_tokens > 500) {
    results.push(fail("Digest within 500-token budget", `got ${digest.estimated_tokens}`));
  } else {
    results.push(ok(`Digest tokens: ${digest.estimated_tokens}`));
  }

  // 2. No decision is > 200 chars (full message dumps)
  const longDecisions = digest.decisions.filter(d => d.length > 200);
  if (longDecisions.length > 0) {
    results.push(fail("No full-message decision dumps", `${longDecisions.length} decisions > 200 chars`));
    for (const d of longDecisions) {
      results.push(`       ${D}· "${d.slice(0, 80)}…"${R}`);
    }
  } else {
    results.push(ok(`Decision lengths OK (max: ${Math.max(0, ...digest.decisions.map(d => d.length))} chars)`));
  }

  // 3. No known_issue is > 400 chars (assistant Q&A dumped as errors)
  const longIssues = memory.known_issues.filter(i => i.description.length > 400);
  if (longIssues.length > 0) {
    results.push(fail("No assistant Q&A dumped into Known Issues", `${longIssues.length} issues > 400 chars`));
    for (const i of longIssues) {
      results.push(`       ${D}· "${i.description.slice(0, 80)}…"${R}`);
    }
  } else {
    results.push(ok(`Known Issues clean (${memory.known_issues.length} total)`));
  }

  // 4. Known Issues section in doc should not contain markdown headers (## or ```)
  const issueSection = (() => {
    const m = doc.match(/## Known Issues\n([\s\S]*?)(?=\n## |$)/);
    return m ? m[1] : "";
  })();
  const hasMarkdownInIssues = /^```|^##/m.test(issueSection);
  if (hasMarkdownInIssues) {
    results.push(fail("Known Issues free of embedded markdown blocks", "contains ``` or ## headers"));
  } else {
    results.push(ok("Known Issues section is clean markdown"));
  }

  // 5. Architecture section should not contain long walls of text
  const archSection = (() => {
    const m = doc.match(/## Architecture\n([\s\S]*?)(?=\n## |$)/);
    return m ? m[1] : "";
  })();
  const longArchLines = archSection.split("\n").filter(l => l.length > 200);
  if (longArchLines.length > 0) {
    results.push(fail("Architecture lines are concise", `${longArchLines.length} lines > 200 chars`));
  } else {
    results.push(ok("Architecture section concise"));
  }

  // 6. No decision contains a raw markdown code block
  const decisionsWithCodeBlock = digest.decisions.filter(d => d.includes("```"));
  if (decisionsWithCodeBlock.length > 0) {
    results.push(fail("No code blocks inside decisions", `${decisionsWithCodeBlock.length} decisions contain \`\`\``));
  } else {
    results.push(ok("No code blocks in decisions"));
  }

  // Extra scenario-specific checks
  for (const check of extraChecks) {
    const passed = check.test({ layer1, digest, memory, doc });
    if (passed) {
      results.push(ok(check.label));
    } else if (check.hard) {
      results.push(fail(check.label, check.why));
    } else {
      results.push(warn(check.label, check.why));
    }
  }

  if (verbose) {
    results.push(`\n${D}${doc}${R}\n`);
  }

  const passed = results.filter(r => r.includes(`${G}✓`)).length;
  const failed = results.filter(r => r.includes(`${RD}✗`)).length;
  const warned = results.filter(r => r.includes(`${Y}~`)).length;
  return { results, passed, failed, warned };
}

// ─── Synthetic scenarios ──────────────────────────────────────────────────────

const SCENARIOS = [

  // ── Scenario 1: brainstorming Q&A (the project21 bug) ───────────────────────
  {
    label: "Brainstorming Q&A (skill invocation pattern)",
    description: "Agent uses a brainstorming skill: asks multi-choice questions, user replies 'b', 'yes', etc.",
    messages: [
      { role: "user",      content: "make a learning game that teaches kubernetes, visual and interactive with a clear roadmap" },
      { role: "assistant", content: "I'll invoke the brainstorming skill before starting this project." },
      { role: "user",      content: "Base directory for this skill: /home/user/.claude/plugins/superpowers/brainstorming\n\n# Brainstorming Ideas Into Designs\n\nHelp turn ideas into fully formed designs and specs through natural collaborative dialogue." },
      { role: "assistant", content: "Let me start by exploring the project context." },
      { role: "assistant", content: "Fresh empty repo. Now let me ask the first clarifying question.\n\n**What tech stack do you want to use?**\n\n- **A) Pure web app** — React/Vue + plain CSS/Canvas, runs in any browser with no install\n- **B) React + 3D/animations** — Three.js or Framer Motion for rich visual effects\n- **C) Terminal-based** — ncurses-style, runs in any shell" },
      { role: "user",      content: "b" },
      { role: "assistant", content: "Great choice. Next question:\n\n**What's the target audience's starting level?**\n\n- **A) Complete beginner** — never touched Kubernetes\n- **B) Developer with some container knowledge** — knows Docker, maybe heard of k8s\n- **C) Mixed / adaptive** — adapts to user's answers" },
      { role: "user",      content: "b" },
      { role: "assistant", content: "---\n\n### Skill Tree Structure\n\n8 branches, unlocked sequentially at the root, then freely explorable:\n\n```\n              [Core]\n            /   |   \\\n     [Pods] [Svcs] [Config]\n       |              |\n   [Deploy]       [Secrets]\n```\n\n**I'll use React 18 with TypeScript and Framer Motion for animations.**" },
      { role: "user",      content: "yes" },
      { role: "assistant", content: "---\n\n### UI Layout\n\nThree-panel layout:\n\n```\n┌────────────────────────────────────┐\n│  KUBEQUEST  [Level 3] [XP: 240]   │\n├────────────┬────────────┬──────────┤\n│ Skill Tree │  Terminal  │  Docs    │\n└────────────┴────────────┴──────────┘\n```" },
      { role: "user",      content: "perfect" },
      { role: "assistant", content: "Two issues to fix: React 19 instead of 18, and the mission bar conditionality. Let me check if React 19 is actually a problem here — the Framer Motion version we're using supports it." },
      { role: "user",      content: "ok fix it" },
    ],
    extraChecks: [
      {
        label: "Goal extracted (kubernetes game)",
        hard: true,
        why: "first user message should be goal",
        test: ({ layer1 }) => layer1.goal?.toLowerCase().includes("kubernetes"),
      },
      {
        label: "No multi-choice option lists in Known Issues",
        hard: true,
        why: "brainstorming Q&A should not appear as known issues",
        test: ({ memory }) => !memory.known_issues.some(i => i.description.includes("- **A)") || i.description.includes("- **B)")),
      },
      {
        label: "No skill tree ASCII art in Known Issues",
        hard: true,
        why: "large markdown blocks should not become known issues",
        test: ({ memory }) => !memory.known_issues.some(i => i.description.includes("```")),
      },
      {
        label: "Architecture contains 'React' or 'typescript' or 'Framer'",
        hard: false,
        why: "tech choice in assistant message should reach architecture",
        test: ({ memory }) => /react|typescript|framer/i.test(memory.architecture),
      },
    ],
  },

  // ── Scenario 2: normal coding session (regression baseline) ─────────────────
  {
    label: "Normal coding session (regression baseline)",
    description: "Clean session: user reports bug, assistant fixes, tests pass.",
    messages: [
      { role: "user",      content: "The JWT auth middleware is expiring tokens too early — users are getting logged out after 5 minutes" },
      { role: "assistant", content: "The issue is in auth.py line 42. I'll fix it by reading expiry from an env variable." },
      { role: "user",      content: "ok do it" },
      { role: "assistant", content: "I'll use a short-lived access token (15min) with a long-lived refresh token (7 days) stored in an HttpOnly cookie. This is the industry-standard pattern." },
      { role: "user",      content: "ModuleNotFoundError: No module named 'jwt'" },
      { role: "assistant", content: "Run: pip install PyJWT" },
      { role: "user",      content: "works now, all tests pass" },
    ],
    extraChecks: [
      {
        label: "Goal contains 'JWT' or 'auth'",
        hard: true,
        why: "first user message is the goal",
        test: ({ layer1 }) => /jwt|auth/i.test(layer1.goal ?? ""),
      },
      {
        label: "Error extracted (ModuleNotFoundError)",
        hard: false,
        why: "user message with error should be captured",
        test: ({ digest }) => digest.errors_encountered.some(e => /modulenotfounderror|jwt/i.test(e)),
      },
      {
        label: "Architecture contains token/auth pattern",
        hard: false,
        why: "I'll use short-lived token decision should reach architecture or conventions",
        test: ({ memory }) => /token|jwt|httponl|cookie/i.test(memory.architecture + memory.conventions.join(" ")),
      },
    ],
  },

  // ── Scenario 3: long assistant messages (architecture dump) ──────────────────
  {
    label: "Long assistant messages (architecture explanation)",
    description: "Assistant produces long architecture explanation; user confirms. Should extract meaningful snippets, not dump full text.",
    messages: [
      { role: "user",      content: "how should we structure the backend for this SaaS?" },
      { role: "assistant", content: "Here is the full architecture plan:\n\n## Backend Structure\n\nWe'll use Node.js with Express for the API layer, PostgreSQL for the primary database, Redis for session caching, and S3-compatible object storage for file uploads. Each service runs in its own Docker container orchestrated by Kubernetes.\n\n### Database Schema\n\nUsers table, Workspaces table (multi-tenant), Projects table, Events table for audit logs.\n\n### API Design\n\nRESTful API with JWT authentication. Rate limiting via Redis. Webhook support for integrations.\n\n### Deployment\n\nGitHub Actions CI/CD, deploying to AWS EKS. Blue-green deployments for zero-downtime releases.\n\nThis gives us a solid foundation that scales to millions of users.\n\nShould we go with this approach?" },
      { role: "user",      content: "yes" },
      { role: "assistant", content: "I'll use PostgreSQL as the primary database and Redis for caching. I'll also set up the multi-tenant schema with workspace isolation." },
      { role: "user",      content: "great" },
    ],
    extraChecks: [
      {
        label: "No 300+ char strings in decisions",
        hard: true,
        why: "full architecture dump should not appear as a decision",
        test: ({ digest }) => !digest.decisions.some(d => d.length > 300),
      },
      {
        label: "Architecture mentions postgres or redis or node",
        hard: false,
        why: "tech choices should reach architecture section",
        test: ({ memory }) => /postgres|redis|node|kubernetes|docker/i.test(memory.architecture),
      },
    ],
  },

  // ── Scenario 4: error-heavy session ─────────────────────────────────────────
  {
    label: "Error-heavy session (build failures)",
    description: "Multiple real errors from user, short assistant responses. Errors should be captured cleanly.",
    messages: [
      { role: "user",      content: "build the docker image" },
      { role: "assistant", content: "Running docker build -t myapp:latest ." },
      { role: "user",      content: "ERROR: failed to solve: process \"/bin/sh -c npm install\" did not complete successfully: exit code: 1" },
      { role: "assistant", content: "The npm install failed inside Docker. I'll fix the Dockerfile to use npm ci instead and pin the node version." },
      { role: "user",      content: "ok now i get: TypeError: Cannot read properties of undefined (reading 'config')" },
      { role: "assistant", content: "The config module isn't initialized before use. I'll fix the startup order in index.ts." },
      { role: "user",      content: "fixed, build passes now" },
    ],
    extraChecks: [
      {
        label: "At least one error captured",
        hard: false,
        why: "user error messages should flow into errors_encountered",
        test: ({ digest }) => digest.errors_encountered.length > 0,
      },
      {
        label: "No error is a long assistant explanation",
        hard: true,
        why: "only user messages or short assistant messages should be errors",
        test: ({ memory }) => !memory.known_issues.some(i => i.description.length > 300),
      },
    ],
  },

  // ── Scenario 5: trivial/empty session ───────────────────────────────────────
  {
    label: "Trivial session (no real content)",
    description: "Just a greeting — no goal, no decisions, no errors. Should produce empty sections, not crash.",
    messages: [
      { role: "user",      content: "hello" },
      { role: "assistant", content: "Hi! How can I help you today?" },
    ],
    extraChecks: [
      {
        label: "Pipeline doesn't throw on trivial session",
        hard: true,
        why: "empty/short sessions must not crash",
        test: () => true, // reaching this means it didn't throw
      },
      {
        label: "No garbage in Known Issues",
        hard: true,
        why: "trivial session should produce empty known_issues",
        test: ({ memory }) => memory.known_issues.length === 0,
      },
    ],
  },

];

// ─── Run synthetic scenarios ──────────────────────────────────────────────────

console.log(`\n${B}ctx-memory quality test${R}`);
console.log(`${D}Validating pipeline output quality across synthetic scenarios${R}\n`);

let totalPassed = 0, totalFailed = 0, totalWarned = 0;
const failedScenarios = [];

for (const scenario of SCENARIOS) {
  console.log(`${B}${scenario.label}${R}`);
  console.log(`${D}${scenario.description}${R}`);

  let pipelineResult;
  try {
    pipelineResult = runPipeline(scenario.messages);
  } catch (e) {
    console.log(fail("Pipeline did not throw", e.message));
    failedScenarios.push(scenario.label);
    totalFailed++;
    console.log();
    continue;
  }

  const { results, passed, failed: f, warned } = qualityChecks(
    scenario.label,
    pipelineResult,
    scenario.extraChecks ?? []
  );

  for (const r of results) console.log(r);

  totalPassed += passed;
  totalFailed += f;
  totalWarned += warned;
  if (f > 0) failedScenarios.push(scenario.label);
  console.log();
}

// ─── Real-world JSONL sessions (optional) ────────────────────────────────────

if (realWorld) {
  let { readClaudeSession } = await import(`${base}/wrapper/claude.js`);

  const claudeDir = join(homedir(), ".claude", "projects");
  if (!existsSync(claudeDir)) {
    console.log(warn("Skipping real-world tests", "~/.claude/projects not found"));
  } else {
    console.log(`${B}Real-world JSONL sessions${R}\n`);

    const projectDirs = readdirSync(claudeDir)
      .filter(d => d !== "-" && d.startsWith("-"))
      .map(d => ({
        name: d,
        cwd: d.replace(/-/g, "/"),
        dir: join(claudeDir, d),
      }));

    for (const proj of projectDirs) {
      let jsonlFiles;
      try {
        jsonlFiles = readdirSync(proj.dir).filter(f => f.endsWith(".jsonl"))
          .map(f => join(proj.dir, f))
          .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      } catch { continue; }

      if (jsonlFiles.length === 0) continue;

      const jsonlPath = jsonlFiles[0];
      const mtime = statSync(jsonlPath).mtimeMs;
      const sessionId = "realworld-" + basename(jsonlPath, ".jsonl");

      let data;
      try {
        data = readClaudeSession(proj.cwd, sessionId, mtime - 1);
      } catch { continue; }

      if (!data || data.messages.length === 0) continue;

      console.log(`${B}${proj.name}${R}  ${D}(${data.messages.length} msgs)${R}`);

      let pipelineResult;
      try {
        pipelineResult = runPipeline(data.messages, data.events ?? []);
      } catch (e) {
        console.log(fail("Pipeline did not throw", e.message));
        totalFailed++;
        failedScenarios.push(proj.name);
        console.log();
        continue;
      }

      const { results, passed, failed: f, warned } = qualityChecks(proj.name, pipelineResult);
      for (const r of results) console.log(r);
      totalPassed += passed;
      totalFailed += f;
      totalWarned += warned;
      if (f > 0) failedScenarios.push(proj.name);
      console.log();
    }
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log("─".repeat(60));
console.log(`${B}Quality Results${R}`);
console.log(`  ${G}✓ ${totalPassed} passed${R}   ${Y}~ ${totalWarned} warnings${R}   ${RD}✗ ${totalFailed} failed${R}`);

if (failedScenarios.length > 0) {
  console.log(`\n${RD}Failed scenarios:${R}`);
  for (const s of failedScenarios) console.log(`  - ${s}`);
}

console.log();
process.exit(totalFailed > 0 ? 1 : 0);
