import {
  MemoryAccessIdentitySchema,
  MemoryForgetInputSchema,
  MemoryHistoryLimitSchema,
  MemoryRecordIdSchema,
  MemorySaveInputSchema,
  MemorySearchInputSchema,
  MemoryUpdateInputSchema,
  MEMORY_SEARCH_LIMIT,
  MemoryStoreError,
  type MemoryAccess,
  type MemoryEvidence,
  type MemoryForget,
  type MemoryOutcome,
  type MemorySave,
  type MemorySearch,
  type MemoryUpdate,
} from "@zcode/contracts";

const SEARCH_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "de",
  "del",
  "el",
  "en",
  "es",
  "for",
  "from",
  "in",
  "is",
  "it",
  "la",
  "las",
  "los",
  "of",
  "on",
  "or",
  "para",
  "por",
  "que",
  "se",
  "si",
  "sí",
  "the",
  "to",
  "un",
  "una",
  "with",
  "y",
  "o",
  "sobre",
]);
interface ParseFailure {
  success: false;
  error: { issues: Array<{ message: string }> };
}

interface ParseSuccess<T> {
  success: true;
  data: T;
}

interface RuntimeSchema<T> {
  safeParse(value: unknown): ParseSuccess<T> | ParseFailure;
}

function parseOrInvalid<T>(schema: RuntimeSchema<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const reason = result.error.issues[0]?.message ?? "invalid input";
    throw new MemoryStoreError("invalid", `${label}: ${reason}`);
  }
  return result.data;
}

export function validateAccess(access: MemoryAccess): MemoryAccess {
  const parsed = parseOrInvalid(MemoryAccessIdentitySchema, access, "memory access");
  return {
    ...access,
    projectKey: parsed.projectKey,
    sessionId: parsed.sessionId,
    agentId: parsed.agentId,
  };
}

export function validateSearch(input: MemorySearch): MemorySearch {
  return parseOrInvalid(MemorySearchInputSchema, input, "memory search");
}

export function validateRecordId(id: string): string {
  return parseOrInvalid(MemoryRecordIdSchema, id, "record id");
}

export function validateHistoryLimit(limit?: number): number {
  if (limit === undefined) return MEMORY_SEARCH_LIMIT;
  return parseOrInvalid(MemoryHistoryLimitSchema, limit, "history limit");
}

export function validateSave(input: MemorySave): MemorySave {
  return parseOrInvalid(MemorySaveInputSchema, input, "memory save");
}

export function validateUpdate(input: MemoryUpdate): MemoryUpdate {
  return parseOrInvalid(MemoryUpdateInputSchema, input, "memory update");
}

export function validateForget(input: MemoryForget): MemoryForget {
  return parseOrInvalid(MemoryForgetInputSchema, input, "memory forget");
}

export function validateOutcomeEvidence(outcome: MemoryOutcome, evidence: MemoryEvidence[]): void {
  if (
    outcome === "tests_passed" &&
    !evidence.some((item) => item.kind === "tool" && item.toolCallId?.trim())
  ) {
    throw new MemoryStoreError("invalid", "tests_passed requires tool-call evidence");
  }
  if (
    outcome === "user_confirmed" &&
    !evidence.some((item) => item.kind === "user" && item.messageId?.trim() && item.quote?.trim())
  ) {
    throw new MemoryStoreError("invalid", "user_confirmed requires a user message id and quote");
  }
}

export function validateQueryTokens(query?: string): string[] {
  if (!query?.trim()) return [];
  return Array.from(query.matchAll(/[\p{L}\p{N}]+/gu), ([token]) => token)
    .filter((token) => token.length > 1 && !SEARCH_STOPWORDS.has(token.toLowerCase()))
    .slice(0, 16);
}
