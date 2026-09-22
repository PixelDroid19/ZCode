import type { SessionEvent, TurnCompletePayload, TurnErrorPayload } from "@zcode/contracts";
import type { ConversationDelta, GoalState, SessionControl } from "@zcode/shared/zcode-protocol-v4";
import type { ProductProjectionInternal } from "./product-projection-internal.js";
import { LEGACY_TURN_ERROR_RECOVERABLE_FALLBACK } from "./product-projection-support.js";
import { mapTurnResultToHeaderState } from "./projection-rows.js";

export function onTurnComplete(
  this: ProductProjectionInternal,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnCompletePayload;
  this.outputContinuationTextRowId = null;
  const headerState = mapTurnResultToHeaderState(payload.resultType);
  const header = this.turnHeaderForEvent(event);
  if (header?.executionKind === "controlOnly") {
    // controlOnly 没有 Agent 工时；尤其不能把 duration=0 下发给旧 UI，后者会为了
    // 可读性把 0 秒格式化成“已工作 1 秒”。这里只收口可见轮次，不碰 session control——
    // 除了 draft 的离场（见 leaveDraftAfterControlOnlyTurn）。
    const deltas = [
      ...this.upsertTurnHeader(event, headerState, undefined, payload.historyRoundCount),
      ...this.leaveDraftAfterControlOnlyTurn(
        payload.resultType === "success" ? "completedSuccess" : "completedInterrupted",
      ),
    ];
    this.currentTurnId = null;
    // turn 收口后 model-only 标记随之失效，避免影响下一次归属判断。
    this.currentTurnStartedModelOnly = false;
    return deltas;
  }
  const phase: SessionControl["phase"] =
    payload.resultType === "success"
      ? "completedSuccess"
      : payload.resultType === "cancelled"
        ? "completedInterrupted"
        : "error";
  const streamClose = payload.resultType === "success" ? "complete" : "interrupted";

  // stopPausesActiveGoalTarget：stop 作用于任何 foreground work 时，
  // active/verifying 的 goal 强制进入 paused，等待显式 resumeGoal。
  const goal = this.snapshot.goal;
  const pausedGoal: GoalState | undefined =
    payload.resultType === "cancelled" &&
    (goal?.status === "active" || goal?.status === "verifying")
      ? { ...goal, status: "paused" }
      : undefined;

  // stopKeepsQueueAndDisablesAutoDrain（stop 效果）：中断后 queue 原样保留
  // 且不自动消费 → 形成暂停队列；pauseReason 只用于 UI 解释原因，不参与路由裁决。
  const heldQueue =
    payload.resultType === "cancelled" &&
    payload.preserveQueueAutoDrainOnCancel !== true &&
    this.snapshot.queue.items.length > 0 &&
    (this.snapshot.queue.autoDrain || this.snapshot.queue.pauseReason !== "stopped")
      ? {
          ...this.snapshot.queue,
          autoDrain: false,
          pauseReason: "stopped" as const,
        }
      : undefined;

  const deltas: ConversationDelta[] = [
    ...this.closeStreamingRows(streamClose),
    // turn 终态一并收口在飞的 foreground tool row（收口不变量：被 profile
    // 过滤的 inputText 流必须被不可过滤的 row.upserted 蕴含，见 profiles.ts）。
    ...this.closeOpenToolRows(event, payload.resultType === "cancelled" ? "cancelled" : "error"),
    ...this.upsertTurnHeader(
      event,
      headerState,
      this.activeMsForCompletion(event, payload.duration),
      payload.historyRoundCount,
    ),
    ...(payload.resultType === "success" ? this.markStableForkAssistant(event) : []),
    {
      op: "state.updated",
      patch: this.controlPatch(
        {
          phase,
          sessionEnded: phase !== "error",
          canStop: false,
          stopState: "idle",
          stopTargetKind: "unknown",
          activeWorks: [],
          // 旧 V4 reducer 没有消费 ModelNetworkStatus，补投影后若 turn
          // 直接进入终态仍不清理，会让“重新连接中”残留到下一轮。
          apiRetry: null,
        },
        pausedGoal,
        heldQueue,
      ),
    },
  ];
  this.currentTurnId = null;
  // turn 收口后 model-only 标记随之失效，避免影响下一次归属判断。
  this.currentTurnStartedModelOnly = false;
  return deltas;
}

