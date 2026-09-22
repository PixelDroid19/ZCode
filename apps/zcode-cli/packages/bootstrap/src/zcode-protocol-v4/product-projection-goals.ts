import type {
  SessionEvent,
  SessionForkedPayload,
  TargetChangedPayload,
  TargetCompletionVerificationPayload,
} from "@zcode/contracts";
import type {
  ConversationDelta,
  GoalState,
  SessionControl,
  TimelineMarkerPayload,
  TimelineMarkerRow,
} from "@zcode/shared/zcode-protocol-v4";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type { ProductProjectionInternal } from "./product-projection-internal.js";
import { mapGoalStatus } from "./projection-rows.js";

export function onTargetChanged(
  this: ProductProjectionInternal,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TargetChangedPayload;
  switch (payload.action) {
    case "set": {
      if (!payload.target) return [];
      // 新目标：iteration/verifications 归零。
      // goalSet 是 stateOnly——不产 timeline row（旧实现
      // 的 goalSet marker 是「进 window 渲染 null」的隐形行，污染 turn 分组判定），
      // 目标展示归 goal 面板/状态区。
      const goal: GoalState = {
        targetId: payload.target.targetID,
        objective: payload.target.objective,
        summaryTitle: payload.target.summaryTitle,
        timeUsedSeconds: payload.target.timeUsedSeconds,
        activeRunStartedAtMs: payload.target.activeRunStartedAtMs ?? null,
        status: mapGoalStatus(payload.target.status),
        iteration: 0,
        verifications: [],
        iterations: [],
      };
      return [{ op: "state.updated", patch: this.goalPatch(goal) }];
    }
    case "cleared": {
      if (!this.snapshot.goal) return [];
      return [{ op: "state.updated", patch: this.goalPatch(null) }];
    }
    default: {
      // status_updated / run_started / run_finished / usage_accounted / summary_updated：
      // 同步刷新计时与摘要标题。旧实现只比较 status，会吞掉 1 秒以上 run accounting
      // 和 summaryTitle 更新，导致刷新前后的 UI 不一致。
      const goal = this.snapshot.goal;
      if (!goal || !payload.target) return [];
      const nextGoal: GoalState = {
        ...goal,
        targetId: payload.target.targetID,
        objective: payload.target.objective,
        summaryTitle: payload.target.summaryTitle,
        timeUsedSeconds: payload.target.timeUsedSeconds,
        activeRunStartedAtMs: payload.target.activeRunStartedAtMs ?? null,
        status: mapGoalStatus(payload.target.status),
      };
      if (
        nextGoal.targetId === goal.targetId &&
        nextGoal.objective === goal.objective &&
        nextGoal.summaryTitle === goal.summaryTitle &&
        nextGoal.timeUsedSeconds === goal.timeUsedSeconds &&
        nextGoal.activeRunStartedAtMs === goal.activeRunStartedAtMs &&
        nextGoal.status === goal.status
      ) {
        return [];
      }
      return [{ op: "state.updated", patch: this.goalPatch(nextGoal) }];
    }
  }
}

