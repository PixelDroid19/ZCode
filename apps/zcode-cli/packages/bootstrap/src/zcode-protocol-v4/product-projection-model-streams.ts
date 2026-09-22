import type {
  AssistantFeedbackUpdatedPayload,
  ModelNetworkStatusPayload,
  SessionEvent,
  StreamRecoveryRetryStartedPayload,
  StreamRecoveryStartedPayload,
} from "@zcode/contracts";
import type {
  ApiRetryState,
  AssistantTextRow,
  ConversationDelta,
  ReasoningRow,
} from "@zcode/shared/zcode-protocol-v4";
import { type CanonicalAssistantSegmentFact } from "./event-normalizer.js";
import type { ProductProjectionInternal } from "./product-projection-internal.js";
import {
  modelRetryReasonCode,
  nonNegativeInteger,
  positiveInteger,
  streamRecoveryReasonCode,
} from "./product-projection-support.js";

export function onModelNetworkStatus(
  this: ProductProjectionInternal,
  event: SessionEvent,
): ConversationDelta[] {
  if (!this.acceptsActiveModelEvent(event)) return [];
  const payload = event.payload as ModelNetworkStatusPayload;
  switch (payload.type) {
    case "model_retry_scheduled": {
      const attempt = positiveInteger(payload.attempt, 1);
      const maxAttempts = Math.max(positiveInteger(payload.maxAttempts, attempt + 1), attempt + 1);
      return this.setApiRetry({
        attempt,
        maxAttempts,
        nextRetryAt: this.ms(event) + nonNegativeInteger(payload.delayMs, 0),
        reasonCode: modelRetryReasonCode(payload.reason),
      });
    }
    case "model_request_started":
      if (payload.streamRecovery) {
        return this.setApiRetry(
          this.streamRecoveryApiRetry(
            payload.streamRecovery.retryNumber,
            payload.streamRecovery.maxRetries,
            this.ms(event),
            this.snapshot.control.apiRetry?.reasonCode ?? "fault.network.sseDisconnected",
          ),
        );
      }
      // adapter attempt=2+ 只说明重试请求已发出，不代表连接恢复；
      // 保持当前状态，等首个有效 text/reasoning/tool 进展再清理，避免标签闪退。
      return positiveInteger(payload.attempt, 1) <= 1 ? this.setApiRetry(null) : [];
    case "model_request_completed":
      return this.setApiRetry(null);
    case "model_request_failed":
      return payload.retryable ? [] : this.setApiRetry(null);
    case "model_stream_stalled":
    case "model_first_provider_event":
    case "model_first_content":
    case "model_first_text":
    // 准入等待的两端是 runtime 观测，不是 UI 状态：
    // 不映射成重试/等待标签。
    case "model_request_queued":
    case "model_request_admitted":
      return [];
  }
}

export function onStreamRecoveryStarted(
  this: ProductProjectionInternal,
  event: SessionEvent,
): ConversationDelta[] {
  if (!this.acceptsActiveModelEvent(event)) return [];
  const payload = event.payload as StreamRecoveryStartedPayload;
  return this.setApiRetry(
    this.streamRecoveryApiRetry(
      payload.retryNumber,
      payload.maxRetries,
      this.ms(event),
      streamRecoveryReasonCode(payload.failureKind),
    ),
  );
}

export function onStreamRecoveryTailDiscarded(
  this: ProductProjectionInternal,
  event: SessionEvent,
): ConversationDelta[] {
  if (!this.acceptsActiveModelEvent(event)) return [];
  // Bug 原因：Core 已用 tail_discarded 切断失败 assistant attempt，但旧 V4 投影忽略该事件，
  // 下一次 reasoning/text 到达时会把旧行误收口为 complete。这里必须先标 interrupted，
  // 让恢复流用新 assistant identity 打开新行，避免 UI 看起来像一次连续完整输出。
  // Bug 原因：断流时已由 tool_input_start 打开、但还没等到 tool_call 定稿的工具行也属于
  // 被作废的 tail——core 只为已提交的工具合成终态，这些行没人收口；恢复请求会用新的
  // toolCallId 再开一行，UI 于是并排出现两张「正在编写工作流」。已提交（running /
  // pendingApproval）的行不在此列，它们的终态由 executor 自己发布。
  return [
    ...this.closeStreamingRows("interrupted"),
    ...this.closeOpenToolRows(event, "cancelled", (row) => row.status === "inputStreaming"),
  ];
}

export function onStreamRecoveryRetryStarted(
  this: ProductProjectionInternal,
  event: SessionEvent,
): ConversationDelta[] {
  if (!this.acceptsActiveModelEvent(event)) return [];
  const payload = event.payload as StreamRecoveryRetryStartedPayload;
  return this.setApiRetry(
    this.streamRecoveryApiRetry(
      payload.retryNumber,
      payload.maxRetries,
      this.ms(event),
      this.snapshot.control.apiRetry?.reasonCode ?? "fault.network.sseDisconnected",
    ),
  );
}

