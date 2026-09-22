import type { SessionEvent } from "@zcode/contracts";
import {
  ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS,
  isZCodeFileStreamingToolInputPreviewTool,
} from "@zcode/shared";
import type { ConversationDelta, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { shouldHideInvalidToolCallFromProduct } from "../tool-call-product-visibility.js";
import { type CanonicalModelStream } from "./event-normalizer.js";
import type { ProductProjectionInternal } from "./product-projection-internal.js";
import { stringifyToolInput } from "./product-projection-support.js";

export function closeOpenToolRows(
  this: ProductProjectionInternal,
  event: SessionEvent,
  status: "cancelled" | "error",
  only?: (row: ToolCallRow) => boolean,
): ConversationDelta[] {
  if (this.openForegroundToolCallIds.size === 0) return [];
  const openRows: ToolCallRow[] = [];
  for (const toolCallId of this.openForegroundToolCallIds) {
    const row = this.findToolRow(toolCallId);
    // 派生索引不能成为第二份权威状态；收口前始终以当前 snapshot row 复核。
    if (!row || !this.isOpenForegroundToolRow(row)) continue;
    if (only && !only(row)) continue;
    openRows.push(row);
  }
  if (openRows.length === 0) return [];
  // Set 可能因迟到 reopen 改变插入顺序；rowId 单调递增，排序后保持旧 timeline delta 顺序。
  if (openRows.length > 1) {
    openRows.sort((left, right) => left.rowId - right.rowId);
  }
  const deltas: ConversationDelta[] = [];
  const closedToolCallIds = new Set<string>();
  for (const row of openRows) {
    const next: ToolCallRow = {
      ...row,
      status,
      inputText: `${row.inputText ?? ""}${this.takePendingStreamingToolInput(row.toolCallId)}`,
      endedAt: this.ms(event),
    };
    delete next.approvalInteractionId;
    if (status === "error") {
      // executor 早退或事件缺失时，旧投影只在 stop 路径收口工具；
      // success/error turn 会留下运行态行，cold snapshot 缺 header 后被 UI 误判为 thinking。
      next.error = {
        code: "fault.runtime.toolLifecycleIncomplete",
        message: "Tool call ended without a terminal event.",
      };
    } else {
      delete next.error;
    }
    closedToolCallIds.add(row.toolCallId);
    deltas.push({ op: "row.upserted", row: next });
  }

  const pendingInteractions = this.snapshot.pendingInteractions.filter(
    (interaction) =>
      !(
        (interaction.payload.kind === "permission" || interaction.payload.kind === "userInput") &&
        typeof interaction.payload.toolCallId === "string" &&
        closedToolCallIds.has(interaction.payload.toolCallId)
      ),
  );
  if (pendingInteractions.length !== this.snapshot.pendingInteractions.length) {
    deltas.push({ op: "state.updated", patch: { pendingInteractions } });
  }
  return deltas;
}

export function isOpenForegroundToolRow(
  this: ProductProjectionInternal,
  row: ToolCallRow,
): boolean {
  return (
    row.backgrounded !== true &&
    (row.status === "inputStreaming" ||
      row.status === "pendingApproval" ||
      row.status === "running")
  );
}

export function updateToolIndexesAfterDeltas(
  this: ProductProjectionInternal,
  deltas: readonly ConversationDelta[],
): void {
  for (const delta of deltas) {
    if (delta.op === "row.appended" || delta.op === "row.upserted") {
      if (delta.row.kind !== "toolCall") continue;
      if (this.isOpenForegroundToolRow(delta.row)) {
        this.openForegroundToolCallIds.add(delta.row.toolCallId);
      } else {
        this.openForegroundToolCallIds.delete(delta.row.toolCallId);
      }
      continue;
    }
    if (delta.op !== "row.removed") continue;
    for (const [toolCallId, rowId] of this.toolRowIdByCallId) {
      if (rowId < delta.fromRowId) continue;
      // Bug 原因：rewind 过去只删 rows/message 索引，旧 toolCallId 仍会阻止新分支
      // 重新打开同 id 的流式工具；open tracker 也会留下已经不存在的 row。
      this.toolRowIdByCallId.delete(toolCallId);
      this.openForegroundToolCallIds.delete(toolCallId);
      this.fileToolInputPreviewByCallId.delete(toolCallId);
    }
    this.pruneRemovedSubagentIndexes();
  }
}

export function pruneRemovedSubagentIndexes(this: ProductProjectionInternal): void {
  for (const [agentId, rowId] of this.subagentRowIdByAgentId) {
    if (this.findRow(rowId)?.kind === "subagent") continue;
    // Bug 原因：rewind 只重建 rowIndex，旧 agent alias 仍会被后续每次 subagent
    // materialization 枚举。仅在 row.removed 已应用后按权威 snapshot 清理一次，
    // 避免长会话随已删除历史持续增长；普通事件不会扫描该索引。
    this.subagentRowIdByAgentId.delete(agentId);
  }
}

export function openToolRow(
  this: ProductProjectionInternal,
  event: SessionEvent,
  payload: CanonicalModelStream,
  entityId?: string,
): ConversationDelta[] {
  const toolCallId = String(payload.toolCallId ?? "");
  if (
    toolCallId === "" ||
    shouldHideInvalidToolCallFromProduct(payload.toolName) ||
    this.toolRowIdByCallId.has(toolCallId)
  ) {
    return [];
  }
  const row: ToolCallRow = {
    ...this.rowBase(event, this.turnIdOf(event), toolCallId),
    kind: "toolCall",
    ...(payload.assistantResponseId ? { assistantResponseId: payload.assistantResponseId } : {}),
    toolCallId,
    toolName: payload.toolName ?? "",
    status: "inputStreaming",
    inputText: "",
  };
  this.toolRowIdByCallId.set(toolCallId, row.rowId);
  if (isZCodeFileStreamingToolInputPreviewTool(row.toolName)) {
    this.fileToolInputPreviewByCallId.set(toolCallId, {
      lastPublishedAt: null,
      pendingAppend: "",
    });
  }
  if (entityId) this.entityIdByRowId.set(row.rowId, entityId);
  return [{ op: "row.appended", row }];
}

export function appendStreamingToolInput(
  this: ProductProjectionInternal,
  event: SessionEvent,
  payload: CanonicalModelStream,
): ConversationDelta[] {
  const toolCallId = String(payload.toolCallId ?? "");
  const rowId = this.toolRowIdByCallId.get(toolCallId);
  if (rowId === undefined) return [];
  const state = this.fileToolInputPreviewByCallId.get(toolCallId);
  if (!state) {
    return [{ op: "row.delta", rowId, path: "inputText", append: payload.delta }];
  }

  state.pendingAppend += payload.delta;
  const now = this.ms(event);
  if (
    state.lastPublishedAt !== null &&
    now - state.lastPublishedAt < ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS
  ) {
    return [];
  }

  const append = state.pendingAppend;
  state.pendingAppend = "";
  state.lastPublishedAt = now;
  return append === "" ? [] : [{ op: "row.delta", rowId, path: "inputText", append }];
}

export function flushStreamingToolInput(
  this: ProductProjectionInternal,
  toolCallId: string,
): ConversationDelta[] {
  const append = this.takePendingStreamingToolInput(toolCallId);
  if (append === "") return [];
  const rowId = this.toolRowIdByCallId.get(toolCallId);
  return rowId === undefined ? [] : [{ op: "row.delta", rowId, path: "inputText", append }];
}

export function takePendingStreamingToolInput(
  this: ProductProjectionInternal,
  toolCallId: string,
): string {
  const state = this.fileToolInputPreviewByCallId.get(toolCallId);
  this.fileToolInputPreviewByCallId.delete(toolCallId);
  return state?.pendingAppend ?? "";
}

export function finalizeStreamingToolInput(
  this: ProductProjectionInternal,
  event: SessionEvent,
  payload: CanonicalModelStream,
): ConversationDelta[] {
  const toolCallId = String(payload.toolCallId ?? "");
  if (toolCallId === "") return [];
  this.fileToolInputPreviewByCallId.delete(toolCallId);
  if (shouldHideInvalidToolCallFromProduct(payload.toolName)) return [];
  const inputText = stringifyToolInput(payload.input);
  const existing = this.findToolRow(toolCallId);
  if (existing) {
    return [
      {
        op: "row.upserted",
        row: {
          ...existing,
          ...(payload.assistantResponseId
            ? { assistantResponseId: payload.assistantResponseId }
            : {}),
          toolName: existing.toolName || payload.toolName || "",
          inputText,
          input: payload.input,
        },
      },
    ];
  }

  const row: ToolCallRow = {
    ...this.rowBase(event, this.turnIdOf(event), toolCallId),
    kind: "toolCall",
    ...(payload.assistantResponseId ? { assistantResponseId: payload.assistantResponseId } : {}),
    toolCallId,
    toolName: payload.toolName ?? "",
    status: "inputStreaming",
    inputText,
    input: payload.input,
  };
  this.toolRowIdByCallId.set(toolCallId, row.rowId);
  return [{ op: "row.appended", row }];
}
