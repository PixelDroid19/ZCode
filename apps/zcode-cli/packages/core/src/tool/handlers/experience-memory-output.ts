import {
  EXPERIENCE_MEMORY_MAX_EVIDENCE,
  MemoryContentSchema,
  type ExperienceMemoryOutput,
  type MemoryEvidence,
  type MemoryRecord,
  type MemoryRevision,
} from "@zcode/contracts";

type MemorySummaryOutput = Extract<
  ExperienceMemoryOutput,
  { status: "success"; action: "search" }
>["records"][number];
type MemoryRecordOutput = Extract<
  ExperienceMemoryOutput,
  { status: "success"; action: "get" }
>["record"];
type MemoryHistoryOutput = Extract<
  ExperienceMemoryOutput,
  { status: "success"; action: "history" }
>["revisions"][number];

const MAX_PROJECT_KEY_CHARS = 160;
const MAX_SEARCH_TITLE_CHARS = 120;
const MAX_SEARCH_SUMMARY_CHARS = 240;
const MAX_RECORD_EVIDENCE_SUMMARY_CHARS = 100;
const MAX_RECORD_EVIDENCE_QUOTE_CHARS = 150;
const MAX_HISTORY_EVIDENCE = 1;
const MAX_HISTORY_REASON_CHARS = 100;
const MAX_HISTORY_TITLE_CHARS = 80;
const MAX_HISTORY_SUMMARY_CHARS = 160;
const MAX_HISTORY_EVIDENCE_SUMMARY_CHARS = 80;
const MAX_HISTORY_EVIDENCE_QUOTE_CHARS = 100;

export function projectMemorySummary(record: MemoryRecord): MemorySummaryOutput {
  const originProjectKey = boundedText(record.originProjectKey, MAX_PROJECT_KEY_CHARS);
  const title = boundedText(record.content.title, MAX_SEARCH_TITLE_CHARS);
  const summary = boundedText(record.content.summary, MAX_SEARCH_SUMMARY_CHARS);
  return {
    id: record.id,
    scope: record.scope,
    originProjectKey: originProjectKey.value,
    originProjectKeyTruncated: originProjectKey.truncated,
    originSessionId: record.originSessionId,
    kind: record.content.kind,
    title: title.value,
    titleTruncated: title.truncated,
    summary: summary.value,
    summaryTruncated: summary.truncated,
    outcome: record.outcome,
    revision: record.revision,
    status: record.status,
    ...(record.reviewAfter === undefined ? {} : { reviewAfter: record.reviewAfter }),
    updatedAt: record.updatedAt,
  };
}

export function projectMemoryRecord(record: MemoryRecord): MemoryRecordOutput {
  const projectKey =
    record.projectKey === null ? undefined : boundedText(record.projectKey, MAX_PROJECT_KEY_CHARS);
  const originProjectKey = boundedText(record.originProjectKey, MAX_PROJECT_KEY_CHARS);
  const content = projectFullContent(record.content);
  const evidence = projectEvidence(
    record.evidence,
    EXPERIENCE_MEMORY_MAX_EVIDENCE,
    MAX_RECORD_EVIDENCE_SUMMARY_CHARS,
    MAX_RECORD_EVIDENCE_QUOTE_CHARS,
  );
  return {
    id: record.id,
    scope: record.scope,
    projectKey: projectKey?.value ?? null,
    projectKeyTruncated: projectKey?.truncated ?? false,
    originProjectKey: originProjectKey.value,
    originProjectKeyTruncated: originProjectKey.truncated,
    originSessionId: record.originSessionId,
    ...(record.authorAgentId === undefined ? {} : { authorAgentId: record.authorAgentId }),
    content: content.content,
    contentTruncated: content.truncated,
    outcome: record.outcome,
    evidence: evidence.items,
    evidenceCount: evidence.count,
    evidenceTruncated: evidence.truncated,
    revision: record.revision,
    status: record.status,
    ...(record.supersededBy === undefined ? {} : { supersededBy: record.supersededBy }),
    ...(record.reviewAfter === undefined ? {} : { reviewAfter: record.reviewAfter }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function projectMemoryHistoryRevision(revision: MemoryRevision): MemoryHistoryOutput {
  const originProjectKey = boundedText(revision.record.originProjectKey, MAX_PROJECT_KEY_CHARS);
  const reason =
    revision.reason === undefined
      ? undefined
      : boundedText(revision.reason, MAX_HISTORY_REASON_CHARS);
  const title = boundedText(revision.record.content.title, MAX_HISTORY_TITLE_CHARS);
  const summary = boundedText(revision.record.content.summary, MAX_HISTORY_SUMMARY_CHARS);
  const evidence = projectEvidence(
    revision.record.evidence,
    MAX_HISTORY_EVIDENCE,
    MAX_HISTORY_EVIDENCE_SUMMARY_CHARS,
    MAX_HISTORY_EVIDENCE_QUOTE_CHARS,
  );
  return {
    revision: revision.revision,
    operation: revision.operation,
    ...(reason === undefined ? {} : { reason: reason.value }),
    reasonTruncated: reason?.truncated ?? false,
    outcome: revision.record.outcome,
    originProjectKey: originProjectKey.value,
    originProjectKeyTruncated: originProjectKey.truncated,
    originSessionId: revision.record.originSessionId,
    title: title.value,
    titleTruncated: title.truncated,
    summary: summary.value,
    summaryTruncated: summary.truncated,
    evidence: evidence.items,
    evidenceCount: evidence.count,
    evidenceTruncated: evidence.truncated,
    updatedAt: revision.record.updatedAt,
  };
}

function projectFullContent(content: MemoryRecord["content"]): {
  content: MemoryRecord["content"];
  truncated: false;
} {
  return { content: MemoryContentSchema.parse(content), truncated: false };
}

function projectEvidence(
  items: readonly MemoryEvidence[],
  limit: number,
  summaryLimit: number,
  quoteLimit: number,
): { items: MemoryEvidence[]; count: number; truncated: boolean } {
  const selected = items.slice(-limit);
  let truncated = items.length > selected.length;
  const projected = selected.map((item) => {
    const summary = boundedText(item.summary, summaryLimit);
    const quote = item.quote === undefined ? undefined : boundedText(item.quote, quoteLimit);
    truncated ||= summary.truncated || (quote?.truncated ?? false);
    return {
      kind: item.kind,
      sessionId: item.sessionId,
      summary: summary.value,
      ...(quote === undefined ? {} : { quote: quote.value }),
      ...(item.messageId === undefined ? {} : { messageId: item.messageId }),
      ...(item.toolCallId === undefined ? {} : { toolCallId: item.toolCallId }),
    };
  });
  return { items: projected, count: items.length, truncated };
}

function boundedText(value: string, maxCharacters: number): { value: string; truncated: boolean } {
  const normalized = value.replace(/\p{Cc}/gu, " ");
  const characters = Array.from(normalized);
  const truncated = normalized !== value || characters.length > maxCharacters;
  if (!truncated) return { value: normalized, truncated: false };
  const visible = characters
    .slice(0, Math.max(0, maxCharacters - 1))
    .join("")
    .trimEnd();
  return { value: visible.length === 0 ? "…" : `${visible}…`, truncated: true };
}
