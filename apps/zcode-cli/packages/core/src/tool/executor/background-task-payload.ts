import { isSubagentDispatchToolName } from "../compat.js";
import type { ExecutableToolCall } from "../types.js";
import { backgroundTaskKind } from "./background-task-bash.js";
import { canCancelBackgroundTask } from "./background-task-lifecycle.js";
import { backgroundTaskOutputMetadata } from "./background-task-output.js";
import { isDynamicWorkflowRunDispatchToolName } from "./background-task-registry.js";
import type { BackgroundTaskSnapshot } from "./background-task-types.js";
import { workflowTaskSubject } from "./background-task-workflow.js";
import type { ToolExecutorDeps } from "./types.js";
import { isRecord } from "./utils.js";

export function backgroundTaskPayload(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
  status: string,
  snapshot?: BackgroundTaskSnapshot,
  output?: Record<string, unknown>,
): Record<string, unknown> {
  const input = isRecord(toolCall.input) ? toolCall.input : {};
  const outputMetadata = backgroundTaskOutputMetadata(snapshot, output);

  return {
    taskId,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    // V4 projection 过去从 toolName 手写推断类型，漏掉真实 Agent 工具名后把后台 subagent 投成
    // bash/process。runtime 在事实产生处一次裁决；生命周期行为仍由 lifecycleProvider 分派。
    taskKind: backgroundTaskKind(toolCall.name),
    childSessionId: outputMetadata.childSessionId,
    cancellable: status === "running" && canCancelBackgroundTask(deps, toolCall),
    command: typeof input.command === "string" ? input.command : undefined,
    // CreateWorkflow 输入没有 description，展示名与完成通知共用 workflowTaskSubject 的兜底链。
    description: isDynamicWorkflowRunDispatchToolName(toolCall.name)
      ? workflowTaskSubject(toolCall, taskId, snapshot, output)
      : typeof input.description === "string"
        ? input.description
        : snapshot && "description" in snapshot
          ? snapshot.description
          : undefined,
    status,
    pid: snapshot && "pid" in snapshot ? snapshot.pid : undefined,
    startedAt: snapshot?.startedAt,
    completedAt: snapshot?.completedAt,
    outputPath: outputMetadata.outputFile,
    stderrPersistedOutputPath: outputMetadata.stderrFile,
    stdoutPersistedOutputPath: outputMetadata.stdoutFile,
    outputBytes: outputMetadata.outputBytes,
    outputTruncated: outputMetadata.outputTruncated,
    outputTail: outputMetadata.outputTail,
    stderrBytes: outputMetadata.stderrBytes,
    stderrTail: outputMetadata.stderrTail,
    stdoutBytes: outputMetadata.stdoutBytes,
    stdoutTail: outputMetadata.stdoutTail,
    terminalId: taskId,
  };
}

export function backgroundSnapshotSignature(snapshot: BackgroundTaskSnapshot): string {
  return JSON.stringify({
    pid: snapshot && "pid" in snapshot ? snapshot.pid : undefined,
    stderrBytes: snapshot && "stderrBytes" in snapshot ? snapshot.stderrBytes : undefined,
    stderrTail: snapshot && "stderrTail" in snapshot ? snapshot.stderrTail : undefined,
    stdoutBytes: snapshot && "stdoutBytes" in snapshot ? snapshot.stdoutBytes : undefined,
    stdoutTail: snapshot && "stdoutTail" in snapshot ? snapshot.stdoutTail : undefined,
  });
}

export function isNotifiedLocalAgentSnapshot(
  toolCall: ExecutableToolCall,
  snapshot: BackgroundTaskSnapshot,
): boolean {
  const record = snapshot as unknown as Record<string, unknown>;
  return (
    isSubagentDispatchToolName(toolCall.name) &&
    record.type === "local_agent" &&
    record.notified === true
  );
}
