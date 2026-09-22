import {
  legacySyntheticRuntimeMetadata,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import type {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  Model,
  SessionEvent,
  TraceContext,
} from "../deps.js";
import {
  CompactTimelineStatus,
  SessionEventType,
  buildCompactSummaryMessage,
  buildManualCompactBoundary,
  createCompactBoundaryId,
  createMessageId,
  getUsageTotalTokens,
} from "../deps.js";
import { selectPersistedCompactTail } from "../helpers/compact-preservation.js";
import type { CompactEntrySelection } from "../helpers/index.js";
import {
  buildPostCompactReadStateReminderEntries,
  buildPostCompactRuntimeEntries,
  countCompactPreservedRuntimeMessages,
  estimateRuntimeEntryTokens,
  readApprovedPlanFileReferenceEntry,
} from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { CompactTimelineContext, RuntimeModelTextResult } from "../types.js";
import {
  formatCompactSummaryOrThrow,
  persistCompactTimelineEvent,
} from "./compact-active-helpers.js";
import type { ActiveCompactOptions, ActiveCompactResult } from "./compact-active-types.js";
import {
  filterOutputTokenContinuationEntries,
  preserveCanonicalContextPrefix,
} from "./turn-output-token-continuation.js";

export async function completeActiveCompactConversation(input: {
  activeEntries: readonly RuntimeMessageEntry[];
  attempt: number;
  compactModel: Model;
  compactReason: CompactReason;
  compactTimeline: CompactTimelineContext;
  currentSelection: CompactEntrySelection;
  customInstructions: string | undefined;
  entriesToSummarize: RuntimeMessageEntry[];
  events: SessionEvent[];
  lastSummarizedMessageId: AgentRuntimeInternal["latestConversationMessageId"];
  maxAttempts: number;
  modelTraceContext: TraceContext;
  options: ActiveCompactOptions;
  phase: CompactPhase;
  preCompactTokenCount: number;
  preservedEntries: RuntimeMessageEntry[];
  result: RuntimeModelTextResult;
  runtime: AgentRuntimeInternal;
  trigger: CompactTrigger;
  turnTraceContext: TraceContext;
  useMidConversationSystem: boolean;
}): Promise<ActiveCompactResult> {
  const { runtime } = input;
  const summary = formatCompactSummaryOrThrow(runtime, input.result);
  const persistedSummary = summary;
  const planFileReferenceEntry = runtime.fileSystemPort
    ? await readApprovedPlanFileReferenceEntry({
        abortSignal: input.options.abortSignal,
        fileSystemPort: runtime.fileSystemPort,
        sessionId: runtime.sessionId,
        traceContext: input.modelTraceContext,
        workspaceRoot: runtime.workspaceRoot,
      })
    : undefined;
  const postCompactReminderEntries = [
    ...(planFileReferenceEntry ? [planFileReferenceEntry] : []),
    ...buildPostCompactReadStateReminderEntries({
      preservedEntries: input.preservedEntries,
      readFileState: runtime.readFileState,
    }),
  ];

  const modelCompleteEvent = runtime.createEvent(
    SessionEventType.ModelComplete,
    {
      content: summary,
      stopReason: input.result.finishReason,
      usage: input.result.usage,
      querySource: "compact",
      toolCallCount: 0,
    },
    input.modelTraceContext,
  );
  await runtime.appendEvent(modelCompleteEvent, input.modelTraceContext);
  input.events.push(modelCompleteEvent);

  const summaryMessageId = createMessageId();
  const summaryMessageContent = buildCompactSummaryMessage(persistedSummary, {
    suppressFollowup: true,
  });
  // Continue 没有对应 Session message；无 store 的统计也不能把它计入保留记录。
  const recordablePreservedEntries = filterOutputTokenContinuationEntries(input.preservedEntries);
  const preservation = runtime.sessionStore
    ? await selectPersistedCompactTail({
        sessionStore: runtime.sessionStore,
        sessionId: runtime.sessionId,
        groupsPreserved: input.currentSelection.groupsPreserved,
        summaryMessageId,
      })
    : { keptMessageCount: countCompactPreservedRuntimeMessages(recordablePreservedEntries) };
  const postCompactEntries = buildPostCompactRuntimeEntries(
    input.activeEntries,
    {
      message: {
        role: "user",
        content: summaryMessageContent,
      },
      metadata: legacySyntheticRuntimeMetadata(),
    },
    {
      postCompactReminderEntries,
      preservedEntries: input.preservedEntries,
    },
  );
  const truePostCompactTokenCount = estimateRuntimeEntryTokens(postCompactEntries, {
    useMidConversationSystem: input.useMidConversationSystem,
  });
  const providerPostCompactTokenCount = getUsageTotalTokens(input.result.usage);
  const compactBoundary = buildManualCompactBoundary({
    boundaryId: createCompactBoundaryId(),
    autoCompactThreshold: input.options.autoCompactThreshold,
    compactReason: input.compactReason,
    customInstructions: input.customInstructions,
    lastSummarizedMessageId: input.lastSummarizedMessageId,
    phase: input.phase,
    postCompactTokenCount: providerPostCompactTokenCount,
    preCompactTokenCount: input.preCompactTokenCount,
    summarizedMessageCount: input.entriesToSummarize.length,
    summaryMessageId,
    traceContext: input.turnTraceContext,
    trigger: input.trigger,
    ...(input.currentSelection.groupsPreserved > 0
      ? {
          keptMessageCount: preservation.keptMessageCount,
        }
      : {}),
    preservedSegment: preservation.preservedSegment,
    truePostCompactTokenCount,
    willRetriggerNextTurn:
      input.options.autoCompactThreshold !== undefined
        ? truePostCompactTokenCount >= input.options.autoCompactThreshold
        : undefined,
  });

  await runtime.persistCompactSummary(
    summaryMessageId,
    summaryMessageContent,
    persistedSummary,
    compactBoundary,
    input.modelTraceContext,
    {
      model: input.compactModel,
      operationId: input.compactTimeline.operationId,
      postCompactReminderEntries,
    },
  );

  const compactBoundaryEvent = runtime.createEvent(
    SessionEventType.CompactBoundary,
    compactBoundary,
    input.turnTraceContext,
  );
  await runtime.appendEvent(compactBoundaryEvent, input.turnTraceContext);
  input.events.push(compactBoundaryEvent);

  const compactCompletedPayload = runtime.buildCompactTimelinePayload(input.compactTimeline, {
    ...(input.maxAttempts > 1 ? { attempt: input.attempt, maxAttempts: input.maxAttempts } : {}),
    boundaryId: compactBoundary.boundaryId,
    endedAt: Date.now(),
    postCompactTokenCount: providerPostCompactTokenCount,
    replace: true,
    status: CompactTimelineStatus.Completed,
    summaryMessageId,
    tailStartMessageId: input.lastSummarizedMessageId,
    truePostCompactTokenCount,
  });
  await persistCompactTimelineEvent(
    runtime,
    SessionEventType.CompactCompleted,
    compactCompletedPayload,
    input.turnTraceContext,
    input.events,
  );

  runtime.latestConversationMessageId = summaryMessageId;
  const recordablePostCompactEntries = filterOutputTokenContinuationEntries(postCompactEntries);
  runtime.messageHistory.replaceMessages(
    input.options.activeEntries
      ? preserveCanonicalContextPrefix(
          runtime.messageHistory.borrowReadOnlyRuntimeEntries(),
          recordablePostCompactEntries,
        )
      : recordablePostCompactEntries,
  );
  runtime.readFileState.clear();
  return {
    displayText: "Compacted",
    entries: postCompactEntries,
    outcome: "compacted",
    tokenCount: providerPostCompactTokenCount,
  };
}
