import { z } from "zod";
import {
  MEMORY_TEXT_LIMIT,
  MemoryContentSchema,
  MemoryOutcomeSchema,
  MemoryScopeSchema,
} from "../interfaces/memory-store.port.js";
import { MEMORY_PROJECT_KEY_LIMIT } from "../interfaces/memory-store.schemas.js";
import { toToolJsonSchema } from "./json-schema.js";

export const EXPERIENCE_MEMORY_TOOL_NAME = "Memory";
export const EXPERIENCE_MEMORY_MAX_SEARCH_RESULTS = 6;
export const EXPERIENCE_MEMORY_MAX_HISTORY = 5;
export const EXPERIENCE_MEMORY_MAX_EVIDENCE = 3;
export const ExperienceMemoryActionSchema = z.enum([
  "search",
  "get",
  "history",
  "save",
  "update",
  "forget",
]);

const id = z.string().trim().min(1).max(200);
const projectKey = z.string().trim().min(1).max(MEMORY_PROJECT_KEY_LIMIT);
const quote = z.string().trim().min(1).max(600);
const evidenceSummary = z.string().trim().min(1).max(1_000);

export const ExperienceMemoryEvidenceInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), summary: evidenceSummary }).strict(),
  z
    .object({
      kind: z.literal("user"),
      summary: evidenceSummary,
      quote,
      messageId: id.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool"),
      summary: evidenceSummary,
      quote,
      toolCallId: id,
      messageId: id.optional(),
    })
    .strict(),
]);
export type ExperienceMemoryEvidenceInput = z.infer<typeof ExperienceMemoryEvidenceInputSchema>;

const evidenceInputs = z
  .array(ExperienceMemoryEvidenceInputSchema)
  .max(EXPERIENCE_MEMORY_MAX_EVIDENCE);

const SearchInputSchema = z
  .object({
    action: z.literal("search"),
    query: z.string().trim().max(400).optional(),
    scope: z.union([MemoryScopeSchema, z.literal("all")]).optional(),
    limit: z.number().int().min(1).max(EXPERIENCE_MEMORY_MAX_SEARCH_RESULTS).optional(),
  })
  .strict();

const GetInputSchema = z.object({ action: z.literal("get"), id }).strict();

const HistoryInputSchema = z
  .object({
    action: z.literal("history"),
    id,
    limit: z.number().int().min(1).max(EXPERIENCE_MEMORY_MAX_HISTORY).optional(),
  })
  .strict();

const SaveInputSchema = z
  .object({
    action: z.literal("save"),
    scope: MemoryScopeSchema,
    content: MemoryContentSchema,
    outcome: MemoryOutcomeSchema.optional(),
    evidence: evidenceInputs.optional(),
    reviewAfter: z.string().datetime().optional(),
    supersedes: z.object({ id, expectedRevision: z.number().int().positive() }).strict().optional(),
  })
  .strict();

const UpdateInputSchema = z
  .object({
    action: z.literal("update"),
    id,
    expectedRevision: z.number().int().positive(),
    content: MemoryContentSchema.optional(),
    outcome: MemoryOutcomeSchema.optional(),
    evidence: evidenceInputs.optional(),
    reason: z.string().trim().min(1).max(MEMORY_TEXT_LIMIT),
    reviewAfter: z.union([z.string().datetime(), z.null()]).optional(),
  })
  .strict();

const ForgetInputSchema = z
  .object({ action: z.literal("forget"), id, expectedRevision: z.number().int().positive() })
  .strict();

export const ExperienceMemoryInputSchema = z
  .discriminatedUnion("action", [
    SearchInputSchema,
    GetInputSchema,
    HistoryInputSchema,
    SaveInputSchema,
    UpdateInputSchema,
    ForgetInputSchema,
  ])
  .superRefine((input, context) => {
    if (
      input.action === "update" &&
      input.content === undefined &&
      input.outcome === undefined &&
      input.evidence === undefined &&
      input.reviewAfter === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "An update must change content, outcome, evidence, or reviewAfter.",
        path: ["action"],
      });
    }
  });
export type ExperienceMemoryInput = z.infer<typeof ExperienceMemoryInputSchema>;
export const ExperienceMemoryInputJsonSchema = toToolJsonSchema(ExperienceMemoryInputSchema);

const EvidenceOutputSchema = z
  .object({
    kind: z.enum(["agent", "tool", "user"]),
    sessionId: id,
    summary: evidenceSummary,
    quote: quote.optional(),
    messageId: id.optional(),
    toolCallId: id.optional(),
  })
  .strict();

