import type { SessionEvent } from "@zcode/contracts";
import type { ConversationDelta, ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { ProductProjectionInternal } from "./product-projection-internal.js";
import { ConversationEditTarget } from "./product-projection-support.js";
/**
 * rewind/edit/retry 的 live 投影截断（editUserQuery/retryTurn 的
 * `row.removed(target 起)`）。RewindTriggered 带 targetMessageId → 反查 rowId →
 * 从该行所属 turn 的首行（turnHeader）起整段移除，让 live 订阅者即时看到截断，
 * 后续 editRerun 新 turn 走既有事件路径追加。冷订阅/刷新的 truncated transcript
 * 由 transcript 合成 hydration 兜底重建。
 * messageId 反查不到（user 行暂无 messageId、或迟到）时返回空，不误删。
 */
export function onRewindTriggered(
  this: ProductProjectionInternal,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    targetMessageId?: string;
    scope?: string;
    branchCutAfterMessageId?: string;
    branchGeneration?: number;
    createdMessageId?: string;
    reason?: string;
  };
  if (payload.scope === "workspace" && payload.reason === "file_summary_rewind") {
    const targetMessageId = payload.targetMessageId;
    if (!targetMessageId) return [];
    const targetRowId = this.rowIdForMessageId(targetMessageId);
    if (targetRowId === null) return [];
    const targetRow = this.findRow(targetRowId);
    if (!targetRow) return [];
    const headerRowId = this.turnHeaderRowIdByTurnId.get(targetRow.turnId);
    const headerRow = headerRowId !== undefined ? this.findRow(headerRowId) : undefined;
    if (headerRow?.kind !== "turnHeader" || !headerRow.fileChanges) return [];
    return [
      {
        op: "row.upserted",
        row: {
          ...headerRow,
          fileChanges: {
            ...headerRow.fileChanges,
            state: "reverted",
          },
        },
      },
    ];
  }
  // 新语义只消费带 branchGeneration/cut 的已提交 conversation rewind；createdMessageId
  // 仅兼容旧 transcript。失败/冲突不发事件，因此不会制造 UI 假截断。
  const applied =
    (payload.branchGeneration !== undefined && payload.branchCutAfterMessageId !== undefined) ||
    payload.createdMessageId !== undefined;
  if ((payload.scope !== "conversation" && payload.scope !== "both") || !applied) return [];
  const targetMessageId = payload.targetMessageId;
  if (!targetMessageId) return [];
  const targetRowId = this.rowIdForMessageId(targetMessageId);
  if (targetRowId === null) return [];
  const targetRow = this.findRow(targetRowId);
  if (!targetRow) return [];
  // 从该行所属 turn 的首行起移除（整段 turn 被 rewind/edit/retry 替换）。
  const turnHeaderRowId = this.turnHeaderRowIdByTurnId.get(targetRow.turnId) ?? targetRowId;
  const fromRowId = Math.min(turnHeaderRowId, targetRowId);
  // 清理被移除行的 messageId/tool 索引，避免悬挂映射。
  for (const [rowId] of this.messageIdByRowId) {
    if (rowId >= fromRowId) this.messageIdByRowId.delete(rowId);
  }
  for (const [messageId, rowId] of this.outputContinuationRowIdByMessageId) {
    if (rowId >= fromRowId) this.outputContinuationRowIdByMessageId.delete(messageId);
  }
  for (const [rowId, entityId] of this.entityIdByRowId) {
    if (rowId >= fromRowId) {
      this.entityIdByRowId.delete(rowId);
      this.editTargetByEntityId.delete(entityId);
    }
  }
  for (const [hookInvocationId, rowId] of this.hookRowIdByInvocationId) {
    if (rowId >= fromRowId) {
      this.rewoundHookInvocationIds.add(hookInvocationId);
      this.hookRowIdByInvocationId.delete(hookInvocationId);
    }
  }
  return [{ op: "row.removed", fromRowId }];
}

/** messageId → rowId 反查（messageIdByRowId 的逆向线性扫描；行数有界，无需额外索引）。 */
export function rowIdForMessageId(
  this: ProductProjectionInternal,
  messageId: string,
): number | null {
  const continuationRowId = this.outputContinuationRowIdByMessageId.get(messageId);
  if (continuationRowId !== undefined) return continuationRowId;
  for (const [rowId, mid] of this.messageIdByRowId) {
    if (mid === messageId) return rowId;
  }
  return null;
}

/**
 * 任意 rowId → 其所属 turn 的 rewind 锚点 messageId。新 live/cold user row 都应
 * 直接携持久 user messageId；同 turn assistant 只保留为旧事件兼容 fallback。
 * `canEdit` 不允许依赖该 fallback，必须由 user row 自身的 exact target 驱动。
 */
export function getTurnRewindAnchor(this: ProductProjectionInternal, rowId: number): string | null {
  return this.rewindAnchorForRows(this.snapshot.rows.window, rowId);
}

export function rewindAnchorForRows(
  this: ProductProjectionInternal,
  rows: readonly ConversationRow[],
  rowId: number,
): string | null {
  const row = rows.find((candidate) => candidate.rowId === rowId);
  if (!row) return null;
  const turnId = row.turnId;
  for (const [candidateRowId, messageId] of this.messageIdByRowId) {
    const candidate = rows.find((item) => item.rowId === candidateRowId);
    if (candidate && candidate.turnId === turnId) return messageId;
  }
  return null;
}

/**
 * real-user row 的展示身份与命令身份必须原子登记。
 * TurnSteerDrained 曾只写 messageId/entityId，漏写 edit target，
 * 导致 UI action 与 editUserQuery resolver 对同一行得出相反结论。
 */
export function registerCanonicalUserRowTarget(
  this: ProductProjectionInternal,
  rowId: number,
  entityId: string,
  editTarget?: ConversationEditTarget,
): void {
  this.entityIdByRowId.set(rowId, entityId);
  if (!editTarget) return;
  this.messageIdByRowId.set(rowId, editTarget.transcriptMessageId);
  this.editTargetByEntityId.set(entityId, editTarget);
}

export function onSessionCreated(
  this: ProductProjectionInternal,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as { contextWindow?: number };
  this.contextWindowState.maxTokens = payload.contextWindow ?? null;
  // draft 语义：会话实体已存在、无 row；phase 保持 draft，无可见 delta。
  return [];
}

export function onSessionTitleUpdated(
  this: ProductProjectionInternal,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    title?: string;
    source?: string;
  };
  const title = payload.title ?? "";
  // core 的 titleSource 有 4 值（default/first_input/generated/custom）；投影 meta 归一为
  // default/generated/custom（first_input 归入 generated：都属"非用户显式"）。
  const source: "default" | "generated" | "custom" =
    payload.source === "custom" ? "custom" : payload.source === "default" ? "default" : "generated";
  const prev = this.snapshot.meta;
  if (prev.titleSource === "custom" && source === "generated") return [];
  if (prev.title === title && prev.titleSource === source) return [];
  return [
    {
      op: "state.updated",
      patch: { meta: { title, titleSource: source } },
    },
  ];
}
