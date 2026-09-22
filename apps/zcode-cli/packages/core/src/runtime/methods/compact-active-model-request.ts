import type { ModelToolContract } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { Model, SessionEvent, TraceContext } from "../deps.js";
import {
  CompactTrigger,
  SessionEventType,
  buildCompactPrompt,
  createChildTraceContext,
  traceContextToLogContext,
} from "../deps.js";
import type { CompactEntrySelection } from "../helpers/index.js";
import {
  getRuntimeEntriesToSummarize,
  isModelContextExceededError,
  isModelMediaTooLargeError,
  isTurnCancellationError,
  logCompactMediaRetryProjection,
  logMediaBudgetProjection,
  logMediaCapabilityProjection,
  projectCompactMediaForRetry,
  projectMessagesForModelMediaPolicy,
  selectCompactEntriesAfterPromptTooLong,
  truncateCompactSummaryRequestEntriesAfterPromptTooLong,
} from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { CompactTimelineContext, RuntimeModelTextResult } from "../types.js";
import {
  buildCompactSummaryRequestMessages,
  createCompactContextExceededFinishError,
  createCompactPromptTooLongError,
} from "./compact-active-helpers.js";
import {
  canUseCompactSummaryTruncationFallback,
  capCompactSummaryMaxOutputTokens,
} from "./compact-active-selection.js";
import type { ActiveCompactOptions } from "./compact-active-types.js";
import { runCompactSummaryModelRequest } from "./compact-summary-model-request.js";
import { resolveModelRequestSessionTypeFromTaskType } from "./model-request-session-type.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { filterOutputTokenContinuationEntries } from "./turn-output-token-continuation.js";
import { recordModelUsageFact } from "./usage-observability.js";

