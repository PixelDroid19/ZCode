import { z } from "zod";
import {
  MEMORY_SEARCH_LIMIT,
  MEMORY_TEXT_LIMIT,
  MemoryContentSchema,
  MemoryEvidenceSchema,
  MemoryOutcomeSchema,
  MemoryScopeSchema,
} from "./memory-store.port.js";

export const MEMORY_EVIDENCE_LIMIT = 64;
export const MEMORY_HISTORY_LIMIT = 100;
export const MEMORY_PROJECT_KEY_LIMIT = 2_000;

const identifier = z.string().trim().min(1).max(200);
const operationIdentifier = z.string().trim().min(1).max(200);
const expectedRevision = z.number().finite().int().safe().positive();
const reviewTimestamp = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), "must be a valid timestamp")
  .transform((value) => new Date(value).toISOString());

export const MemoryAccessIdentitySchema = z
  .object({
    projectKey: z
      .string()
      .min(1)
      .max(MEMORY_PROJECT_KEY_LIMIT)
      .refine((value) => value.trim().length > 0, "projectKey must not be blank"),
    sessionId: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value.trim().length > 0, "sessionId must not be blank"),
    agentId: z.string().trim().min(1).max(200).optional(),
  })
  .passthrough();

export const MemorySearchInputSchema = z
  .object({
    query: z.string().max(MEMORY_TEXT_LIMIT).optional(),
    scope: z.union([MemoryScopeSchema, z.literal("all")]).optional(),
    limit: z.number().finite().int().safe().min(1).max(MEMORY_SEARCH_LIMIT).optional(),
    includeInactive: z.boolean().optional(),
  })
  .strict();

export const MemoryRecordIdSchema = identifier;
export const MemoryHistoryLimitSchema = z
  .number()
  .finite()
  .int()
  .safe()
  .min(1)
  .max(MEMORY_HISTORY_LIMIT);

const evidenceList = z.array(MemoryEvidenceSchema).max(MEMORY_EVIDENCE_LIMIT);

export const MemorySaveInputSchema = z
  .object({
    operationId: operationIdentifier,
    scope: MemoryScopeSchema,
    content: MemoryContentSchema,
    outcome: MemoryOutcomeSchema.optional(),
    evidence: evidenceList.optional(),
    reviewAfter: reviewTimestamp.optional(),
    supersedes: z.object({ id: identifier, expectedRevision }).strict().optional(),
  })
  .strict();

export const MemoryUpdateInputSchema = z
  .object({
    operationId: operationIdentifier,
    id: identifier,
    expectedRevision,
    content: MemoryContentSchema.optional(),
    outcome: MemoryOutcomeSchema.optional(),
    evidence: evidenceList.optional(),
    reason: z.string().trim().min(1).max(MEMORY_TEXT_LIMIT),
    reviewAfter: z.union([reviewTimestamp, z.null()]).optional(),
  })
  .strict();

export const MemoryForgetInputSchema = z
  .object({ operationId: operationIdentifier, id: identifier, expectedRevision })
  .strict();