const MemorySummaryOutputSchema = z
  .object({
    id,
    scope: MemoryScopeSchema,
    originProjectKey: projectKey,
    originProjectKeyTruncated: z.boolean(),
    originSessionId: id,
    kind: z.enum(["episode", "fact", "procedure", "preference"]),
    title: z.string().min(1).max(240),
    titleTruncated: z.boolean(),
    summary: z.string().min(1).max(1_200),
    summaryTruncated: z.boolean(),
    outcome: MemoryOutcomeSchema,
    revision: z.number().int().positive(),
    status: z.enum(["active", "superseded"]),
    reviewAfter: z.string().datetime().optional(),
    updatedAt: z.string().min(1).max(40),
  })
  .strict();

const MemoryRecordOutputSchema = z
  .object({
    id,
    scope: MemoryScopeSchema,
    projectKey: projectKey.nullable(),
    projectKeyTruncated: z.boolean(),
    originProjectKey: projectKey,
    originProjectKeyTruncated: z.boolean(),
    originSessionId: id,
    authorAgentId: id.optional(),
    content: MemoryContentSchema,
    contentTruncated: z.boolean(),
    outcome: MemoryOutcomeSchema,
    evidence: z.array(EvidenceOutputSchema).max(EXPERIENCE_MEMORY_MAX_EVIDENCE),
    evidenceCount: z.number().int().nonnegative(),
    evidenceTruncated: z.boolean(),
    revision: z.number().int().positive(),
    status: z.enum(["active", "superseded"]),
    supersededBy: id.optional(),
    reviewAfter: z.string().datetime().optional(),
    createdAt: z.string().min(1).max(40),
    updatedAt: z.string().min(1).max(40),
  })
  .strict();

const MemoryHistoryRevisionOutputSchema = z
  .object({
    revision: z.number().int().positive(),
    operation: z.enum(["save", "update", "supersede"]),
    reason: z.string().max(MEMORY_TEXT_LIMIT).optional(),
    reasonTruncated: z.boolean(),
    outcome: MemoryOutcomeSchema,
    originProjectKey: projectKey,
    originProjectKeyTruncated: z.boolean(),
    originSessionId: id,
    title: z.string().min(1).max(240),
    titleTruncated: z.boolean(),
    summary: z.string().min(1).max(1_200),
    summaryTruncated: z.boolean(),
    evidence: z.array(EvidenceOutputSchema).max(EXPERIENCE_MEMORY_MAX_EVIDENCE),
    evidenceCount: z.number().int().nonnegative(),
    evidenceTruncated: z.boolean(),
    updatedAt: z.string().min(1).max(40),
  })
  .strict();

const ErrorCodeSchema = z.enum([
  "conflict",
  "not_found",
  "invalid",
  "operation_conflict",
  "evidence_invalid",
  "unavailable",
  "storage_error",
]);

const MemoryErrorOutputSchema = z
  .object({
    status: z.literal("error"),
    action: ExperienceMemoryActionSchema,
    code: ErrorCodeSchema,
    message: z.string().min(1).max(500),
    recordId: id.optional(),
  })
  .strict();

const MemorySuccessOutputSchema = z.discriminatedUnion("action", [
  z
    .object({
      status: z.literal("success"),
      action: z.literal("search"),
      query: z.string().max(400),
      records: z.array(MemorySummaryOutputSchema).max(EXPERIENCE_MEMORY_MAX_SEARCH_RESULTS),
    })
    .strict(),
  z
    .object({
      status: z.literal("success"),
      action: z.literal("get"),
      record: MemoryRecordOutputSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("success"),
      action: z.literal("history"),
      revisions: z.array(MemoryHistoryRevisionOutputSchema).max(EXPERIENCE_MEMORY_MAX_HISTORY),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal("success"),
      action: z.literal("save"),
      record: MemoryRecordOutputSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("success"),
      action: z.literal("update"),
      record: MemoryRecordOutputSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("success"),
      action: z.literal("forget"),
      id,
      deleted: z.literal(true),
    })
    .strict(),
]);

export const ExperienceMemoryOutputSchema = z.union([
  MemorySuccessOutputSchema,
  MemoryErrorOutputSchema,
]);
export type ExperienceMemoryOutput = z.infer<typeof ExperienceMemoryOutputSchema>;
export const ExperienceMemoryOutputJsonSchema = toToolJsonSchema(ExperienceMemoryOutputSchema);
