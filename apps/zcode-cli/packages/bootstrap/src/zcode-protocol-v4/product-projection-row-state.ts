import type { SessionEvent } from "@zcode/contracts";
import type {
  AssistantTextRow,
  ConversationDelta,
  ConversationRow,
  ConversationSnapshot,
  GoalState,
  SessionControl,
  StatePatch,
  SubagentRow,
  ToolCallRow,
  TurnHeaderRow,
  TurnWorkSegment,
} from "@zcode/shared/zcode-protocol-v4";
import { type CanonicalOpenSegmentIdentity } from "./event-normalizer.js";
import type { ProductProjectionInternal } from "./product-projection-internal.js";
import { computeAvailability, computeInputRouting } from "./projection-state.js";

export function controlPatch(
  this: ProductProjectionInternal,
  control: Partial<SessionControl>,
  goal?: GoalState | null,
  queue?: ConversationSnapshot["queue"],
): StatePatch {
  const next: SessionControl = { ...this.snapshot.control, ...control };
  const nextGoal = goal === undefined ? this.snapshot.goal : goal;
  const nextQueue = queue ?? this.snapshot.queue;
  const context = {
    phase: next.phase,
    goalStatus: nextGoal?.status ?? null,
    // compacting 不是独立 phase（封闭枚举），从 activeWorks 派生。
    compacting: next.activeWorks.some((work) => work.kind === "compact"),
    goalVerifying: next.activeWorks.some((work) => work.kind === "goalVerifier"),
    queueLength: nextQueue.items.length,
    autoDrain: nextQueue.autoDrain,
  };
  return {
    control: next,
    ...(goal === undefined ? {} : { goal }),
    ...(queue === undefined ? {} : { queue }),
    availability: computeAvailability(context),
    inputRouting: computeInputRouting(context, this.snapshot.config.followupMode),
  };
}

export function goalPatch(this: ProductProjectionInternal, goal: GoalState | null): StatePatch {
  return {
    goal,
    availability: computeAvailability(this.deriveContext({ goal })),
  };
}

export function queuePatch(
  this: ProductProjectionInternal,
  queue: ConversationSnapshot["queue"],
): StatePatch {
  const context = this.deriveContext({ queue });
  return {
    queue,
    availability: computeAvailability(context),
    inputRouting: computeInputRouting(context, this.snapshot.config.followupMode),
  };
}

export function deriveContext(
  this: ProductProjectionInternal,
  overrides: {
    goal?: GoalState | null;
    queue?: ConversationSnapshot["queue"];
  },
) {
  const goal = overrides.goal === undefined ? this.snapshot.goal : overrides.goal;
  const queue = overrides.queue ?? this.snapshot.queue;
  return {
    phase: this.snapshot.control.phase,
    goalStatus: goal?.status ?? null,
    compacting: this.snapshot.control.activeWorks.some((work) => work.kind === "compact"),
    goalVerifying: this.snapshot.control.activeWorks.some((work) => work.kind === "goalVerifier"),
    queueLength: queue.items.length,
    autoDrain: queue.autoDrain,
  };
}

export function upsertTurnHeader(
  this: ProductProjectionInternal,
  event: SessionEvent,
  state: "completedSuccess" | "completedInterrupted" | "failed",
  activeMs?: number,
  historyRoundCount?: number,
): ConversationDelta[] {
  const row = this.turnHeaderForEvent(event);
  if (!row) return [];
  const endedAt = this.ms(event);
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        state,
        endedAt,
        ...(activeMs !== undefined ? { activeMs } : {}),
        ...(historyRoundCount !== undefined ? { historyRoundCount } : {}),
        ...(row.workSegments
          ? {
              workSegments: this.completeWorkSegments(row.workSegments, endedAt),
            }
          : {}),
      },
    },
  ];
}

