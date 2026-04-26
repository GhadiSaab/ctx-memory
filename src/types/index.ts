// Single entry point — all types imported from here: import type { ... } from "../types/index.js"

export type { UUID, UnixMs, ToolName, SessionOutcome, IdentityMethod, Project, Session } from "./core.js";

export type {
  MessageRole,
  MessageType,
  PatternType,
  KeywordScore,
  Message,
  StructuralFeatures,
  WeightedMessage,
  ConversationPattern,
} from "./messages.js";

export type {
  EventSource,
  EventType,
  EventPayload,
  FilePayload,
  CommandPayload,
  DependencyPayload,
  CommitPayload,
  ErrorPayload,
  DecisionPayload,
  BuildAttemptPayload,
  TestRunPayload,
  ConfigModifiedPayload,
  ExtractedEvent,
} from "./events.js";

export type {
  FactKind,
  FactSource,
  FactDurability,
  DecisionCategory,
  IssueStatus,
  BaseFact,
  GoalFact,
  DecisionFact,
  IssueFact,
  WorkFact,
  ValidationFact,
  KeywordFact,
  ExtractedFact,
  Layer1Output,
  Layer2Digest,
  KnownIssue,
  RecentWorkEntry,
  ProjectMemory,
} from "./layers.js";

export type {
  Config,
  SessionStartInput,
  SessionEndInput,
  GetMemoryInput,
  RecordEventInput,
  SessionStartOutput,
  GetMemoryOutput,
} from "./config.js";

// Runtime schemas (values, not types — needed for zod validation)
export {
  ConfigSchema,
  SessionStartInputSchema,
  SessionEndInputSchema,
  GetMemoryInputSchema,
  RecordEventInputSchema,
} from "./config.js";