export function onTargetVerification(
  this: ProductProjectionInternal,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TargetCompletionVerificationPayload;
  const goal = this.snapshot.goal;
  // goal verify boundary 不依赖 goal 状态在场。
  // 冷恢复合成事件流没有 TargetChanged → goal 为 null，旧实现在此整条丢弃
  // verification 事实，刷新后 goalVerify marker 消失。现在 marker
  // 恒生成/恒更新；goal 状态 patch 仍只在 goal 在场时生效。

  if (payload.status === "started") {
    const iteration = payload.goalIteration ?? (goal ? goal.iteration + 1 : 1);
    const lifecycleKey = this.goalVerifyLifecycleKey(payload, iteration);
    const verifyingGoal = goal ? { ...goal, status: "verifying" as const, iteration } : undefined;
    const otherWorks = this.snapshot.control.activeWorks.filter(
      (work) => work.kind !== "goalVerifier",
    );
    const controlDelta: ConversationDelta = {
      op: "state.updated",
      patch: this.controlPatch(
        {
          phase: "running",
          sessionEnded: false,
          activeWorks: [
            ...otherWorks,
            {
              kind: "goalVerifier",
              ...(payload.foregroundExecutionId
                ? { foregroundExecutionId: payload.foregroundExecutionId }
                : {}),
              startedAt: this.ms(event),
            },
          ],
          canStop: true,
          stopState: "stoppable",
          stopTargetKind: otherWorks.length > 0 ? ("mixed" as const) : ("goalVerifier" as const),
          lastError: null,
          apiRetry: null,
        },
        verifyingGoal,
      ),
    };
    // GV-identity：同 targetId+iteration 的重试（新 verificationId）复用同一 marker
    // 行回到 running，不长出第二个 marker。
    const existingRowId = this.goalVerifyMarkerRowIdByLifecycleKey.get(lifecycleKey);
    const existingRow = existingRowId !== undefined ? this.findRow(existingRowId) : undefined;
    if (existingRow?.kind === "timelineMarker") {
      return [
        {
          op: "row.upserted",
          row: {
            ...existingRow,
            marker: { type: "goalVerify", iteration, outcome: "running" },
          },
        },
        controlDelta,
      ];
    }
    const row: TimelineMarkerRow = {
      ...this.rowBase(event, this.goalVerifyTurnId(payload, event), lifecycleKey),
      kind: "timelineMarker",
      lane: "turnTailBoundary",
      marker: { type: "goalVerify", iteration, outcome: "running" },
    };
    this.goalVerifyMarkerRowIdByLifecycleKey.set(lifecycleKey, row.rowId);
    return [{ op: "row.appended", row }, controlDelta];
  }

  // 终态：completed（pass/notSatisfied 是有效结论）/ failed_closed（验证过程失败）
  // / cancelled（被 stop：过程未产出结论 → marker=failed(detail=cancelled)，goal 回 paused）。
  const iteration = payload.goalIteration ?? goal?.iteration ?? 1;
  const outcome: "pass" | "notSatisfied" | "failed" =
    payload.status === "completed"
      ? payload.verification?.passed
        ? "pass"
        : "notSatisfied"
      : "failed";
  const goalStatus: GoalState["status"] =
    payload.status === "cancelled"
      ? "paused"
      : payload.status === "failed_closed"
        ? "failed"
        : outcome === "pass"
          ? "verified"
          : "notSatisfied";

  const deltas: ConversationDelta[] = [];
  const lifecycleKey = this.goalVerifyLifecycleKey(payload, iteration);
  const markerRowId = this.goalVerifyMarkerRowIdByLifecycleKey.get(lifecycleKey);
  let anchorRowId: number | null = null;
  const markerRow = markerRowId !== undefined ? this.findRow(markerRowId) : undefined;
  const terminalMarker: TimelineMarkerPayload = {
    type: "goalVerify",
    iteration,
    outcome,
    ...(payload.status === "cancelled"
      ? { detail: "cancelled" }
      : payload.verification?.reason
        ? { detail: payload.verification.reason }
        : {}),
  };
  if (markerRow?.kind === "timelineMarker") {
    anchorRowId = markerRow.rowId;
    deltas.push({
      op: "row.upserted",
      row: { ...markerRow, marker: terminalMarker },
    });
  } else {
    // GV-terminal-only：boundary 按 lifecycleKey upsert——任一生命周期
    // 事件先到都能创建实体。旧实现终态找不到 started marker 就整条丢弃（冷恢复
    // 后到达的终态、started 事件丢帧都触发）。
    const row: TimelineMarkerRow = {
      ...this.rowBase(event, this.goalVerifyTurnId(payload, event), lifecycleKey),
      kind: "timelineMarker",
      lane: "turnTailBoundary",
      marker: terminalMarker,
    };
    this.goalVerifyMarkerRowIdByLifecycleKey.set(lifecycleKey, row.rowId);
    anchorRowId = row.rowId;
    deltas.push({ op: "row.appended", row });
  }

  const hadGoalVerifierWork = this.snapshot.control.activeWorks.some(
    (work) => work.kind === "goalVerifier",
  );
  const shouldPatchControl = hadGoalVerifierWork || this.snapshot.goal?.status === "verifying";
  const otherWorks = this.snapshot.control.activeWorks.filter(
    (work) => work.kind !== "goalVerifier",
  );
  const terminalPhase: SessionControl["phase"] =
    payload.status === "cancelled"
      ? "completedInterrupted"
      : payload.status === "failed_closed"
        ? "error"
        : "completedSuccess";
  const heldQueue =
    payload.status === "cancelled" &&
    payload.preserveQueueAutoDrainOnCancel !== true &&
    this.snapshot.queue.items.length > 0
      ? {
          ...this.snapshot.queue,
          autoDrain: false,
          pauseReason: "stopped" as const,
        }
      : undefined;

  // goal 不在场（冷恢复合成流）：marker 行仍要保留；只有当前 live control
  // 确实处于 verifier work 时才收口 control，避免 terminal-only 历史事实把 draft
  // 冷恢复快照误推进成 completed。
  if (!goal) {
    if (!shouldPatchControl) return deltas;
    deltas.push({
      op: "state.updated",
      patch: this.controlPatch(
        {
          phase: terminalPhase,
          sessionEnded: terminalPhase !== "error",
          activeWorks: otherWorks,
          ...(otherWorks.length === 0
            ? {
                canStop: false,
                stopState: "idle" as const,
                stopTargetKind: "unknown" as const,
              }
            : {
                stopTargetKind: "mixed" as const,
              }),
        },
        undefined,
        heldQueue,
      ),
    });
    return deltas;
  }

  // verifications 只记结论（cancelled 不是结论，不入摘要）；最近 N 条。
  const verifications =
    payload.status === "cancelled"
      ? goal.verifications
      : [
          ...goal.verifications,
          {
            iteration,
            outcome,
            at: this.ms(event),
            anchorRowId,
            ...(payload.verification?.reason ? { reason: payload.verification.reason } : {}),
            ...(payload.verification?.nextAction
              ? { nextAction: payload.verification.nextAction }
              : {}),
          },
        ].slice(-PROTOCOL_V4_LIMITS.goalVerificationsRetained);

  const nextGoal = {
    ...goal,
    status: goalStatus,
    iteration,
    verifications,
  };
  deltas.push({
    op: "state.updated",
    patch: shouldPatchControl
      ? this.controlPatch(
          {
            phase: terminalPhase,
            sessionEnded: terminalPhase !== "error",
            activeWorks: otherWorks,
            ...(otherWorks.length === 0
              ? {
                  canStop: false,
                  stopState: "idle" as const,
                  stopTargetKind: "unknown" as const,
                }
              : {
                  stopTargetKind: "mixed" as const,
                }),
          },
          nextGoal,
          heldQueue,
        )
      : this.goalPatch(nextGoal),
  });
  return deltas;
}

