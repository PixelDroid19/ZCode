import type {
  McpCallToolOptions,
  McpCallToolRequest,
  McpPort,
  McpToolCallResult,
} from "@zcode/contracts";
import { DEFAULT_MCP_TIMEOUT_MS } from "./adapter-types.js";
import { McpAdapterToolRecovery } from "./adapter-tool-recovery.js";
import { classifyInteractiveAuthorizationTrigger } from "./oauth-errors.js";
import { createMcpDeadline, remainingMcpDeadlineMs, waitWithinMcpDeadline } from "./timeout.js";

export class NodeMcpAdapter extends McpAdapterToolRecovery implements McpPort {
  async callTool(
    request: McpCallToolRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpToolCallResult> {
    const initialRecord = this.records.get(request.serverName);
    const timeoutMs =
      options.timeoutMs ?? initialRecord?.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
    const deadline = createMcpDeadline(timeoutMs);
    const timeoutMessage = `MCP tool ${request.serverName}/${request.toolName} timed out after ${timeoutMs}ms`;
    const pending = initialRecord?.connecting;
    if (pending) {
      // connecting 是 adapter 持有的共享连接/OAuth 恢复任务。过去这里裸 await，
      // tool caller 的 timeout/abort 完全失效；但直接 abort 底层任务又会关闭其他 caller 共用的
      // callback listener。这里只限制当前 waiter，共享任务继续由 record 生命周期持有。
      await waitWithinMcpDeadline(pending, deadline, timeoutMessage, options.signal);
    }

    // stdio MCP 子进程死亡后（如 node_repl 被异步错误击穿），此前没有任何恢复路径：
    // 连接只在 session 创建时建立一次，session resume 也不重建，该会话的工具从此永远失败。
    // 这里在调用前对已断连的 record 重连一次；server 进程内状态（如 REPL 变量）不可恢复，
    // 但工具本身恢复可用。
    const disconnected = this.records.get(request.serverName);
    if (disconnected && disconnected.status.status === "disconnected") {
      await waitWithinMcpDeadline(
        this.reconnectForCall(request.serverName, disconnected.config),
        deadline,
        timeoutMessage,
        options.signal,
      );
    }

    const record = this.records.get(request.serverName);
    if (!record?.client || record.status.status !== "connected") {
      throw new Error(`MCP server is not connected: ${request.serverName}`);
    }

    try {
      return await this.callToolOnClient(
        record.client,
        request,
        remainingMcpDeadlineMs(deadline, timeoutMessage),
        options.signal,
      );
    } catch (error) {
      // 连接建立后 token 过期、被撤销或 scope 不足时，
      // 过去这些认证错误原样冒泡，用户看到裸错误且永远不会自愈——OAuth 自愈只存在于
      // startup connect 路径。现在运行期与建连期共用同一套 Phase 2 → Phase 1 编排。
      const trigger = classifyInteractiveAuthorizationTrigger(error);
      if (trigger && record.config.type !== "stdio") {
        return await this.recoverToolCallAuthorization({
          error,
          record,
          request,
          deadline,
          timeoutMessage,
          trigger,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      }
      // 防 onclose 尚未派发的竞态：SDK 在 transport 已断时抛裸 "Not connected"。
      // 只对这一种确定的断连错误重连重试一次，其余错误原样冒泡。
      if (!(error instanceof Error) || error.message !== "Not connected") throw error;
      try {
        await waitWithinMcpDeadline(
          this.reconnectForCall(request.serverName, record.config),
          deadline,
          timeoutMessage,
          options.signal,
        );
      } catch (reconnectError) {
        this.logger?.warn("MCP server reconnect failed", {
          error: reconnectError instanceof Error ? reconnectError.message : String(reconnectError),
          event: "mcp.server.reconnect.failed",
          mcpServerName: request.serverName,
          status: "failed",
        });
        throw error;
      }
      const revived = this.records.get(request.serverName);
      if (!revived?.client || revived.status.status !== "connected") throw error;
      return await this.callToolOnClient(
        revived.client,
        request,
        remainingMcpDeadlineMs(deadline, timeoutMessage),
        options.signal,
      );
    }
  }
}