export function openGuidedWorkSegment(
  this: ProductProjectionInternal,
  event: SessionEvent,
  triggerEntityId: string,
): ConversationDelta[] {
  const row = this.turnHeaderForEvent(event);
  if (!row || row.executionKind === "controlOnly") return [];
  const startedAt = this.ms(event);
  const existingSegments: TurnWorkSegment[] = row.workSegments ?? [
    {
      segmentId: `${row.turnId}:initial`,
      startedAt: row.startedAt,
    },
  ];
  // 旧 UI 为整个 product turn 只维护一个折叠状态，accepted guide 只能
  // 作为普通行插入，无法恢复独立工作区。分段边界必须由 CLI 记录，React 不能按邻接行猜。
  const workSegments = [
    ...this.completeWorkSegments(existingSegments, startedAt),
    {
      segmentId: triggerEntityId,
      triggerEntityId,
      startedAt,
    },
  ];
  return [{ op: "row.upserted", row: { ...row, workSegments } }];
}

export function completeWorkSegments(
  this: ProductProjectionInternal,
  segments: readonly TurnWorkSegment[],
  endedAt: number,
): TurnWorkSegment[] {
  return segments.map((segment, index) =>
    index === segments.length - 1 && segment.endedAt === undefined
      ? {
          ...segment,
          endedAt,
          activeMs: Math.max(0, endedAt - segment.startedAt),
        }
      : segment,
  );
}

export function turnHeaderForEvent(
  this: ProductProjectionInternal,
  event: SessionEvent,
): TurnHeaderRow | undefined {
  const rowId = this.turnHeaderRowIdByTurnId.get(this.turnIdOf(event));
  if (rowId === undefined) return undefined;
  const row = this.findRow(rowId);
  return row?.kind === "turnHeader" ? row : undefined;
}

export function markStableForkAssistant(
  this: ProductProjectionInternal,
  event: SessionEvent,
): ConversationDelta[] {
  const turnId = this.turnIdOf(event);
  const rows = this.snapshot.rows.window;
  const headerRowId = this.turnHeaderRowIdByTurnId.get(turnId);
  const headerIndex = headerRowId === undefined ? undefined : this.rowIndexById.get(headerRowId);
  const startIndex = headerIndex === undefined ? 0 : headerIndex + 1;
  let row: AssistantTextRow | undefined;
  // 性能问题根因：旧实现每个成功 turn 都复制并反转完整历史 rows，冷恢复会累积为
  // 近似 O(turns * rows) 的分配与扫描。当前 turn 的行只会出现在自身 header 之后。
  for (let index = rows.length - 1; index >= startIndex; index -= 1) {
    const candidate = rows[index];
    if (candidate?.kind !== "assistantText" || candidate.turnId !== turnId) continue;
    row = candidate;
    break;
  }
  if (!row || !this.messageIdByRowId.has(row.rowId)) return [];
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        state: "complete",
        actions: { ...row.actions, canFork: true },
      },
    },
  ];
}

export function isRunning(this: ProductProjectionInternal): boolean {
  const phase = this.snapshot.control.phase;
  return phase === "running" || phase === "prewarming";
}

export function isMirroredSubagentToolEvent(
  this: ProductProjectionInternal,
  event: SessionEvent,
): boolean {
  const payload = event.payload as unknown as Record<string, unknown>;
  // Bug 原因：child tool lifecycle 会镜像到父 runtime，但它不是父 session 的工具事实。
  // V4 过去把 mirror 当普通 ToolCallRow，导致 main timeline 展示 child 的 Read/Bash，
  // 并让 replayable snapshot 同样带上脏 row。完整工具历史只应由 child topic 物化。
  return payload.source === "subagent";
}

export function openAssistantSegments(
  this: ProductProjectionInternal,
): Partial<Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>> {
  const segments: Partial<Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>> = {};
  const text = this.openSegmentIdentity(this.streamingTextRowId);
  const reasoning = this.openSegmentIdentity(this.streamingReasoningRowId);
  if (text) segments.text = text;
  if (reasoning) segments.reasoning = reasoning;
  return segments;
}

export function openSegmentIdentity(
  this: ProductProjectionInternal,
  rowId: number | null,
): CanonicalOpenSegmentIdentity | null {
  if (rowId === null) return null;
  const entityId = this.entityIdByRowId.get(rowId);
  if (!entityId) return null;
  return {
    entityId,
    transcriptMessageId: this.messageIdByRowId.get(rowId) ?? null,
  };
}

