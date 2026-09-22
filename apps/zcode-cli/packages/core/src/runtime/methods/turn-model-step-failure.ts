import { createRuntimeAssistantEntry } from "../../agent/message-history.js";
import type { MessageId, Model, TraceContext } from "../deps.js";
import { TurnMachineImpl, traceContextToLogContext } from "../deps.js";
import {
  isModelContextExceededError,
  isTurnCancellationError,
  projectExecutionErrorPayload,
  throwIfTurnAborted,
} from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelStreamSnapshot } from "../types.js";
import { persistCancelledStreamSnapshot } from "./cancelled-stream-persistence.js";
import {
  beginStartPlanBusyAdmissionRetryAttempt,
  createStartPlanBusyAutoRetryExhaustedError,
  emitStreamRecoveryRetryEvents,
  emitStreamRecoveryStarted,
  getStartPlanBusyAdmissionRetryDelayMs,
  isStartPlanBusyStreamRecoveryFailure,
} from "./streaming-recovery.js";
import { createStreamingToolCoordinator } from "./streaming-tool-coordinator.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { recordModelHistoryRound } from "./turn-loop-state.js";
import { recoverModelStepAfterContextExceeded } from "./turn-model-step-context-recovery.js";
import type { ModelStepOptions, ModelStepResult } from "./turn-model-step-types.js";
import { recordMainTurnModelUsage } from "./turn-model-step-usage.js";
import {
  commitTurnRequestEntries,
  completeOutputTokenRecovery,
  hasAssistantReasoningContent,
} from "./turn-output-token-continuation.js";

