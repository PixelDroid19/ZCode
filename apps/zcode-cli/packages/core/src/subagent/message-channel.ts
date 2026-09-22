import {
  isTerminalRuntimeTask,
  type RuntimeTaskMessageSink,
  type RuntimeTaskRegistry,
} from "../runtime-task/registry.js";

/** 仅表示接收端明确未准入；持久化或发布失败可能发生在准入之后，不能使用此类型。 */
export class SubagentMessageNotAdmittedError extends Error {}

/** 启动中的发送等待真实接收端准入，不提前确认一条无人消费的 queued 消息。 */
export function createSubagentMessageChannel(registry: RuntimeTaskRegistry, agentId: string) {
  let resolveReady!: (sink: RuntimeTaskMessageSink | undefined) => void;
  const ready = new Promise<RuntimeTaskMessageSink | undefined>((resolve) => {
    resolveReady = resolve;
  });

  const channelSink: RuntimeTaskMessageSink = {
    async send(message, options) {
      const current = registry.get(agentId);
      if (!current || isTerminalRuntimeTask(current) || current.messageSink !== channelSink) {
        throw new SubagentMessageNotAdmittedError(
          "Subagent execution ended before message admission",
        );
      }
      const waiter = new AbortController();
      const signal = options?.signal;
      const onAbort = () => waiter.abort(signal?.reason ?? new Error("Subagent message aborted"));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const terminal = registry.waitForTerminal(agentId, { signal: waiter.signal });
        const receiver = await Promise.race([ready, terminal.then(() => undefined)]);
        // worker 退出早于终态提交；接收端未安装时必须等提交，不能把中间 running 当作拒收。
        if (!receiver) await terminal;
        if (signal?.aborted) throw signal.reason ?? new Error("Subagent message aborted");
        const task = registry.get(agentId);
        if (!receiver || !task || isTerminalRuntimeTask(task) || task.messageSink !== channelSink) {
          throw new SubagentMessageNotAdmittedError(
            "Subagent execution ended before message admission",
          );
        }
        return await receiver.send(message, options);
      } finally {
        signal?.removeEventListener("abort", onAbort);
        // ready 获胜后也要移除 terminal waiter，避免每次成功发送留下悬挂监听。
        waiter.abort();
      }
    },
  };

  return {
    sink: channelSink,
    attach: (sink: RuntimeTaskMessageSink) => resolveReady(sink),
    finish: () => resolveReady(undefined),
  };
}
