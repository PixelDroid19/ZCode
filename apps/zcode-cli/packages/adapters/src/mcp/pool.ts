import type {
  Logger,
  McpCallToolOptions,
  McpCallToolRequest,
  McpConnectOptions,
  McpConnectionSnapshot,
  McpPort,
  McpServerConfig,
  McpServerStatus,
  McpToolCallResult,
  McpToolDescriptor,
} from "@zcode/contracts";
import type { McpTelemetryTracker } from "./telemetry.js";
import { McpConnectionAdmission } from "./pool-admission.js";
import { revalidateMcpPoolEntry, type PoolEntry } from "./pool-revalidation.js";
import { createMcpPoolConnectionKey } from "./pool-identity.js";
import { createMcpConnectionContext, type McpConnectionContext } from "./pool-context.js";

const DEFAULT_IDLE_GRACE_MS = 30_000;

interface CreateMcpAdapterForPoolInput {
  connectionContext: McpConnectionContext;
  connectionAdmission: McpConnectionAdmission;
  config: McpServerConfig;
  serverName: string;
  workingDirectory?: string;
}

export type { McpConnectionContext } from "./pool-context.js";

export interface McpConnectionPoolOptions {
  createAdapter(input: CreateMcpAdapterForPoolInput): McpPort;
  idleGraceMs?: number;
  logger?: Logger;
  telemetry?: McpTelemetryTracker;
}

export interface McpConnectionPool {
  acquireLease(options?: { leaseId?: string; sessionId?: string }): McpPort;
  close(): Promise<void>;
  stats(): { activeConnections: number; pendingCloseConnections: number };
}

