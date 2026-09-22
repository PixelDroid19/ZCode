import type { SessionEvent } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import type {
  AssistantTextRow,
  ConversationDelta,
  ConversationRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  applyConversationDeltas,
  applyConversationDeltasMutable,
  createMutableConversationSnapshotAccumulator,
} from "@zcode/shared/zcode-protocol-v4";
import { normalizeConversationEvent } from "./event-normalizer.js";
import { clearSettledOutputPreviews } from "./product-projection-bash-progress.js";
import type { ProductProjectionInternal } from "./product-projection-internal.js";
import { deltaBumpsRevision } from "./projection-state.js";
/** 应用一个权威事件，返回该事件产生的 delta 序列（可能为空）。 */
export function applyEvent(
  this: ProductProjectionInternal,
  event: SessionEvent,
): ConversationDelta[] {
  return this.applyEventInternal(event, true);
}

/**
 * 冷恢复批量路径只允许在尚未发布的候选 projection 上使用。begin 后 rows.window
 * 原地推进，避免每个事件复制增长数组；publisher 在完整校验通过前不会 adopt 候选。
 */
export function beginHydrationReplay(this: ProductProjectionInternal): void {
  if (this.hydrationAccumulator) throw new Error("hydration replay already active");
  this.hydrationAccumulator = createMutableConversationSnapshotAccumulator(this.snapshot);
  this.snapshot = this.hydrationAccumulator.snapshot;
  this.rowIndexById = this.hydrationAccumulator.rowIndexById;
}

export function applyHydrationEvent(
  this: ProductProjectionInternal,
  event: SessionEvent,
): ConversationDelta[] {
  if (!this.hydrationAccumulator) throw new Error("hydration replay is not active");
  return this.applyEventInternal(event, false);
}

/**
 * 把批量期间延迟的 command actions 收敛到当前快照。actions 是同一 reducer 的派生
 * materialization，不单独递增 revision；触发它变化的结构/guard 事件已经记账。
 */
export function completeHydrationReplay(this: ProductProjectionInternal): ConversationDelta[] {
  if (!this.hydrationAccumulator) throw new Error("hydration replay is not active");
  const deltas = this.materializeCommandRowActions([]);
  applyConversationDeltasMutable(this.hydrationAccumulator, deltas);
  this.hydrationAccumulator = null;
  return deltas;
}

export function applyEventInternal(
  this: ProductProjectionInternal,
  event: SessionEvent,
  materializeActions: boolean,
): ConversationDelta[] {
  if (event.type === SessionEventType.SubagentSpawned) {
    const childSessionId = this.stringPayload(
      event.payload as Record<string, unknown>,
      "childSessionId",
    );
    // live spawn 已经过 core persist-before-publish 闸门；若它是旧 ghost 的合法 resume，
    // 以新事件恢复资格。hydration 期间 seed 尚未建立排除集合，不会误放历史引用。
    if (childSessionId) this.invalidSubagentChildSessionIds.delete(childSessionId);
  }
  const runtimeTurnId = String(event.turnId ?? this.currentTurnId ?? "turn-unknown");
  const productTurnId =
    event.type === SessionEventType.TurnStarted
      ? undefined
      : (this.productTurnIdByRuntimeTurnId.get(runtimeTurnId) ?? runtimeTurnId);
  const reduced =
    event.type === SessionEventType.AssistantFeedbackUpdated
      ? this.onAssistantFeedbackUpdated(event)
      : (() => {
          const fact = normalizeConversationEvent(event, {
            productTurnId,
            openAssistantSegments: this.openAssistantSegments(),
          });
          this.normalizationDiagnostics.push(...fact.diagnostics);
          return this.reduce(fact);
        })();
  const subagentDeltas = this.shouldMaterializeSubagentProjection(reduced)
    ? this.materializeSubagentProjection(reduced)
    : [];
  const reducedWithSubagents = [...reduced, ...subagentDeltas];
  // row、命令 target 与 actions 必须属于同一个 materialization transaction。
  // 旧实现只维护 side-map/最新行判断，UI action 由别处推断，cold/tool-only/failed
  // 轮会出现“入口可见但 target 不可解析”，新目标出现后旧入口也不会撤销。
  const deltas = materializeActions
    ? [...reducedWithSubagents, ...this.materializeCommandRowActions(reducedWithSubagents)]
    : reducedWithSubagents;
  const finalDeltas = this.attachRevision(clearSettledOutputPreviews(deltas));
  if (this.hydrationAccumulator) {
    applyConversationDeltasMutable(this.hydrationAccumulator, finalDeltas);
    this.snapshot.seq = event.sequenceNumber;
  } else {
    const previousRowsLength = this.snapshot.rows.window.length;
    this.snapshot = {
      ...applyConversationDeltas(this.snapshot, finalDeltas),
      seq: event.sequenceNumber,
    };
    this.updateRowIndexAfterImmutableApply(previousRowsLength, finalDeltas);
  }
  this.updateToolIndexesAfterDeltas(finalDeltas);
  return finalDeltas;
}

/**
 * 基于本事件归约后的 prospective rows 原子生成 edit/retry actions。
 * action=true 必须蕴含命令层同 revision 下能解析出持久 message target；最新目标
 * 改变时同时 upsert 旧、新两行，客户端不需要按数组位置补推断。
 */
