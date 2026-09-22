import { CoreErrorType } from "../deps.js";
import { appendTurnOutcomeEvent, createTurnFailureError } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type {
  RegularTurnLifecycleContext,
  RegularTurnLifecycleState,
} from "./turn-command-lifecycle-types.js";
import { recordTurnUsageFact } from "./usage-observability.js";

/** Records a regular-turn failure while preserving already-admitted future input. */
export async function failRegularTurn(
  runtime: AgentRuntimeInternal,
  context: RegularTurnLifecycleContext,
  state: RegularTurnLifecycleState,
  error: unknown,
): Promise<never> {
  context.markTurnFailureHandled();
  const coreError = createTurnFailureError(error, context.turnAbortSignal, "Turn execution failed");
  const preserveQueueAutoDrainOnCancel =
    coreError.type === CoreErrorType.TurnCancelled &&
    runtime.activeForegroundExecution?.preserveQueueAutoDrainOnCancel === true;
  const finishedTarget = await runtime.finishTargetTurnAccounting({
    endedAtMs: Date.now(),
    inputID: context.targetRunInputID,
    startedTarget: state.startedTarget,
    status: coreError.type === CoreErrorType.TurnCancelled ? "paused" : undefined,
    traceContext: context.turnTraceContext,
  });
  if (finishedTarget?.targetID === state.startedTarget?.targetID) {
    state.startedTarget = finishedTarget;
  }
  if (coreError.type === CoreErrorType.TurnCancelled) {
    await runtime.pauseActiveTargetForCancellation(context.turnTraceContext);
    if (state.activeTurn) {
      await runtime.fallbackPendingGuidesToQueue({
        activeTurn: state.activeTurn,
        events: context.events,
        reasonCode: "guide.turnInterrupted",
        traceContext: context.turnTraceContext,
      });
    }
  }
  // 普通 TurnError 只结束当前 turn，不撤销已经 accepted 的 future input。V4 TurnError 投影将队列
  // 切成 error-paused，runtime 同步关闭行内 drain，保留排队输入，等待用户显式继续。
  if (state.activeTurn && coreError.type !== CoreErrorType.TurnCancelled) {
    const pendingInputs = (await runtime.rebuildProjection()).pendingSteerInputs;
    if (pendingInputs.length > 0) {
      runtime.queueAutoDrain = false;
      runtime.queueExternalDrainActive = false;
    }
  } else if (
    state.activeTurn &&
    coreError.type === CoreErrorType.TurnCancelled &&
    !preserveQueueAutoDrainOnCancel &&
    state.activeTurn.pendingInputs.length > 0
  ) {
    // runtime 授权位与投影同步：避免 held 期间新起的 turn drain 后续入队项。
    runtime.queueAutoDrain = false;
    runtime.queueExternalDrainActive = false;
  }

  // background wake 可能在 loopState 初始化前取消；此时仍要保留已 dequeue 的结果事实。
  const backgroundSubagentResultConsumed =
    context.options?.backgroundSubagentResultConsumed === true ||
    state.loopState?.backgroundSubagentResultConsumed === true;
  const workflowResultConsumed =
    context.options?.workflowResultConsumed === true ||
    state.loopState?.workflowResultConsumed === true;
  await appendTurnOutcomeEvent(runtime, {
    coreError,
    events: context.events,
    durationMs: Date.now() - state.turnMachine.state.startedAt.getTime(),
    turnPhase: state.turnMachine.state.phase,
    inputId: context.options?.inputId,
    traceContext: context.turnTraceContext,
    fallbackMessage: "Turn execution failed",
    logEvent: "turn.failed",
    logLabel: "Turn",
    preserveQueueAutoDrainOnCancel,
    backgroundSubagentResultConsumed,
    workflowResultConsumed,
    historyRoundCount: state.loopState?.historyRoundCount,
  });
  await recordTurnUsageFact(runtime, {
    completedAt: Date.now(),
    error: coreError,
    events: context.events,
    startedAt: context.turnStartedAtMs,
    status: coreError.type === CoreErrorType.TurnCancelled ? "cancelled" : "error",
    traceContext: context.turnTraceContext,
    turnId: context.turnId,
    userMessageId: context.userMessageId,
  });
  throw coreError;
}