export function createMcpConnectionPool(options: McpConnectionPoolOptions): McpConnectionPool {
  const entries = new Map<string, PoolEntry>();
  const connectionAdmission = new McpConnectionAdmission();
  let closePromise: Promise<void> | undefined;
  const idleGraceMs = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
  const logger = options.logger?.child({ module: "adapters.mcp.pool" });
  let closed = false;
  let leaseSequence = 0;

  const closeEntry = async (entry: PoolEntry): Promise<void> => {
    const startedAt = Date.now();
    entry.lifetime.abort(new Error("MCP pooled connection is closed"));
    if (entry.closeTimer) clearTimeout(entry.closeTimer);
    entry.closeTimer = undefined;
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    try {
      await entry.adapter.close();
      logger?.info("MCP pooled connection closed", {
        ...entry.connectionContext,
        durationMs: Date.now() - startedAt,
        event: "mcp.pool.connection.closed",
        mcpServerName: entry.serverName,
        status: "completed",
      });
    } catch (error) {
      logger?.warn("MCP pooled connection close failed", {
        ...entry.connectionContext,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.pool.connection.close.failed",
        mcpServerName: entry.serverName,
      });
    } finally {
      options.telemetry?.unregisterConnection({
        connectionId: entry.connectionContext.mcpConnectionId,
      });
    }
  };

  const scheduleClose = (entry: PoolEntry): void => {
    if (entry.closeTimer) return;
    if (idleGraceMs <= 0) {
      void closeEntry(entry);
      return;
    }
    entry.closeTimer = setTimeout(() => {
      entry.closeTimer = undefined;
      if (entry.refs.size === 0) void closeEntry(entry);
    }, idleGraceMs);
    entry.closeTimer.unref?.();
  };

  const acquireLease = (leaseOptions: { leaseId?: string; sessionId?: string } = {}): McpPort => {
    if (closed) throw new Error("MCP connection pool is closed");
    const leaseId = `${++leaseSequence}:${leaseOptions.leaseId ?? "lease"}`;
    const sessionId = leaseOptions.sessionId?.trim() || undefined;
    const leased = new Map<string, string>();
    const configuredServers = new Map<string, McpServerConfig>();
    let leaseClosed = false;
    let sessionStartupReported = false;

    const assertLeaseOpen = (): void => {
      if (closed || leaseClosed) throw new Error("MCP connection lease is closed");
    };
    const requireEntry = (serverName: string): PoolEntry => {
      assertLeaseOpen();
      const key = leased.get(serverName);
      const entry = key ? entries.get(key) : undefined;
      if (!entry) throw new Error(`MCP server is not leased by this session: ${serverName}`);
      return entry;
    };

    const release = (serverName: string): void => {
      const key = leased.get(serverName);
      if (!key) return;
      leased.delete(serverName);
      const entry = entries.get(key);
      if (!entry) return;
      if (!entry.refs.delete(leaseId)) return;
      options.telemetry?.releaseOwner({
        connectionId: entry.connectionContext.mcpConnectionId,
        ownerId: leaseId,
      });
      logger?.info("MCP connection lease released", {
        ...entry.connectionContext,
        event: "mcp.pool.lease.released",
        mcpLeaseId: leaseId,
        mcpServerName: serverName,
        refCount: entry.refs.size,
        ...(sessionId ? { sessionId } : {}),
      });
      if (entry.refs.size === 0) scheduleClose(entry);
    };

    const acquire = async (
      serverName: string,
      config: McpServerConfig,
      connectOptions: McpConnectOptions = {},
    ): Promise<McpServerStatus> => {
      assertLeaseOpen();
      const key = createMcpPoolConnectionKey({
        config,
        connectOptions,
        leaseId,
        serverName,
      });
      const previousKey = leased.get(serverName);
      let entry = entries.get(key);
      const shouldRevalidate = entry !== undefined && connectOptions.revalidate === true;
      let ownerAdded = false;
      if (entry) {
        if (entry.closeTimer) clearTimeout(entry.closeTimer);
        entry.closeTimer = undefined;
        const previousRefCount = entry.refs.size;
        entry.refs.add(leaseId);
        ownerAdded = entry.refs.size !== previousRefCount;
      } else {
        // 过去 pool、adapter 和 stdio PID 的日志彼此没有稳定关联键，无法从一个
        // session 追到实际 MCP 子进程。连接上下文在 entry 创建时固定，后续 lease 共用同一 ID。
        const connectionContext = createMcpConnectionContext({
          config,
          connectOptions,
          sessionId,
        });
        options.telemetry?.registerConnection({
          connectionId: connectionContext.mcpConnectionId,
          isolation: connectionContext.mcpIsolation,
          serverName,
          ...(config.source ? { source: config.source.kind } : {}),
        });
        const adapter = options.createAdapter({
          connectionContext,
          connectionAdmission,
          config,
          serverName,
          workingDirectory: connectOptions.workingDirectory,
        });
        const lifetime = new AbortController();
        entry = {
          adapter,
          connectionContext,
          connecting: adapter.connectServer(serverName, config, {
            ...connectOptions,
            signal: AbortSignal.any([
              lifetime.signal,
              ...(connectOptions.signal ? [connectOptions.signal] : []),
            ]),
          }),
          key,
          lifetime,
          refs: new Set([leaseId]),
          serverName,
        };
        entries.set(key, entry);
        ownerAdded = true;
        logger?.info("MCP pooled connection created", {
          ...connectionContext,
          event: "mcp.pool.connection.created",
          mcpServerName: serverName,
          transport: config.type,
        });
      }
      if (previousKey && previousKey !== key) {
        const previous = entries.get(previousKey);
        if (previous) {
          if (previous.refs.delete(leaseId)) {
            options.telemetry?.releaseOwner({
              connectionId: previous.connectionContext.mcpConnectionId,
              ownerId: leaseId,
            });
            logger?.info("MCP connection lease released", {
              ...previous.connectionContext,
              event: "mcp.pool.lease.released",
              mcpLeaseId: leaseId,
              mcpServerName: serverName,
              refCount: previous.refs.size,
              ...(sessionId ? { sessionId } : {}),
            });
            if (previous.refs.size === 0) scheduleClose(previous);
          }
        }
      }
      leased.set(serverName, key);
      if (ownerAdded) {
        options.telemetry?.acquireOwner({
          connectionId: entry.connectionContext.mcpConnectionId,
          ownerId: leaseId,
          ...(sessionId ? { sessionId } : {}),
        });
      }
      if (previousKey !== key) {
        // workspace 隔离连接会被多个 session 共享，不能把首个 session 记成唯一 owner；
        // 单独记录 lease 生命周期才能准确表达多对一关系。
        logger?.info("MCP connection lease acquired", {
          ...entry.connectionContext,
          event: "mcp.pool.lease.acquired",
          mcpLeaseId: leaseId,
          mcpServerName: serverName,
          refCount: entry.refs.size,
          ...(sessionId ? { sessionId } : {}),
        });
      }
      // 先登记 ownership 再 await；关闭 lease 必须能释放等待重连的 entry，不能被迟到结果复活。
      if (shouldRevalidate) {
        await revalidateMcpPoolEntry(entry, config, connectOptions, logger);
      }
      const status = await entry.connecting;
      assertLeaseOpen();
      if (leased.get(serverName) !== key || entries.get(key) !== entry) {
        throw new Error("MCP connection lease changed");
      }
      return status;
    };

    const snapshot = async (): Promise<McpConnectionSnapshot> => {
      const statuses: Record<string, McpServerStatus> = {};
      const tools: McpToolDescriptor[] = [];
      for (const [serverName, key] of leased) {
        const entry = entries.get(key);
        if (!entry) continue;
        const status = (await entry.adapter.status())[serverName];
        if (status) statuses[serverName] = status;
        tools.push(...(await entry.adapter.listTools()));
      }
      if (sessionId && !sessionStartupReported) {
        sessionStartupReported = true;
        const enabledServers = [...configuredServers].filter(
          ([, config]) => config.enabled !== false,
        );
        const connectedCount = enabledServers.filter(
          ([serverName]) => statuses[serverName]?.status === "connected",
        ).length;
        options.telemetry?.recordSessionStartup({
          configuredCount: enabledServers.length,
          connectedCount,
          failedCount: enabledServers.length - connectedCount,
          processCount: enabledServers.filter(
            ([serverName, config]) =>
              config.type === "stdio" && statuses[serverName]?.status === "connected",
          ).length,
          sessionId,
        });
      }
      return { statuses, tools };
    };

    return {
      async callTool(
        request: McpCallToolRequest,
        callOptions?: McpCallToolOptions,
      ): Promise<McpToolCallResult> {
        return await requireEntry(request.serverName).adapter.callTool(request, callOptions);
      },
      async close(): Promise<void> {
        if (leaseClosed) return;
        leaseClosed = true;
        for (const serverName of [...leased.keys()]) release(serverName);
      },
      async connectConfiguredServers(
        servers: Record<string, McpServerConfig>,
        connectOptions: McpConnectOptions = {},
      ): Promise<McpConnectionSnapshot> {
        assertLeaseOpen();
        configuredServers.clear();
        for (const [serverName, config] of Object.entries(servers)) {
          configuredServers.set(serverName, config);
        }
        const configuredNames = new Set(Object.keys(servers));
        for (const serverName of [...leased.keys()]) {
          if (!configuredNames.has(serverName)) release(serverName);
        }
        await Promise.all(
          Object.entries(servers).map(([serverName, config]) =>
            acquire(serverName, config, connectOptions),
          ),
        );
        assertLeaseOpen();
        return await snapshot();
      },
      async connectServer(
        serverName: string,
        config: McpServerConfig,
        connectOptions: McpConnectOptions = {},
      ): Promise<McpServerStatus> {
        return await acquire(serverName, config, connectOptions);
      },
      async disconnectServer(serverName: string): Promise<McpServerStatus | undefined> {
        const key = leased.get(serverName);
        const entry = key ? entries.get(key) : undefined;
        const status = entry ? (await entry.adapter.status())[serverName] : undefined;
        release(serverName);
        return status
          ? {
              ...status,
              status: "disconnected",
              toolCount: 0,
              updatedAt: new Date().toISOString(),
            }
          : undefined;
      },
      async listTools(): Promise<McpToolDescriptor[]> {
        return (await snapshot()).tools;
      },
      async pingServer(serverName: string, pingOptions?: { timeoutMs?: number }): Promise<boolean> {
        const key = leased.get(serverName);
        const entry = key ? entries.get(key) : undefined;
        if (!entry) return false;
        return (await entry.adapter.pingServer?.(serverName, pingOptions)) ?? true;
      },
      async status(): Promise<Record<string, McpServerStatus>> {
        return (await snapshot()).statuses;
      },
    };
  };

  return {
    acquireLease,
    async close(): Promise<void> {
      if (closePromise) return await closePromise;
      closed = true;
      const drained = connectionAdmission.close();
      const pending = [...entries.values()];
      entries.clear();
      closePromise = (async () => {
        await Promise.all(pending.map(closeEntry));
        await drained;
      })();
      await closePromise;
    },
    stats() {
      return {
        activeConnections: entries.size,
        pendingCloseConnections: [...entries.values()].filter((entry) => entry.refs.size === 0)
          .length,
      };
    },
  };
}