/**
 * draft 只有一种离场方式：第一轮收口。phase `draft` 的定义是「纯内存、从未有过真实内容、CLI 重启即
 * 消失」；一条 controlOnly 轮一旦收口，会话已有一段持久化的可见历史，再叫 draft 就与
 * 冷恢复矛盾——store 种子会给它一个终态 phase，而活投影却停在 draft。中枢直接启动
 * 的会话只有一条 controlOnly 启动轮，活投影 phase 恒为 draft，sessions-index 摘要因此被 task-index
 * syncer 当 draft 丢弃，侧栏要等重启才出现。所以 controlOnly 收口只在**会话仍是 draft**时推进 phase
 * （成功 → completedSuccess，取消 → completedInterrupted，失败 → error）；非 draft 会话上的控制轮
 * 照旧不碰 session control（goal 的可见 query 轮不得伪造 running / 工时，见 onTurnStarted）。
 */
export function leaveDraftAfterControlOnlyTurn(
  this: ProductProjectionInternal,
  phase: Exclude<SessionControl["phase"], "draft" | "prewarming" | "running">,
): ConversationDelta[] {
  if (this.snapshot.control.phase !== "draft") return [];
  return [
    {
      op: "state.updated",
      patch: this.controlPatch({
        phase,
        sessionEnded: phase !== "error",
        canStop: false,
        stopState: "idle",
        stopTargetKind: "unknown",
        activeWorks: [],
      }),
    },
  ];
}

export function onTurnError(
  this: ProductProjectionInternal,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnErrorPayload;
  this.outputContinuationTextRowId = null;
  if (this.turnHeaderForEvent(event)?.executionKind === "controlOnly") {
    const deltas = [
      ...this.upsertTurnHeader(event, "failed"),
      ...this.leaveDraftAfterControlOnlyTurn("error"),
    ];
    this.currentTurnId = null;
    // turn 收口后 model-only 标记随之失效，避免影响下一次归属判断。
    this.currentTurnStartedModelOnly = false;
    return deltas;
  }
  // TurnError 结束的是当前 turn，
  // 不是已经 accepted 的 future input。旧 reducer 没有 terminal queue patch，core 为了
  // 防止 error 后悬挂只能先发 TurnSteerDiscarded，造成用户消息丢失；现在把现有 queue
  // 原样转成 error-paused，等待显式 setAutoDrain(true) 恢复 FIFO。
  const heldQueue =
    this.snapshot.queue.items.length > 0
      ? {
          ...this.snapshot.queue,
          autoDrain: false,
          pauseReason: "error" as const,
        }
      : undefined;
  return [
    ...this.closeStreamingRows("interrupted"),
    ...this.closeOpenToolRows(event, "error"),
    ...this.upsertTurnHeader(event, "failed"),
    {
      op: "state.updated",
      patch: this.controlPatch(
        {
          phase: "error",
          sessionEnded: false,
          canStop: false,
          stopState: "idle",
          stopTargetKind: "unknown",
          activeWorks: [],
          // 事件侧尚未携带 fault.* 分类，先透传错误类型，待补齐分类后再细化映射。
          lastError: {
            code: payload.error.code ?? payload.error.type ?? "fault.runtime.unknown",
            message: payload.error.message,
            recoverable: payload.error.retryable ?? LEGACY_TURN_ERROR_RECOVERABLE_FALLBACK,
            at: this.ms(event),
            // 旧投影把所有 TurnError 都写成 runtime，丢失 adapter 已识别的 provider/network 事实。
            source: payload.error.attribution?.source ?? "runtime",
            traceId: String(event.traceId),
            ...(payload.error.detail ? { detail: payload.error.detail } : {}),
            ...(payload.error.underlyingErrorMessage
              ? { underlyingErrorMessage: payload.error.underlyingErrorMessage }
              : {}),
            ...(payload.error.underlyingErrorDetail
              ? { underlyingErrorDetail: payload.error.underlyingErrorDetail }
              : {}),
            ...(payload.error.attribution ? { attribution: payload.error.attribution } : {}),
          },
          // 同 onTurnComplete：终态是重试生命周期的兜底清理边界。
          apiRetry: null,
        },
        undefined,
        heldQueue,
      ),
    },
  ];
}
