import type { DynamicWorkflowRunProgressPayload, SessionEvent } from "@zcode/contracts";
import { resolveZCodeBackgroundTaskControlKind } from "@zcode/shared";
import type {
  BackgroundWorkSummary,
  ConversationDelta,
  WorkflowRunProgressEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import { diffWorkflowRunsState, reduceWorkflowRunsState } from "@zcode/shared/zcode-protocol-v4";
import type { ProductProjectionInternal } from "./product-projection-internal.js";

export function onBackgroundTaskLifecycle(
  this: ProductProjectionInternal,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    taskId?: string;
    toolName?: string;
    taskKind?: string;
    command?: string;
    description?: string;
    status?: string;
    cancellable?: boolean;
    blocked?: boolean;
    childSessionId?: string;
  };
  const workId = payload.taskId;
  if (!workId) return [];
  const prev = this.snapshot.backgroundWorks;
  const existing = prev.find((work) => work.workId === workId);
  const legacyKind = resolveZCodeBackgroundTaskControlKind(payload);
  // 新事件使用 runtime 的显式 taskKind；旧事件统一走 shared resolver，
  // 不能再在 reducer 内散落 Agent/Task/subagent 字符串分支。
  // "workflow" 是 workflow run（此前错标成 bash）；legacy resolver 里没有对应值，因为
  // legacy `Workflow` 工具刻意仍归 bash——两者是不同的东西，共用类别会让面板混在一起。
  const kind: BackgroundWorkSummary["kind"] =
    payload.taskKind === "subagent"
      ? "subagent"
      : payload.taskKind === "bash"
        ? "bash"
        : payload.taskKind === "workflow"
          ? "workflow"
          : legacyKind === "agent"
            ? "subagent"
            : legacyKind === "bash"
              ? "bash"
              : (existing?.kind ?? "bash");
  // 事件 status（running/completed/failed/timed_out/cancelled/spawn_error/lost）
  // → summary status（running/resultPending/failed/cancelled）。
  const rawStatus = payload.status ?? "running";
  const status: "running" | "resultPending" | "failed" | "cancelled" =
    rawStatus === "running"
      ? "running"
      : rawStatus === "cancelled"
        ? "cancelled"
        : rawStatus === "completed"
          ? "resultPending"
          : "failed";
  const title =
    payload.description?.trim() ||
    payload.command?.trim() ||
    existing?.title ||
    payload.toolName ||
    workId;
  const next: BackgroundWorkSummary = {
    workId,
    kind,
    title,
    status,
    startedAt: existing?.startedAt ?? this.ms(event),
    ...(status === "running" ? {} : { endedAt: this.ms(event) }),
    ...(typeof payload.cancellable === "boolean"
      ? { cancellable: payload.cancellable }
      : existing?.cancellable !== undefined
        ? { cancellable: existing.cancellable }
        : {}),
    ...(typeof payload.blocked === "boolean"
      ? { blocked: payload.blocked }
      : existing?.blocked !== undefined
        ? { blocked: existing.blocked }
        : {}),
    anchorRowId: existing?.anchorRowId ?? null,
    ...(payload.childSessionId
      ? { childSessionId: payload.childSessionId }
      : existing?.childSessionId
        ? { childSessionId: existing.childSessionId }
        : {}),
  };
  // 幂等：内容无变化不产 delta。
  if (
    existing &&
    existing.status === next.status &&
    existing.title === next.title &&
    existing.kind === next.kind &&
    existing.cancellable === next.cancellable &&
    existing.blocked === next.blocked &&
    existing.childSessionId === next.childSessionId
  ) {
    return [];
  }
  const backgroundWorks = existing
    ? prev.map((work) => (work.workId === workId ? next : work))
    : [...prev, next];
  return [{ op: "state.updated", patch: { backgroundWorks } }];
}

export function onDynamicWorkflowRunProgress(
  this: ProductProjectionInternal,
  event: SessionEvent,
): ConversationDelta[] {
  // 先转 contracts 的有界 payload、再赋给 shared 的结构化入参：这行赋值就是"两边形状不漂移"
  // 的编译期闸（shared 不得反向依赖 contracts，所以入参类型只能结构化定义）。
  const envelope: WorkflowRunProgressEnvelope = event.payload as DynamicWorkflowRunProgressPayload;
  const prior = this.snapshot.workflowRuns;
  const workflowRuns = reduceWorkflowRunsState(prior, envelope);
  // null = 语义无变化（无效事件或同一条事件重放）：不产 delta，revision 不抬。
  if (workflowRuns === null) return [];
  // 一条引擎事件通常只动一个节点；发状态差避免每次重发整个 workflowRuns 键。
  // shared reducer 保证应用此 diff 后逐字节得到 workflowRuns。
  return diffWorkflowRunsState(prior, workflowRuns);
}

export function removeQueueItems(
  this: ProductProjectionInternal,
  ids: readonly string[],
): ConversationDelta[] {
  const idSet = new Set(ids);
  for (const id of ids) this.deliveryByPendingInputId.delete(id);
  const items = this.snapshot.queue.items
    .filter((item) => !idSet.has(item.queueItemId))
    .map((item, index) =>
      item.order.queuePosition === index
        ? item
        : { ...item, order: { ...item.order, queuePosition: index } },
    );
  if (items.length === this.snapshot.queue.items.length) return [];
  return [
    {
      op: "state.updated",
      patch: this.queuePatch({ ...this.snapshot.queue, items }),
    },
  ];
}