export function materializeCommandRowActions(
  this: ProductProjectionInternal,
  reduced: ConversationDelta[],
): ConversationDelta[] {
  const prospective = applyConversationDeltas(this.snapshot, reduced);
  const rows = prospective.rows.window;
  const rowById = new Map(rows.map((row) => [row.rowId, row]));
  const latestAssistantRowIdByTurn = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "assistantText") continue;
    const current = latestAssistantRowIdByTurn.get(row.turnId);
    if (current === undefined || row.rowId > current) {
      latestAssistantRowIdByTurn.set(row.turnId, row.rowId);
    }
  }
  const compactActive = prospective.control.activeWorks.some((work) => work.kind === "compact");
  const completionBlockingActive = prospective.control.activeWorks.length > 0;
  let latestEditable: ConversationRow | undefined;
  let latestAssistant: AssistantTextRow | undefined;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (
      !latestEditable &&
      !compactActive &&
      row.kind === "userInput" &&
      row.origin === "realUser"
    ) {
      latestEditable = row;
    }
    if (!latestAssistant && row.kind === "assistantText") {
      latestAssistant = row;
    }
    if (latestEditable && latestAssistant) break;
  }
  // 旧逻辑只按“最新完整 assistant”挑 retry，background result 的
  // synthetic turn 因此会错误获得入口；若只在 find 条件里过滤 synthetic，又会跳过
  // 最新 background assistant，让更早真实用户轮的 retry 复活。这里必须先锁定全时间线
  // 最新 assistant，再校验同轮 realUser canonical cause，保证普通 retry 不跨轮回退。
  const latestRetryable = (() => {
    if (
      completionBlockingActive ||
      !latestAssistant ||
      latestAssistant.state !== "complete" ||
      !this.messageIdByRowId.has(latestAssistant.rowId)
    ) {
      return undefined;
    }
    const headerId = this.turnHeaderRowIdByTurnId.get(latestAssistant.turnId);
    const header = headerId === undefined ? undefined : rowById.get(headerId);
    if (header?.kind !== "turnHeader" || header.state === "running") return undefined;
    const canonicalUserRow = rows.find(
      (row) =>
        row.turnId === latestAssistant.turnId &&
        row.kind === "userInput" &&
        row.origin === "realUser",
    );
    const canonicalUserEntityId = canonicalUserRow
      ? this.entityIdByRowId.get(canonicalUserRow.rowId)
      : undefined;
    if (!canonicalUserEntityId || !this.editTargetByEntityId.has(canonicalUserEntityId)) {
      return undefined;
    }
    return latestAssistant;
  })();
  const latestEditableEntityId =
    latestEditable === undefined ? null : (this.entityIdByRowId.get(latestEditable.rowId) ?? null);
  // edit action 与命令 resolver 必须共用 canonical target authority。过去 drain 分支只
  // 登记 messageId，UI 因而显示 Edit，但提交必被 resolver 以 actionUnavailable 拒绝。
  const latestEditableRowId =
    latestEditable &&
    latestEditableEntityId &&
    this.messageIdByRowId.has(latestEditable.rowId) &&
    this.editTargetByEntityId.has(latestEditableEntityId)
      ? latestEditable.rowId
      : null;
  // entity target 历史表会保留旧记录；仅撤销 row action 不足以阻止
  // entityId 直查绕过 latest-only 语义。当前可编辑 authority 与 actions 在同一次
  // materialization 中更新，resolver 不再遍历 rows，也不把 rowId 当 canonical key。
  this.currentEditableEntityId = latestEditableRowId === null ? null : latestEditableEntityId;
  const latestRetryableRowId = latestRetryable?.rowId ?? null;
  const deltas: ConversationDelta[] = [];

  for (const row of rows) {
    if (row.kind !== "turnHeader" && row.kind !== "userInput" && row.kind !== "assistantText")
      continue;
    const nextActions = { ...row.actions };
    if (row.kind === "turnHeader") {
      const canRewindFiles =
        !completionBlockingActive &&
        prospective.pendingInteractions.length === 0 &&
        row.state !== "running" &&
        row.fileChanges?.state === "active";
      if (canRewindFiles) nextActions.canRewindFiles = true;
      else delete nextActions.canRewindFiles;
    } else if (row.kind === "userInput") {
      if (row.rowId === latestEditableRowId) {
        nextActions.canEdit = true;
        nextActions.editDisposition = "rewind";
      } else {
        delete nextActions.canEdit;
        delete nextActions.editDisposition;
      }
    } else {
      if (row.rowId === latestRetryableRowId) nextActions.canRetry = true;
      else delete nextActions.canRetry;
      const headerId = this.turnHeaderRowIdByTurnId.get(row.turnId);
      const header = headerId === undefined ? undefined : rowById.get(headerId);
      const canFork =
        !compactActive &&
        row.state === "complete" &&
        header?.kind === "turnHeader" &&
        header.state === "completedSuccess" &&
        latestAssistantRowIdByTurn.get(row.turnId) === row.rowId &&
        this.messageIdByRowId.has(row.rowId);
      if (canFork) nextActions.canFork = true;
      else delete nextActions.canFork;
    }
    const actions = Object.keys(nextActions).length > 0 ? nextActions : undefined;
    if (JSON.stringify(actions) === JSON.stringify(row.actions)) continue;
    const nextRow: ConversationRow = { ...row, actions };
    if (!actions) delete nextRow.actions;
    deltas.push({ op: "row.upserted", row: nextRow });
  }
  return deltas;
}

export function attachRevision(
  this: ProductProjectionInternal,
  deltas: ConversationDelta[],
): ConversationDelta[] {
  if (!deltas.some(deltaBumpsRevision)) return deltas;
  const revision = this.snapshot.revision + 1;
  const last = deltas[deltas.length - 1];
  if (last?.op === "state.updated") {
    return [...deltas.slice(0, -1), { op: "state.updated", patch: { ...last.patch, revision } }];
  }
  return [...deltas, { op: "state.updated", patch: { revision } }];
}
