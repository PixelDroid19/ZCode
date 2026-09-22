import {
  SessionEventType,
  traceContextToLogContext,
  type SessionEvent,
  type TraceContext,
  type TurnId,
} from "@zcode/contracts";
import type { ExecutableToolCall } from "../types.js";
import { isBackgroundTaskLaunch } from "./background-task-bash.js";
import {
  getBackgroundTaskSnapshot,
  hasBackgroundTaskSnapshotProvider,
  hasDirectBackgroundTaskWaiter,
  waitForBackgroundTaskSnapshot,
} from "./background-task-lifecycle.js";
import { maybeEnqueueBackgroundTaskNotification } from "./background-task-notifications.js";
import {
  backgroundSnapshotSignature,
  backgroundTaskPayload,
  isNotifiedLocalAgentSnapshot,
} from "./background-task-payload.js";
import {
  registerRuntimeBackgroundTask,
  removeRuntimeBackgroundTask,
  updateRuntimeBackgroundTask,
} from "./background-task-registry.js";
import type { BackgroundTaskSnapshot } from "./background-task-types.js";
import type { ToolExecutorDeps } from "./types.js";
import { isRecord } from "./utils.js";

/** Owns the in-memory poller lease while helpers preserve the task lifecycle protocol. */
export class BackgroundTaskTracker {
  private readonly backgroundPollers = new Set<string>();

  constructor(private readonly deps: ToolExecutorDeps) {}

  async trackBackgroundTask(
    toolCall: ExecutableToolCall,
    output: unknown,
    traceContext: TraceContext,
    turnId: TurnId | undefined,
  ): Promise<void> {
    await trackBackgroundTask(
      this.deps,
      this.backgroundPollers,
      toolCall,
      output,
      traceContext,
      turnId,
    );
  }
}

