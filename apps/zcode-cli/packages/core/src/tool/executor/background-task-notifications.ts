import { traceContextToLogContext, type TraceContext } from "@zcode/contracts";
import type { ExecutableToolCall } from "../types.js";
import { resolveBashBackgroundResultTitle } from "./background-task-bash.js";
import { formatBackgroundTaskNotification } from "./background-task-format.js";
import {
  claimRuntimeBackgroundTaskNotification,
  isDynamicWorkflowRunDispatchToolName,
  releaseRuntimeBackgroundTaskNotification,
} from "./background-task-registry.js";
import type { BackgroundTaskSnapshot } from "./background-task-types.js";
import {
  buildWorkflowNotificationOriginMeta,
  workflowSnapshotTerminal,
} from "./background-task-workflow.js";
import type { ToolExecutorDeps } from "./types.js";

export function maybeEnqueueBackgroundTaskNotification(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
  traceContext: TraceContext,
  output?: Record<string, unknown>,
): void {
  if (!deps.enqueueBackgroundTaskNotification) {
    deps.logger?.debug?.("Background task notification queue unavailable", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.notification.queue_unavailable",
      module: "core.tool.executor",
      taskId,
      taskStatus: status,
      toolName: toolCall.name,
    });
    return;
  }

  // 被修订替代的 run 不发终态通知，但仍 claim，避免 TaskOutput 随后把它当成未送达通知。
  if (workflowSnapshotTerminal(status, snapshot)?.stopReason === "superseded") {
    claimRuntimeBackgroundTaskNotification(deps, toolCall, taskId);
    deps.logger?.info?.("Background task notification suppressed: run superseded", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.notification.suppressed",
      module: "core.tool.executor",
      reason: "workflow_run_superseded",
      taskId,
      taskStatus: status,
      toolName: toolCall.name,
    });
    return;
  }

  if (
    deps.shouldEnqueueBackgroundTaskNotification?.({
      runtimeScope: deps.runtimeScope,
      status,
      taskId,
      toolName: toolCall.name,
      traceContext,
    }) === false
  ) {
    deps.logger?.info?.("Background task notification suppressed by runtime policy", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.notification.suppressed",
      module: "core.tool.executor",
      taskId,
      taskStatus: status,
      toolName: toolCall.name,
    });
    return;
  }

  const text = formatBackgroundTaskNotification(deps, toolCall, taskId, status, snapshot, output);
  if (!text) {
    deps.logger?.debug?.("Background task notification skipped without formatted message", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.notification.skipped",
      module: "core.tool.executor",
      reason: "empty_message",
      taskId,
      taskStatus: status,
      toolName: toolCall.name,
    });
    return;
  }

  // TaskOutput 读取终态会先把同一 registry task 标成 notified；completion 成功 claim 后才入队。
  if (!claimRuntimeBackgroundTaskNotification(deps, toolCall, taskId)) {
    deps.logger?.debug?.("Background task notification already claimed", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.tracking.notification_already_handled",
      module: "core.tool.executor",
      taskId,
      taskStatus: status,
      toolName: toolCall.name,
    });
    return;
  }

  try {
    deps.enqueueBackgroundTaskNotification({
      ...(toolCall.name === "Bash"
        ? {
            originMeta: {
              backgroundSource: "bash" as const,
              title: resolveBashBackgroundResultTitle(toolCall, taskId),
              workId: taskId,
            },
          }
        : {}),
      ...(isDynamicWorkflowRunDispatchToolName(toolCall.name)
        ? {
            originMeta: buildWorkflowNotificationOriginMeta(
              toolCall,
              taskId,
              status,
              snapshot,
              output,
            ),
          }
        : {}),
      taskId,
      text,
      toolName: toolCall.name,
      traceContext,
    });
  } catch (error) {
    releaseRuntimeBackgroundTaskNotification(deps, toolCall, taskId);
    deps.logger?.warn("Background task notification enqueue failed", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      module: "core.tool.executor",
      taskId,
    });
    return;
  }

  deps.logger?.info?.("Background task notification enqueued", {
    ...traceContextToLogContext(traceContext),
    event: "background_task.notification.enqueued",
    module: "core.tool.executor",
    taskId,
    taskStatus: status,
    toolName: toolCall.name,
  });
}