export function streamRecoveryApiRetry(
  this: ProductProjectionInternal,
  retryNumber: number,
  maxRetriesValue: number,
  nextRetryAt: number,
  reasonCode: string,
): ApiRetryState {
  const attempt = positiveInteger(retryNumber, 1);
  const maxRetries = Math.max(positiveInteger(maxRetriesValue, attempt), attempt);
  return {
    attempt,
    maxAttempts: maxRetries + 1,
    nextRetryAt,
    reasonCode,
  };
}

export function setApiRetry(
  this: ProductProjectionInternal,
  apiRetry: ApiRetryState | null,
): ConversationDelta[] {
  const current = this.snapshot.control.apiRetry;
  if (
    current === apiRetry ||
    (current !== null &&
      apiRetry !== null &&
      current.attempt === apiRetry.attempt &&
      current.maxAttempts === apiRetry.maxAttempts &&
      current.nextRetryAt === apiRetry.nextRetryAt &&
      current.reasonCode === apiRetry.reasonCode)
  ) {
    return [];
  }
  return [
    {
      op: "state.updated",
      patch: this.controlPatch({ apiRetry }),
    },
  ];
}

export function acceptsActiveModelEvent(
  this: ProductProjectionInternal,
  event: SessionEvent,
): boolean {
  if (!this.isRunning()) return false;
  // stop/新一轮后旧请求可能迟到；仅凭 session 级状态会让旧 turn 的
  // retry/progress 覆盖当前输入栏。当前 runtime turn 已知时必须按 turnId 隔离。
  return (
    this.currentTurnId === null ||
    event.turnId === undefined ||
    String(event.turnId) === this.currentTurnId
  );
}

export function onModelStreaming(
  this: ProductProjectionInternal,
  fact: CanonicalAssistantSegmentFact,
): ConversationDelta[] {
  const event = fact.event;
  // 迟到终态不复活：非运行期到达的流式事件一律拒收。
  // assistant 守恒：正文类拒收不是无害丢弃——投影建立晚于
  // TurnStarted（订阅中途建 publisher）时，整段回复会静默消失直到刷新
  // （「回复整段消失」的 live 向量）。计数暴露给 gateway：置 stale 标记，
  // 下次订阅强制重新 hydration 从持久事实补齐。
  if (!this.isRunning()) {
    const dropped = fact.stream;
    if (
      dropped.kind === "text_start" ||
      dropped.kind === "text_delta" ||
      dropped.kind === "reasoning_start" ||
      dropped.kind === "reasoning_delta"
    ) {
      this.droppedContentStreamEventCount += 1;
    }
    return [];
  }
  const payload = fact.stream;
  switch (payload.kind) {
    case "text_start":
      return this.openTextRow(event, fact);
    case "text_delta": {
      const open = this.streamingTextRowId === null ? this.openTextRow(event, fact) : [];
      return [
        ...open,
        {
          op: "row.delta",
          rowId: this.streamingTextRowId as number,
          path: "text",
          append: payload.delta,
        },
      ];
    }
    case "text_end":
      return this.closeTextRow("complete");
    case "reasoning_start":
      return this.openReasoningRow(event, fact);
    case "reasoning_delta": {
      const open = this.streamingReasoningRowId === null ? this.openReasoningRow(event, fact) : [];
      return [
        ...open,
        {
          op: "row.delta",
          rowId: this.streamingReasoningRowId as number,
          path: "text",
          append: payload.delta,
        },
      ];
    }
    case "reasoning_end":
      return this.closeReasoningRow();
    case "tool_input_start":
      return this.openToolRow(event, payload, fact.entityId);
    case "tool_input_delta": {
      return this.appendStreamingToolInput(event, payload);
    }
    case "tool_input_end":
      return this.flushStreamingToolInput(String(payload.toolCallId ?? ""));
    case "tool_call":
      return this.finalizeStreamingToolInput(event, payload);
    default:
      return [];
  }
}

