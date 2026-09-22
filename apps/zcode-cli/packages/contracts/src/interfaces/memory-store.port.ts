import { z } from "zod";
import type { TraceContext } from "../tracing/tracer.js";

export const MEMORY_TEXT_LIMIT = 4_000;
export const MEMORY_SEARCH_LIMIT = 20;
export const MemoryScopeSchema = z.enum(["project", "user"]);
export const MemoryOutcomeSchema = z.enum([
  "recorded",
  "attempted",
  "tests_passed",
  "user_confirmed",
  "failed",
  "recurring",
]);
const text = z.string().trim().min(1).max(MEMORY_TEXT_LIMIT);
export const MemoryContentSchema = z
  .object({
    topicKey: z.string().trim().min(1).max(160),
    kind: z.enum(["episode", "fact", "procedure", "preference"]),
    title: z.string().trim().min(1).max(240),
    summary: text,
    problem: text.optional(),
    resolution: text.optional(),
    rationale: text.optional(),
    applicability: text.optional(),
    tags: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
  })
  .strict();
export const MemoryEvidenceSchema = z
  .object({
    kind: z.enum(["agent", "tool", "user"]),
    sessionId: z.string().min(1).max(200),
    messageId: z.string().min(1).max(200).optional(),
    toolCallId: z.string().min(1).max(200).optional(),
    quote: text.optional(),
    summary: text,
  })
  .strict();
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;
export type MemoryOutcome = z.infer<typeof MemoryOutcomeSchema>;
export type MemoryContent = z.infer<typeof MemoryContentSchema>;
export type MemoryEvidence = z.infer<typeof MemoryEvidenceSchema>;

/** Runtime supplied; never taken from model tool input. Profile root owns user identity. */
export interface MemoryAccess {
  projectKey: string;
  sessionId: string;
  agentId?: string;
  traceContext?: TraceContext;
  signal?: AbortSignal;
}

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  projectKey: string | null;
  originProjectKey: string;
  originSessionId: string;
  authorAgentId?: string;
  content: MemoryContent;
  outcome: MemoryOutcome;
  evidence: MemoryEvidence[];
  revision: number;
  status: "active" | "superseded";
  supersededBy?: string;
  reviewAfter?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRevision {
  revision: number;
  operation: "save" | "update" | "supersede";
  reason?: string;
  sessionId: string;
  record: MemoryRecord;
}

export interface MemorySearch {
  query?: string;
  scope?: MemoryScope | "all";
  limit?: number;
  includeInactive?: boolean;
}

export interface MemorySave {
  operationId: string;
  scope: MemoryScope;
  content: MemoryContent;
  outcome?: MemoryOutcome;
  evidence?: MemoryEvidence[];
  reviewAfter?: string;
  /** A visible record of the same scope superseded atomically by this new record. */
  supersedes?: { id: string; expectedRevision: number };
}

export interface MemoryUpdate {
  operationId: string;
  id: string;
  expectedRevision: number;
  content?: MemoryContent;
  outcome?: MemoryOutcome;
  evidence?: MemoryEvidence[];
  reason: string;
  reviewAfter?: string | null;
}

export interface MemoryForget {
  operationId: string;
  id: string;
  expectedRevision: number;
}

export class MemoryStoreError extends Error {
  constructor(
    public readonly code: "conflict" | "not_found" | "invalid" | "operation_conflict",
    message: string,
    public readonly recordId?: string,
  ) {
    super(message);
    this.name = "MemoryStoreError";
  }
}

/** One authoritative mutation path. No caller-owned cache may override its revision. */
export interface MemoryStorePort {
  search(access: MemoryAccess, input: MemorySearch): Promise<MemoryRecord[]>;
  get(access: MemoryAccess, id: string): Promise<MemoryRecord | undefined>;
  history(access: MemoryAccess, id: string, limit?: number): Promise<MemoryRevision[]>;
  save(access: MemoryAccess, input: MemorySave): Promise<MemoryRecord>;
  update(access: MemoryAccess, input: MemoryUpdate): Promise<MemoryRecord>;
  forget(access: MemoryAccess, input: MemoryForget): Promise<void>;
}
