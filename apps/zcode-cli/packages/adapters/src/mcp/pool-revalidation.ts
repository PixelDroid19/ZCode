import type {
  Logger,
  McpConnectOptions,
  McpPort,
  McpServerConfig,
  McpServerStatus,
} from "@zcode/contracts";
import type { McpConnectionContext } from "./pool-context.js";

export interface PoolEntry {
  adapter: McpPort;
  closeTimer?: ReturnType<typeof setTimeout>;
  connectionContext: McpConnectionContext;
  connecting: Promise<McpServerStatus>;
  key: string;
  lifetime: AbortController;
  refs: Set<string>;
  /** 同一 entry 的并发存活校验共享一次探测，避免重复 ping / 重复重连。 */
  revalidating?: Promise<void>;
  serverName: string;
}

// 设置页的 mcpPort 是进程级的 `protocol-settings` lease，connectionKey 只由
// serverName + leaseId + config 组成，配置没变时每次 mcp/list 都命中同一个 entry 并直接返回
// 首次连接那个早已 resolve 的 promise——不重连、不探测、不打日志。HTTP/SSE MCP 被停掉又不会
// 派发 onclose，于是设置页永远显示"已连接并可用"，点多少次刷新都不变。
// 这里在显式要求 revalidate 时先确认连接仍然存活，已死则在同一个 entry 上原地重连
// （保持 entry 身份，其他共享该连接的 lease 不会被打断成 "not leased"）。
export async function revalidateMcpPoolEntry(
  entry: PoolEntry,
  config: McpServerConfig,
  connectOptions: McpConnectOptions,
  logger?: Logger,
): Promise<void> {
  if (entry.revalidating) {
    await entry.revalidating;
    return;
  }
  const run = (async () => {
    const assertLive = () => {
      entry.lifetime.signal.throwIfAborted();
      if (entry.refs.size === 0) throw new Error("MCP connection is no longer leased");
    };
    const connected = await entry.connecting.then(
      () => true,
      () => false,
    );
    const state = connected ? (await entry.adapter.status())[entry.serverName]?.status : undefined;
    assertLive();
    // 进行中的握手（含 OAuth 待授权）和显式停用/待信任状态不打扰：
    // 重连会作废浏览器里已打开的授权 URL 和 PKCE/state。
    if (state === "connecting" || state === "disabled" || state === "untrusted") {
      return;
    }
    if (state === "connected") {
      const alive = (await entry.adapter.pingServer?.(entry.serverName)) ?? true;
      // ping 等待期间最后一个 owner 可能已经释放；不能重新启动已从 pool 移除的 adapter。
      assertLive();
      if (alive) {
        logger?.debug("MCP pooled connection revalidated", {
          ...entry.connectionContext,
          event: "mcp.pool.connection.revalidated",
          mcpServerName: entry.serverName,
          status: "completed",
        });
        return;
      }
    }
    logger?.warn("MCP pooled connection is stale; reconnecting", {
      ...entry.connectionContext,
      event: "mcp.pool.connection.stale",
      mcpConnectionState: state ?? "unknown",
      mcpServerName: entry.serverName,
      status: "started",
    });
    entry.connecting = entry.adapter.connectServer(entry.serverName, config, {
      ...connectOptions,
      signal: AbortSignal.any([
        entry.lifetime.signal,
        ...(connectOptions.signal ? [connectOptions.signal] : []),
      ]),
    });
    // 失败由 status()/调用方 await entry.connecting 表达，这里不重复冒泡。
    await entry.connecting.catch(() => undefined);
  })();
  entry.revalidating = run.finally(() => {
    entry.revalidating = undefined;
  });
  await entry.revalidating;
}