export function openTextRow(
  this: ProductProjectionInternal,
  event: SessionEvent,
  fact: CanonicalAssistantSegmentFact,
): ConversationDelta[] {
  const close = this.closeTextRow("complete");
  const continuationRowId = this.outputContinuationTextRowId;
  this.outputContinuationTextRowId = null;
  const continuationRow = continuationRowId === null ? undefined : this.findRow(continuationRowId);
  const currentTurnId = this.turnIdOf(event);
  const lastVisibleRow = this.snapshot.rows.window.at(-1);
  if (
    continuationRow?.kind === "assistantText" &&
    continuationRow.turnId === currentTurnId &&
    lastVisibleRow?.rowId === continuationRow.rowId
  ) {
    // runtime 的 output-token Continue 会为每次 provider 请求创建新的
    // assistantMessageId；旧投影因此把一句话拆成 history partial + 轮尾正文。length
    // 已经在 ModelComplete 上提供精确资格，这里只重新打开紧邻的同 turn text row，
    // 让外部 continuous/replayable 客户端都只观察到一条持续增长的 assistant。
    const {
      actions: _actions,
      assistantResponseId: _assistantResponseId,
      feedback: _feedback,
      ...continuedBase
    } = continuationRow;
    const row: AssistantTextRow = {
      ...continuedBase,
      entityId: fact.entityId,
      ...(fact.stream.assistantResponseId
        ? { assistantResponseId: fact.stream.assistantResponseId }
        : {}),
      state: "streaming",
    };
    this.streamingTextRowId = row.rowId;
    this.entityIdByRowId.set(row.rowId, fact.entityId);
    const previousMessageId = this.messageIdByRowId.get(row.rowId);
    if (previousMessageId) {
      this.outputContinuationRowIdByMessageId.set(previousMessageId, row.rowId);
    }
    if (fact.transcriptMessageId) {
      this.messageIdByRowId.set(row.rowId, fact.transcriptMessageId);
    }
    return [...close, { op: "row.upserted", row }];
  }

  // 不变量：非 output-token Continue 的新段必然新 rowId；已有 streaming 行先收口。
  const row: AssistantTextRow = {
    ...this.rowBase(event, this.turnIdOf(event), fact.entityId),
    kind: "assistantText",
    ...(fact.stream.assistantResponseId
      ? { assistantResponseId: fact.stream.assistantResponseId }
      : {}),
    text: "",
    state: "streaming",
  };
  this.streamingTextRowId = row.rowId;
  this.entityIdByRowId.set(row.rowId, fact.entityId);
  // forkAssistant 锚点：assistant 行 → 权威 messageId（provider 流首帧即带）。
  if (fact.transcriptMessageId) {
    this.messageIdByRowId.set(row.rowId, fact.transcriptMessageId);
  }
  return [...close, { op: "row.appended", row }];
}

export function closeTextRow(
  this: ProductProjectionInternal,
  state: "complete" | "interrupted",
): ConversationDelta[] {
  if (this.streamingTextRowId === null) return [];
  const row = this.findRow(this.streamingTextRowId);
  this.streamingTextRowId = null;
  if (row?.kind !== "assistantText") return [];
  return [{ op: "row.upserted", row: { ...row, state } }];
}

export function onAssistantFeedbackUpdated(
  this: ProductProjectionInternal,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as AssistantFeedbackUpdatedPayload;
  const row = this.snapshot.rows.window.find(
    (candidate): candidate is AssistantTextRow =>
      candidate.kind === "assistantText" && candidate.entityId === payload.entityId,
  );
  if (!row) return [];
  if (payload.feedback === null) {
    if (row.feedback === undefined) return [];
    const { feedback: _removedFeedback, ...withoutFeedback } = row;
    return [{ op: "row.upserted", row: withoutFeedback }];
  }
  if (row.feedback === payload.feedback) return [];
  return [{ op: "row.upserted", row: { ...row, feedback: payload.feedback } }];
}

export function openReasoningRow(
  this: ProductProjectionInternal,
  event: SessionEvent,
  fact: CanonicalAssistantSegmentFact,
): ConversationDelta[] {
  const close = this.closeReasoningRow();
  const row: ReasoningRow = {
    ...this.rowBase(event, this.turnIdOf(event), fact.entityId),
    kind: "reasoning",
    // Bug 原因：canonical stream 已携带 assistant response 身份，但旧投影只在正文与工具行
    // 保存它，UI 因而无法把同 response 的 reasoning 确定性归入 CUA Group。
    ...(fact.stream.assistantResponseId
      ? { assistantResponseId: fact.stream.assistantResponseId }
      : {}),
    text: "",
    state: "streaming",
  };
  this.streamingReasoningRowId = row.rowId;
  this.entityIdByRowId.set(row.rowId, fact.entityId);
  return [...close, { op: "row.appended", row }];
}

export function closeReasoningRow(
  this: ProductProjectionInternal,
  state: "complete" | "interrupted" = "complete",
): ConversationDelta[] {
  if (this.streamingReasoningRowId === null) return [];
  const row = this.findRow(this.streamingReasoningRowId);
  this.streamingReasoningRowId = null;
  if (row?.kind !== "reasoning") return [];
  return [{ op: "row.upserted", row: { ...row, state } }];
}

export function closeStreamingRows(
  this: ProductProjectionInternal,
  state: "complete" | "interrupted",
): ConversationDelta[] {
  return [...this.closeTextRow(state), ...this.closeReasoningRow(state)];
}
