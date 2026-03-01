// Re-exports everything — the rest of the codebase imports from "../db/index.js" only.

export { db } from "./connection.js";

export {
  createProject,
  getProjectById,
  getProjectByGitRemote,
  getProjectByPathHash,
  upsertMemoryDoc,
  updateProjectPath,
} from "./projects.js";

export {
  createSession,
  getSessionById,
  getRecentSessionsByProject,
  heartbeat,
  incrementMessageCount,
  closeSession,
  updateSessionGoalAndKeywords,
  updateSessionEmbedding,
  sweepOrphanedSessions,
} from "./sessions.js";

export {
  insertEvent,
  batchInsertEvents,
  getEventsBySession,
  getEventsBySessionAndType,
} from "./events.js";

export {
  writeDigest,
  getDigestBySession,
  getRecentDigestsByProject,
} from "./digests.js";

export {
  insertMessage,
  batchInsertMessages,
  getMessagesBySession,
  countMessagesBySession,
} from "./messages.js";

export {
  createKnownIssue,
  resolveKnownIssue,
  getOpenKnownIssues,
  getAllKnownIssues,
  addRecentWork,
  getRecentWork,
  pruneRecentWork,
} from "./memory.js";

export {
  getConfigValue,
  setConfigValue,
  getConfig,
} from "./config.js";

export {
  searchByEmbedding,
  searchByKeywords,
} from "./search.js";