/** goal verify boundary 身份：targetId_goalIteration。 */
export function goalVerifyLifecycleKey(
  this: ProductProjectionInternal,
  payload: TargetCompletionVerificationPayload,
  iteration: number,
): string {
  return payload.targetId ? `${payload.targetId}_${iteration}` : payload.verificationId;
}

export function goalVerifyTurnId(
  this: ProductProjectionInternal,
  payload: TargetCompletionVerificationPayload,
  event: SessionEvent,
): string {
  const anchorMessageId = payload.anchorAssistantMessageId
    ? String(payload.anchorAssistantMessageId)
    : null;
  if (anchorMessageId) {
    const rowId = this.rowIdForMessageId(anchorMessageId);
    const row = rowId !== null ? this.findRow(rowId) : undefined;
    if (row) return row.turnId;
  }
  const anchorTurnId = payload.anchorTurnId ? String(payload.anchorTurnId) : null;
  if (anchorTurnId) {
    const mapped = this.productTurnIdByRuntimeTurnId.get(anchorTurnId) ?? anchorTurnId;
    if (this.turnHeaderRowIdByTurnId.has(mapped)) return mapped;
  }
  return this.turnIdOf(event);
}

export function onSessionForked(
  this: ProductProjectionInternal,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as SessionForkedPayload;
  const isParent = String(payload.originalSessionId) === this.snapshot.sessionId;
  if (isParent) {
    // 父时间线不显示 forkCreated——fork 关系只在 sessions
    // 树/列表体现。旧实现以 nextRowId-1 近似锚点产 row，且 UI 渲染为 null
    // （隐形行污染 turn 分组）；child 首部 forkNotice 保留不变。
    return [];
  }
  // child 首部 forkNotice（forkTimelineIsBoundary）：事件 payload 不携带
  // parent 侧 rowId，先以 0 占位；transcript 锚点 → rowId 映射随传输外壳补齐。
  const row: TimelineMarkerRow = {
    ...this.rowBase(
      event,
      this.turnIdOf(event),
      `fork:${String(payload.originalSessionId)}:${String(payload.targetMessageId ?? "unknown")}`,
    ),
    kind: "timelineMarker",
    lane: "turnTailBoundary",
    marker: {
      type: "forkNotice",
      parentSessionId: String(payload.originalSessionId),
      parentRowId: 0,
    },
  };
  return [{ op: "row.appended", row }];
}