export async function handleModelStepFailure(input: {
  assistantCreatedAt: number;
  assistantMessageId: MessageId;
  error: unknown;
  executionModelSelection: { modelId: string; providerId: string };
  latestFailedModelRequestId: string | undefined;
  latestModelRequestId: string | undefined;
  latestStreamSnapshot: RuntimeModelStreamSnapshot;
  model: Model;
  modelStartedAt: number;
  modelStepIndex: number;
  modelTraceContext: TraceContext;
  networkEventStartIndex: number;
  options: ModelStepOptions;
  runtime: AgentRuntimeInternal;
  state: RegularTurnLoopState;
  streamingToolCoordinator: ReturnType<typeof createStreamingToolCoordinator>;
}): Promise<ModelStepResult> {
  const { runtime, state } = input;
  let finalError = input.error;
  await recordMainTurnModelUsage(runtime, state, {
    assistantMessageId: input.assistantMessageId,
    error: finalError,
    model: input.model,
    modelTraceContext: input.modelTraceContext,
    networkEventStartIndex: input.networkEventStartIndex,
    startedAt: input.modelStartedAt,
    status: state.turnAbortSignal.aborted ? "cancelled" : "error",
  });
  const failedRequestId = input.latestFailedModelRequestId ?? input.latestModelRequestId;
  const toolCallCountBeforeStreamRecovery = state.toolCallCount;
  if (
    await input.streamingToolCoordinator.recoverFromModelFailure(
      input.error,
      input.assistantCreatedAt,
      failedRequestId ? { failedRequestId } : undefined,
    )
  ) {
    if (state.toolCallCount > toolCallCountBeforeStreamRecovery) {
      completeOutputTokenRecovery(state.turnRequestState);
    }
    return "continue";
  }
  const admissionRetryDelayMs = getStartPlanBusyAdmissionRetryDelayMs({
    error: finalError,
    providerId: input.executionModelSelection.providerId,
    state,
    turnNumber: runtime.turnNumber,
  });
  if (!state.turnAbortSignal.aborted && admissionRetryDelayMs !== undefined) {
    // 第二轮及以后 Start Plan 可能在首 token 前被 admission 并发限制拒绝；
    // 这时没有文本或 tool anchor，旧 stream recovery 不会启动，必须关闭空 assistant 后短重试。
    const recoveryAttempt = beginStartPlanBusyAdmissionRetryAttempt(state);
    runtime.logger?.warn("Main turn retrying after Start Plan admission busy", {
      ...traceContextToLogContext(input.modelTraceContext),
      event: "model.main_turn.retry_start_plan_admission_busy",
      module: "core.runtime",
      retryDelayMs: admissionRetryDelayMs,
      retryNumber: recoveryAttempt.retryNumber,
      maxRetries: recoveryAttempt.maxRetries,
      status: "waiting",
    });
    await emitStreamRecoveryStarted(
      runtime,
      state,
      {
        assistantMessageId: input.assistantMessageId,
        ...(failedRequestId ? { failedRequestId } : {}),
        traceContext: input.modelTraceContext,
      },
      finalError,
      recoveryAttempt,
    );
    await runtime.persistAssistantMessage(
      input.assistantMessageId,
      state.userMessageId,
      input.assistantCreatedAt,
      {
        completed: Date.now(),
        finish: "start_plan_admission_retry_discarded",
      },
      input.modelTraceContext,
      input.model,
    );
    state.modelResponse = "";
    state.modelStepCount += 1;
    recordModelHistoryRound(state);
    state.turnMachine = new TurnMachineImpl(state.turnMachine.receiveModelResponse(""));
    state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
    await emitStreamRecoveryRetryEvents(
      runtime,
      state,
      {
        assistantMessageId: input.assistantMessageId,
        ...(failedRequestId ? { failedRequestId } : {}),
        traceContext: input.modelTraceContext,
      },
      {
        ...recoveryAttempt,
        discardedReasoningBytes: 0,
        discardedTextBytes: 0,
        reason: "no_tool_committed",
        toolCallIds: [],
      },
    );
    await input.streamingToolCoordinator.abandon("model_failed");
    await new Promise((resolve) => setTimeout(resolve, admissionRetryDelayMs));
    throwIfTurnAborted(state.turnAbortSignal);
    return "continue";
  }
  if (
    state.streamRecoveryRetryCount > 0 &&
    !state.turnAbortSignal.aborted &&
    isStartPlanBusyStreamRecoveryFailure(finalError)
  ) {
    // Start Plan 运行中断流会先走 core stream recovery；恢复次数耗尽后，
    // 继续抛原 provider 文案会和首轮繁忙失败无法区分，UI 也就不能展示“自动重试达到最大次数”。
    finalError = createStartPlanBusyAutoRetryExhaustedError(finalError);
  }
  await input.streamingToolCoordinator.abandon(
    state.turnAbortSignal.aborted ? "cancelled" : "model_failed",
  );
  if (state.turnAbortSignal.aborted && isTurnCancellationError(finalError, state.turnAbortSignal)) {
    await persistCancelledStreamSnapshot(runtime, {
      assistantCreatedAt: input.assistantCreatedAt,
      assistantMessageId: input.assistantMessageId,
      snapshot: input.latestStreamSnapshot,
      traceContext: input.modelTraceContext,
    });
    const reasoning = input.latestStreamSnapshot.reasoning.filter(hasAssistantReasoningContent);
    if (input.latestStreamSnapshot.text.length > 0 || reasoning.length > 0) {
      // 取消时 durable snapshot 已经持久化，但成功路径的 live history commit
      // 和 historyRoundCount 不会执行，导致当前进程与 cold resume 的 provider history 不一致。
      commitTurnRequestEntries(runtime, state.turnRequestState, [
        createRuntimeAssistantEntry(
          input.latestStreamSnapshot.text,
          undefined,
          reasoning,
          state.model
            ? { providerId: state.model.providerId, modelId: state.model.modelId }
            : undefined,
        ),
      ]);
      recordModelHistoryRound(state);
    }
  }
  const finalErrorRecord =
    finalError && typeof finalError === "object"
      ? (finalError as Record<string, unknown>)
      : undefined;
  const persistedErrorCode =
    typeof finalErrorRecord?.code === "string" ? finalErrorRecord.code : undefined;
  const persistedErrorProjection = projectExecutionErrorPayload(finalError);
  const persistedTurnResult = isTurnCancellationError(finalError, state.turnAbortSignal)
    ? "cancelled"
    : undefined;
  await runtime.persistAssistantMessage(
    input.assistantMessageId,
    state.userMessageId,
    input.assistantCreatedAt,
    {
      completed: Date.now(),
      error: {
        name: finalError instanceof Error ? finalError.name : "UnknownError",
        data: {
          message: finalError instanceof Error ? finalError.message : String(finalError),
          ...(persistedErrorCode ? { code: persistedErrorCode } : {}),
          // live TurnError 有结构化归因，但 transcript 过去未持久化，冷恢复后会丢成 runtime。
          ...(persistedErrorProjection.attribution
            ? { attribution: persistedErrorProjection.attribution }
            : {}),
          // 用户 Stop 的模型中止过去只持久化通用 error name/message，
          // cold hydration 无法区分正常取消和真实 provider 失败，最终错误地生成 TurnError。
          ...(persistedTurnResult ? { turnResult: persistedTurnResult } : {}),
        },
      },
    },
    input.modelTraceContext,
    input.model,
  );
  if (
    isModelContextExceededError(finalError) &&
    (await recoverModelStepAfterContextExceeded(
      runtime,
      state,
      finalError,
      input.modelStepIndex,
      input.options.requestEntries,
    ))
  ) {
    return "continue";
  }
  throw finalError;
}