async function trackBackgroundTask(
  deps: ToolExecutorDeps,
  backgroundPollers: Set<string>,
  toolCall: ExecutableToolCall,
  output: unknown,
  traceContext: TraceContext,
  turnId: TurnId | undefined,
): Promise<void> {
  if (!isRecord(output)) return;
  if (!isBackgroundTaskLaunch(toolCall, output)) return;
  const taskId =
    typeof output.backgroundTaskId === "string"
      ? output.backgroundTaskId
      : typeof output.agentId === "string"
        ? output.agentId
        : undefined;
  if (!taskId || backgroundPollers.has(taskId)) return;

  backgroundPollers.add(taskId);
  registerRuntimeBackgroundTask(deps, toolCall, taskId, output, turnId);
  try {
    await emitBackgroundTaskEvent(
      deps,
      SessionEventType.BackgroundTaskStarted,
      backgroundTaskPayload(deps, toolCall, taskId, "running", undefined, output),
      traceContext,
      turnId,
    );
  } catch (error) {
    backgroundPollers.delete(taskId);
    removeRuntimeBackgroundTask(deps, toolCall, taskId);
    throw error;
  }

  const hasSnapshotProvider = hasBackgroundTaskSnapshotProvider(deps, toolCall);
  const hasDirectWaiter = hasDirectBackgroundTaskWaiter(deps, toolCall);
  deps.logger?.info?.("Background task tracking started", {
    ...traceContextToLogContext(traceContext),
    event: "background_task.tracking.started",
    hasDirectWaiter,
    hasSnapshotProvider,
    module: "core.tool.executor",
    taskId,
    toolName: toolCall.name,
  });

  if (!hasSnapshotProvider && !hasDirectWaiter) {
    deps.logger?.info?.("Background task tracking lost without snapshot source", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.tracking.lost",
      module: "core.tool.executor",
      reason: "missing_snapshot_source",
      taskId,
      toolName: toolCall.name,
    });
    updateRuntimeBackgroundTask(deps, toolCall, taskId, "lost");
    maybeEnqueueBackgroundTaskNotification(
      deps,
      toolCall,
      taskId,
      "lost",
      undefined,
      traceContext,
      output,
    );
    await emitBackgroundTaskEvent(
      deps,
      SessionEventType.BackgroundTaskCompleted,
      backgroundTaskPayload(deps, toolCall, taskId, "lost", undefined, output),
      traceContext,
      turnId,
    );
    backgroundPollers.delete(taskId);
    return;
  }

  let lastSnapshotSignature = "";
  let completing = false;
  let polling = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let maxRuntimeTimer: ReturnType<typeof setTimeout> | undefined;

  const stopTracking = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (maxRuntimeTimer) clearTimeout(maxRuntimeTimer);
    maxRuntimeTimer = undefined;
    backgroundPollers.delete(taskId);
  };

  if (
    toolCall.name === "Bash" &&
    deps.runtimeScope === "subagent" &&
    deps.subagentBackgroundBashMaxMs !== undefined &&
    deps.executionPort?.cancelBackgroundTask
  ) {
    maxRuntimeTimer = setTimeout(() => {
      deps.logger?.warn("Subagent background Bash exceeded max runtime; cancelling", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.subagent_bash.max_runtime_exceeded",
        module: "core.tool.executor",
        taskId,
        toolName: toolCall.name,
      });
      void Promise.resolve(deps.executionPort?.cancelBackgroundTask?.(taskId)).catch((error) => {
        deps.logger?.warn("Subagent background Bash cancellation failed", {
          ...traceContextToLogContext(traceContext),
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "background_task.subagent_bash.cancel_failed",
          module: "core.tool.executor",
          taskId,
          toolName: toolCall.name,
        });
      });
    }, deps.subagentBackgroundBashMaxMs);
  }

  const emitRunningUpdate = async (snapshot: BackgroundTaskSnapshot) => {
    const signature = backgroundSnapshotSignature(snapshot);
    if (signature === lastSnapshotSignature) return;
    lastSnapshotSignature = signature;
    updateRuntimeBackgroundTask(deps, toolCall, taskId, "running", snapshot);
    await emitBackgroundTaskEvent(
      deps,
      SessionEventType.BackgroundTaskUpdated,
      backgroundTaskPayload(deps, toolCall, taskId, "running", snapshot, output),
      traceContext,
      turnId,
    );
  };

  const emitTerminalSnapshot = async (
    snapshot: BackgroundTaskSnapshot | undefined,
  ): Promise<void> => {
    if (stopped || completing) return;
    completing = true;
    try {
      if (!snapshot) {
        deps.logger?.info?.("Background task terminal snapshot missing", {
          ...traceContextToLogContext(traceContext),
          event: "background_task.tracking.lost",
          module: "core.tool.executor",
          reason: "snapshot_missing",
          taskId,
          toolName: toolCall.name,
        });
        updateRuntimeBackgroundTask(deps, toolCall, taskId, "lost");
        maybeEnqueueBackgroundTaskNotification(
          deps,
          toolCall,
          taskId,
          "lost",
          undefined,
          traceContext,
          output,
        );
        await emitBackgroundTaskEvent(
          deps,
          SessionEventType.BackgroundTaskCompleted,
          backgroundTaskPayload(deps, toolCall, taskId, "lost", undefined, output),
          traceContext,
          turnId,
        );
        stopped = true;
        stopTracking();
        return;
      }

      if (snapshot.status === "running") {
        updateRuntimeBackgroundTask(deps, toolCall, taskId, "running", snapshot);
        await emitRunningUpdate(snapshot);
        if (!hasSnapshotProvider) {
          stopped = true;
          stopTracking();
        }
        return;
      }

      if (isNotifiedLocalAgentSnapshot(toolCall, snapshot)) {
        deps.logger?.debug?.("Background task terminal notification already handled by subagent", {
          ...traceContextToLogContext(traceContext),
          event: "background_task.tracking.notification_already_handled",
          module: "core.tool.executor",
          taskId,
          toolName: toolCall.name,
        });
        stopped = true;
        stopTracking();
        return;
      }

      deps.logger?.info?.("Background task terminal snapshot observed", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.tracking.terminal",
        module: "core.tool.executor",
        taskId,
        taskStatus: snapshot.status,
        toolName: toolCall.name,
      });
      updateRuntimeBackgroundTask(deps, toolCall, taskId, snapshot.status, snapshot);
      maybeEnqueueBackgroundTaskNotification(
        deps,
        toolCall,
        taskId,
        snapshot.status,
        snapshot,
        traceContext,
      );
      await emitBackgroundTaskEvent(
        deps,
        SessionEventType.BackgroundTaskCompleted,
        backgroundTaskPayload(deps, toolCall, taskId, snapshot.status, snapshot, output),
        traceContext,
        turnId,
      );
      stopped = true;
      stopTracking();
    } finally {
      completing = false;
    }
  };

  const poll = async () => {
    if (polling || stopped || !hasSnapshotProvider) return;
    polling = true;
    try {
      const snapshot = await getBackgroundTaskSnapshot(deps, toolCall, taskId);
      if (!snapshot) {
        await emitTerminalSnapshot(undefined);
        return;
      }

      if (snapshot.status === "running") {
        await emitRunningUpdate(snapshot);
        return;
      }

      await emitTerminalSnapshot(snapshot);
    } catch (error) {
      deps.logger?.warn("Background task polling failed", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        module: "core.tool.executor",
        taskId,
      });
    } finally {
      polling = false;
    }
  };

  const waitForCompletion = async () => {
    try {
      const snapshot = await waitForBackgroundTaskSnapshot(deps, toolCall, taskId);
      await emitTerminalSnapshot(snapshot);
    } catch (error) {
      deps.logger?.warn("Background task wait failed", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        module: "core.tool.executor",
        taskId,
      });
      if (!hasSnapshotProvider) {
        stopped = true;
        stopTracking();
      }
    }
  };

  if (hasSnapshotProvider) {
    timer = setInterval(() => {
      void poll();
    }, 1_000);
    timer.unref?.();
    await poll();
  }

  if (hasDirectWaiter && !stopped) {
    void waitForCompletion();
  }
}

async function emitBackgroundTaskEvent(
  deps: ToolExecutorDeps,
  type: SessionEvent["type"],
  payload: Record<string, unknown>,
  traceContext: TraceContext,
  turnId: TurnId | undefined,
): Promise<void> {
  await deps.emitEvent({
    id: crypto.randomUUID() as any,
    sessionId: deps.sessionId,
    turnId,
    type,
    timestamp: new Date(),
    traceId: traceContext.traceId,
    sequenceNumber: 0,
    payload,
  });
}
