import type { Logger, TraceContext } from "@zcode/contracts";
import { isTerminalRuntimeTask, type RuntimeTaskSnapshot } from "../runtime-task/registry.js";

/**
 * 终态检查后的异步写盘曾让 stop 与 completion 相互覆盖；整个提交必须按 agent 串行。
 * 这里只持有提交顺序，任务状态仍由 RuntimeTaskRegistry 唯一持有。
 */
export class SubagentTaskTransitions {
  private readonly pending = new Map<string, Promise<void>>();

  run<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(agentId) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.pending.set(agentId, settled);
    void settled.then(() => {
      if (this.pending.get(agentId) === settled) this.pending.delete(agentId);
    });
    return result;
  }
}

export function isCurrentRunningSubagent(
  task: RuntimeTaskSnapshot | undefined,
  trace: TraceContext,
): task is RuntimeTaskSnapshot {
  // agentId 在恢复时复用；run span 才能阻止旧执行的迟到结果覆盖新执行。
  return (
    task !== undefined &&
    !isTerminalRuntimeTask(task) &&
    task.traceContext?.traceId === trace.traceId &&
    task.traceContext?.spanId === trace.spanId
  );
}

export function observeSubagentPublication(
  publications: readonly Promise<void>[],
  trace: TraceContext,
  logger?: Logger,
): Promise<void> {
  // 终态已提交，订阅者失败不能把成功改成失败；等待订阅者也不能占住命令准入锁。
  return Promise.all(publications).then(
    () => undefined,
    (error: unknown) => {
      logger?.warn("Failed to publish committed subagent transition", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "subagent.transition.publication.failed",
        traceId: trace.traceId,
        spanId: trace.spanId,
      });
    },
  );
}