export function rowBase(
  this: ProductProjectionInternal,
  event: SessionEvent,
  turnId: string,
  entityId = String(event.id),
) {
  const rowId = this.nextRowId++;
  this.entityIdByRowId.set(rowId, entityId);
  return {
    rowId,
    turnId,
    entityId,
    productTurnId: turnId,
    visibility: "visible" as const,
    createdAt: this.ms(event),
    createdAtSeq: event.sequenceNumber,
  };
}

export function turnIdOf(this: ProductProjectionInternal, event: SessionEvent): string {
  const runtimeTurnId = String(event.turnId ?? this.currentTurnId ?? "turn-unknown");
  // queue drain 切轮后，同一 runtimeTurn 的后续事件行归入最新 productTurn。
  return this.productTurnIdByRuntimeTurnId.get(runtimeTurnId) ?? runtimeTurnId;
}

export function ms(this: ProductProjectionInternal, event: SessionEvent): number {
  return event.timestamp.getTime();
}

export function findRow(
  this: ProductProjectionInternal,
  rowId: number,
): ConversationRow | undefined {
  const index = this.rowIndexById.get(rowId);
  return index === undefined ? undefined : this.snapshot.rows.window[index];
}

export function updateRowIndexAfterImmutableApply(
  this: ProductProjectionInternal,
  previousRowsLength: number,
  deltas: readonly ConversationDelta[],
): void {
  if (deltas.some((delta) => delta.op === "row.removed")) {
    this.rowIndexById = new Map(this.snapshot.rows.window.map((row, index) => [row.rowId, index]));
    return;
  }
  let nextIndex = previousRowsLength;
  for (const delta of deltas) {
    if (delta.op !== "row.appended") continue;
    this.rowIndexById.set(delta.row.rowId, nextIndex);
    nextIndex += 1;
  }
}

export function findToolRow(
  this: ProductProjectionInternal,
  toolCallId: string,
): ToolCallRow | undefined {
  const rowId = this.toolRowIdByCallId.get(toolCallId);
  if (rowId === undefined) return undefined;
  const row = this.findRow(rowId);
  return row?.kind === "toolCall" ? row : undefined;
}

export function findSubagentRow(
  this: ProductProjectionInternal,
  agentId: string,
): SubagentRow | undefined {
  const rowId = this.subagentRowIdByAgentId.get(agentId);
  if (rowId === undefined) return undefined;
  const row = this.findRow(rowId);
  return row?.kind === "subagent" ? row : undefined;
}

export function findSubagentLifecycleRow(
  this: ProductProjectionInternal,
  agentId: string,
  payload: Record<string, unknown>,
  event: SessionEvent,
): SubagentRow | undefined {
  const exact = this.findSubagentRow(agentId);
  if (exact) return exact;

  const parentToolCallId = this.stringPayload(payload, "parentToolCallId");
  if (!parentToolCallId) return undefined;
  const turnId = this.turnIdOf(event);
  // 晚订阅 hydration 无法从后台 Agent 的文本 tool output 恢复真实 agentId，
  // 会先用 toolCallId 合成一条 SubagentRow。后到的 live lifecycle 携带真实 agentId，
  // 旧逻辑因此追加第二行，UI 又会让无 childSessionId 的合成行抢占配对。父 tool call
  // 在同一 turn 内是稳定唯一身份，这里将真实事件归并回合成行并补齐 childSessionId。
  return this.snapshot.rows.window.find(
    (row): row is SubagentRow =>
      row.kind === "subagent" && row.turnId === turnId && row.parentToolCallId === parentToolCallId,
  );
}

export function subagentAgentId(
  this: ProductProjectionInternal,
  payload: Record<string, unknown>,
  event: SessionEvent,
): string {
  return (
    this.stringPayload(payload, "agentId") ??
    this.stringPayload(payload, "childSessionId") ??
    this.stringPayload(payload, "parentToolCallId") ??
    `subagent-${event.sequenceNumber}`
  );
}

export function stringPayload(
  this: ProductProjectionInternal,
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function mapSubagentStatus(
  this: ProductProjectionInternal,
  status: string | undefined,
): SubagentRow["status"] {
  switch (status) {
    case "completed":
    case "success":
      return "success";
    case "cancelled":
    case "stopped":
      return "cancelled";
    default:
      return "failed";
  }
}