export async function runActiveCompactSummaryModelRequest(input: {
  activeEntries: readonly RuntimeMessageEntry[];
  attempt: number;
  compactModel: Model;
  compactTimeline: CompactTimelineContext;
  compactTools: ModelToolContract[];
  customInstructions: string | undefined;
  currentSelection: CompactEntrySelection;
  entriesForSummary: RuntimeMessageEntry[];
  entriesToSummarize: RuntimeMessageEntry[];
  events: SessionEvent[];
  options: ActiveCompactOptions;
  preCompactTokenCount: number;
  runtime: AgentRuntimeInternal;
  trigger: CompactTrigger;
  turnTraceContext: TraceContext;
  useMidConversationSystem: boolean;
}): Promise<{
  currentSelection: CompactEntrySelection;
  entriesForSummary: RuntimeMessageEntry[];
  entriesToSummarize: RuntimeMessageEntry[];
  lastSummarizedMessageId: AgentRuntimeInternal["latestConversationMessageId"];
  modelTraceContext: TraceContext;
  preservedEntries: RuntimeMessageEntry[];
  result: RuntimeModelTextResult;
}> {
  const { runtime } = input;
  const lastSummarizedMessageId = runtime.latestConversationMessageId;
  const modelTraceContext = createChildTraceContext(input.turnTraceContext, {
    attributes: {
      model: `${input.compactModel.providerId}/${input.compactModel.modelId}`,
      querySource: "compact",
    },
  });
  const compactPrompt = buildCompactPrompt(input.customInstructions);
  let currentSelection = input.currentSelection;
  let preservedEntries = currentSelection.preservedEntries;
  let entriesForSummary = input.entriesForSummary;
  let entriesToSummarize = input.entriesToSummarize;
  let result: RuntimeModelTextResult;
  let compactPromptTooLongAttempts = 0;
  let stripMediaForSummary = false;
  const reselectEntriesAfterPromptTooLong = (cause: unknown): boolean => {
    const reselected = selectCompactEntriesAfterPromptTooLong({
      currentGroupsPreserved: currentSelection.groupsPreserved,
      entries: input.activeEntries,
      promptTooLongCause: cause,
      trigger: input.trigger,
      useMidConversationSystem: input.useMidConversationSystem,
    });
    if (!reselected) return false;

    compactPromptTooLongAttempts += 1;
    currentSelection = reselected;
    preservedEntries = reselected.preservedEntries;
    entriesForSummary = reselected.entriesForSummary;
    entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
    return true;
  };
  const truncateEntriesAfterPromptTooLong = (cause: unknown): boolean => {
    if (!canUseCompactSummaryTruncationFallback(input.trigger)) return false;

    const truncated = truncateCompactSummaryRequestEntriesAfterPromptTooLong({
      attempt: compactPromptTooLongAttempts,
      cause,
      entriesForSummary,
      logger: runtime.logger,
      traceContext: modelTraceContext,
      useMidConversationSystem: input.useMidConversationSystem,
    });
    if (!truncated) return false;

    compactPromptTooLongAttempts += 1;
    entriesForSummary = truncated;
    entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
    return true;
  };

  while (true) {
    const requestMessages = buildCompactSummaryRequestMessages(entriesForSummary, compactPrompt, {
      useMidConversationSystem: input.useMidConversationSystem,
    });
    const recordableEntries = filterOutputTokenContinuationEntries(entriesForSummary);
    const recordableRequestMessages =
      recordableEntries === entriesForSummary
        ? requestMessages
        : buildCompactSummaryRequestMessages(recordableEntries, compactPrompt, {
            useMidConversationSystem: input.useMidConversationSystem,
          });
    // Compact 曾只执行 capability projection，漏掉普通 turn 共用的聚合
    // 媒体预算；统一走模型媒体策略，避免 summary 请求绕过全局请求上限。
    const mediaPolicyProjection = projectMessagesForModelMediaPolicy(
      requestMessages,
      input.compactModel.properties.inputFormat,
    );
    logMediaCapabilityProjection(
      runtime.logger,
      modelTraceContext,
      mediaPolicyProjection.capabilityProjection,
      {
        event: "compact.request.media_capability_projection",
        message: "Compact request media capability projection",
        model: `${input.compactModel.providerId}/${input.compactModel.modelId}`,
      },
    );
    logMediaBudgetProjection(
      runtime.logger,
      modelTraceContext,
      mediaPolicyProjection.mediaBudgetProjection,
      {
        event: "compact.request.media_projection",
        message: "Compact request media budget projection",
      },
    );
    let projectedRequestMessages = mediaPolicyProjection.messages;
    let projectedRecordableMessages =
      recordableRequestMessages === requestMessages
        ? projectedRequestMessages
        : projectMessagesForModelMediaPolicy(
            recordableRequestMessages,
            input.compactModel.properties.inputFormat,
          ).messages;
    if (stripMediaForSummary) {
      // 复用通用 media budget 文案会污染 summary 的 provider-visible 内容。
      const mediaProjection = projectCompactMediaForRetry(projectedRequestMessages);
      projectedRequestMessages = mediaProjection.messages;
      projectedRecordableMessages =
        recordableRequestMessages === requestMessages
          ? projectedRequestMessages
          : projectCompactMediaForRetry(projectedRecordableMessages).messages;
      logCompactMediaRetryProjection(runtime.logger, modelTraceContext, mediaProjection);
    }

    const modelRequestEvent = runtime.createEvent(
      SessionEventType.ModelRequest,
      {
        // 事件误用了含 Continue 的实际请求数组，导致 query-local 提示进入持久化轨迹。
        // 与 v0.16.6 一致：事件记录过滤后的投影，下面的 provider 请求仍使用完整上下文。
        messages: projectedRecordableMessages,
        providerId: String(input.compactModel.providerId),
        modelId: String(input.compactModel.modelId),
        querySource: "compact",
        toolCount: input.compactTools.length,
        compactPromptTooLongRetry: compactPromptTooLongAttempts,
      },
      modelTraceContext,
    );
    await runtime.appendEvent(modelRequestEvent, modelTraceContext);
    input.events.push(modelRequestEvent);
    const modelStartedAt = Date.now();
    const networkEventStartIndex = input.events.length;
    const compactModelRequest = {
      abortSignal: input.options.abortSignal,
      maxOutputTokens: capCompactSummaryMaxOutputTokens(input.compactModel),
      messages: projectedRequestMessages,
      metadata: traceContextToLogContext(modelTraceContext),
      modelRequestSessionType: resolveModelRequestSessionTypeFromTaskType(runtime.config.taskType),
      modelCall: {
        attributes: {
          compactionOuterAttempt: input.attempt,
          compactionTrigger: input.trigger,
        },
        operation: "context_compaction" as const,
        operationId: input.compactTimeline.operationId,
      },
      statusSink: runtime.createModelStatusSink(modelTraceContext, input.events),
      // compact 的首个真实 provider event 结束 SSE retry 资格；隐藏 partial 在
      // content block 提交前仍可丢弃并 HTTP fallback，block end 后则禁止任何重放。
      preserveProviderStreamBoundaries: true,
      traceContext: modelTraceContext,
      tools: input.compactTools,
      refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(runtime, {
        abortSignal: input.options.abortSignal,
        model: input.compactModel,
        traceContext: modelTraceContext,
      }),
    };

    try {
      result = await runCompactSummaryModelRequest({
        logger: runtime.logger,
        model: input.compactModel,
        request: compactModelRequest,
      });
    } catch (error) {
      await recordModelUsageFact(runtime, {
        attemptIndex: compactPromptTooLongAttempts,
        error,
        events: input.events,
        model: input.compactModel,
        networkEventStartIndex,
        querySource: "compact",
        startedAt: modelStartedAt,
        status: isTurnCancellationError(error, input.options.abortSignal) ? "cancelled" : "error",
        traceContext: modelTraceContext,
      });
      if (isTurnCancellationError(error, input.options.abortSignal)) {
        throw error;
      }
      if (isModelMediaTooLargeError(error) && !stripMediaForSummary) {
        stripMediaForSummary = true;
        runtime.logger?.info("Compact summary hit media-size error; retrying with stripped media", {
          ...traceContextToLogContext(modelTraceContext),
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "compact.request.media_too_large.retry",
          module: "core.runtime",
        });
        continue;
      }
      if (isModelContextExceededError(error)) {
        if (reselectEntriesAfterPromptTooLong(error)) continue;
        if (truncateEntriesAfterPromptTooLong(error)) continue;
        throw createCompactPromptTooLongError({
          attempt: compactPromptTooLongAttempts,
          cause: error,
          preCompactTokenCount: input.preCompactTokenCount,
        });
      }
      throw error;
    }

    await recordModelUsageFact(runtime, {
      attemptIndex: compactPromptTooLongAttempts,
      events: input.events,
      model: input.compactModel,
      networkEventStartIndex,
      querySource: "compact",
      result,
      startedAt: modelStartedAt,
      status: "completed",
      toolCallCount: runtime.extractToolCallsFromResult(result).length,
      traceContext: modelTraceContext,
    });
    const contextError = createCompactContextExceededFinishError(result);
    if (contextError) {
      // compact summary 也可能以 finishReason 返回超窗而不是 throw；
      // 必须先进入同一套 recent preserve 重选逻辑，避免 finishReason 路径丢上下文。
      if (reselectEntriesAfterPromptTooLong(contextError)) continue;
      if (truncateEntriesAfterPromptTooLong(contextError)) continue;
      throw createCompactPromptTooLongError({
        attempt: compactPromptTooLongAttempts,
        cause: contextError,
        preCompactTokenCount: input.preCompactTokenCount,
      });
    }
    return {
      currentSelection,
      entriesForSummary,
      entriesToSummarize,
      lastSummarizedMessageId,
      modelTraceContext,
      preservedEntries,
      result,
    };
  }
}
