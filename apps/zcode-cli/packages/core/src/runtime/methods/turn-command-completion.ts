import {
  SessionEventType,
  createModelUsageSummaryFromEvents,
  traceContextToLogContext,
} from "../deps.js";
import { scheduleProjectMemoryExtraction } from "../helpers/project-memory-extraction.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { TurnResult } from "../types.js";
import { appendBrowserTurnScreenshot } from "./browser-turn-screenshot.js";
import {
  closeGoalStateChangeReminderDeferral,
  openGoalStateChangeReminderDeferral,
} from "./goal-state-reminder.js";
import { maybeStartDeferredSessionTitleGeneration } from "./session-title.js";
import { persistStableForkCompletionBoundary } from "./stable-fork-boundary.js";
import type {
  RegularTurnLifecycleContext,
  RegularTurnLifecycleState,
} from "./turn-command-lifecycle-types.js";
import { runRegularTurnLoop } from "./turn-loop.js";
import { finishOutputTokenRecovery } from "./turn-output-token-continuation.js";
import { recordTurnUsageFact } from "./usage-observability.js";

/** Completes a prepared loop and publishes its success boundary in persistence order. */
export async function completeRegularTurn(
  runtime: AgentRuntimeInternal,
  context: RegularTurnLifecycleContext,
  state: RegularTurnLifecycleState,
): Promise<TurnResult> {
  const loopState = state.loopState!;
  openGoalStateChangeReminderDeferral(state.activeTurn);
  const phaseStartedAt = context.startTurnPhase("regular_turn_loop");
  try {
    await runRegularTurnLoop.call(runtime, loopState);
    context.completeTurnPhase("regular_turn_loop", phaseStartedAt);
  } finally {
    finishOutputTokenRecovery(loopState.turnRequestState);
    await closeGoalStateChangeReminderDeferral.call(
      runtime,
      state.activeTurn,
      context.turnTraceContext,
    );
  }
  state.turnMachine = loopState.turnMachine;

  const turnUsage = createModelUsageSummaryFromEvents(context.events);
  // goal usage/active-run 先结算，再固定 exact goal/verifier boundary；只有两者都已持久化，
  // TurnComplete 才能让 projection/UI 开放最终 assistant fork。
  await runtime.accountTargetTurnCompletion({
    inputID: context.targetRunInputID,
    startedAtMs: context.turnStartedAtMs,
    startedTarget: state.startedTarget,
    traceContext: context.turnTraceContext,
    usage: turnUsage,
  });
  if (loopState.stableProductStartMessageId && loopState.stableBoundaryAssistantMessageId) {
    await persistStableForkCompletionBoundary(runtime, {
      boundaryMessageId: loopState.stableBoundaryAssistantMessageId,
      startMessageId: loopState.stableProductStartMessageId,
      historyRoundCount: loopState.historyRoundCount,
      traceContext: context.turnTraceContext,
    });
  }
  if (loopState.stableBoundaryAssistantMessageId) {
    await appendBrowserTurnScreenshot(
      runtime,
      loopState,
      loopState.stableBoundaryAssistantMessageId,
    );
  }
  const completeEvent = runtime.createEvent(
    SessionEventType.TurnComplete,
    {
      response: loopState.modelResponse,
      tokenCount: loopState.tokenCount,
      usage: turnUsage,
      toolCallCount: loopState.toolCallCount,
      historyRoundCount: loopState.historyRoundCount,
      duration: Date.now() - state.turnMachine.state.startedAt.getTime(),
      resultType: "success",
      ...(loopState.backgroundSubagentResultConsumed
        ? { backgroundSubagentResultConsumed: true }
        : {}),
      ...(loopState.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
      cacheStats: runtime.messageHistory.getCacheStats(),
      inputId: context.options?.inputId,
    },
    context.turnTraceContext,
  );
  await runtime.appendEvent(completeEvent, context.turnTraceContext);
  context.events.push(completeEvent);
  await recordTurnUsageFact(runtime, {
    completedAt: Date.now(),
    events: context.events,
    startedAt: context.turnStartedAtMs,
    status: "completed",
    traceContext: context.turnTraceContext,
    turnId: context.turnId,
    userMessageId: context.userMessageId,
  });
  if (state.shouldRetryTitleGenerationAfterTurn) {
    // A title waiting on provider runtime headers must not occupy the main turn's refresh window.
    maybeStartDeferredSessionTitleGeneration.call(
      runtime,
      context.displayInput,
      context.userMessageId,
      context.turnTraceContext,
    );
  }
  runtime.turnNumber++;

  const projection = await runtime.rebuildProjection();
  runtime.logger?.info("Turn completed", {
    ...traceContextToLogContext(context.turnTraceContext),
    durationMs: Date.now() - state.turnMachine.state.startedAt.getTime(),
    event: "turn.completed",
    module: "core.runtime",
    status: "completed",
    toolCallCount: loopState.toolCallCount,
  });
  if (context.options?.modelExecution?.memoryExtraction !== "skip") {
    scheduleProjectMemoryExtraction(runtime, {
      model: loopState.model,
      traceContext: context.turnTraceContext,
    });
  }

  return {
    response: loopState.modelResponse,
    turnId: context.turnId,
    traceId: context.traceId,
    usage: turnUsage,
    events: context.events,
    projection,
  };
}
