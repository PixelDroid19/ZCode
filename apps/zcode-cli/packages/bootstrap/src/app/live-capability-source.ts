import { createHash } from "node:crypto";
import {
  createToolRegistry,
  registerMcpTools,
  toMcpToolName,
  type AgentRuntimeConfig,
  type PreparedRuntimeCapabilities,
  type RuntimeCapabilitySource,
  type ToolEntry,
} from "@zcode/core";
import type {
  McpConnectionSnapshot,
  McpPort,
  PluginReferenceCatalog,
  SkillLoadOutcome,
  SkillPort,
} from "@zcode/contracts";

/** A complete candidate, assembled by adapters before it reaches the runtime. */
export interface LoadedCapabilityEnvironment {
  revision: string;
  tools: readonly ToolEntry[];
  skills: SkillLoadOutcome;
  instructions?: string;
  skillPort?: SkillPort;
  pluginReferenceCatalog: PluginReferenceCatalog;
  mcp: NonNullable<AgentRuntimeConfig["mcp"]>;
  officialCuaServerNames?: ReadonlySet<string>;
  runtimeConfig?: Pick<
    AgentRuntimeConfig,
    "hooks" | "subagents" | "skillMetadataBudget" | "runtimeFeatures"
  >;
  watchPaths?: readonly string[];
  disposeTools?: () => Promise<void>;
  mcpContentRevision?: string;
  verifyMcpContentRevision?: () => Promise<void>;
  network?: { httpProxy?: string; noProxy?: string; caCertFile?: string };
}

interface McpLease {
  key: string;
  port?: McpPort;
  snapshot: McpConnectionSnapshot;
  refs: number;
  closed: boolean;
}

export interface LiveCapabilitySourceOptions {
  workingDirectory: string;
  workspaceIdentity?: string;
  load: (revision?: string) => Promise<LoadedCapabilityEnvironment | undefined>;
  createMcpPort: (input: { revision: string; environment: LoadedCapabilityEnvironment }) => McpPort;
  initialMcpPort?: McpPort;
  ownsInitialMcpPort?: boolean;
  toolAllowlist?: readonly string[];
  toolDisallowlist?: readonly string[];
  subscribe?: RuntimeCapabilitySource["subscribe"];
  onCommit?: (environment: LoadedCapabilityEnvironment, port?: McpPort) => void;
  onWatchPaths?: (paths: readonly string[]) => void;
  closeWatcher?: () => void;
}

const MCP_RELOAD_AUTHORIZATION_TIMEOUT_MS = 15_000;

/**
 * 每一版本持有独立 lease：候选失败不能断开已发布版本，旧工具完成后才释放旧连接。
 * 同一 MCP 配置只增加引用，不因 skill 内容变更重复连接。
 */
export function createLiveCapabilitySource(
  options: LiveCapabilitySourceOptions,
): RuntimeCapabilitySource {
  let disposed = false;
  let current: McpLease | undefined;
  let initialPort = options.initialMcpPort;
  const leases = new Set<McpLease>();
  const closeLease = async (lease: McpLease) => {
    if (lease.closed) return;
    lease.closed = true;
    leases.delete(lease);
    if (lease.port !== options.initialMcpPort || options.ownsInitialMcpPort)
      await lease.port?.close();
  };

  return {
    ownsMcp: true,
    subscribe: options.subscribe,
    async prepare(input): Promise<PreparedRuntimeCapabilities | undefined> {
      if (disposed) throw new Error("Capability source is closed");
      input.abortSignal?.throwIfAborted();
      const environment = await options.load(input.revision);
      if (!environment) return undefined;
      try {
        options.onWatchPaths?.(environment.watchPaths ?? []);
        input.abortSignal?.throwIfAborted();
      } catch (error) {
        await environment.disposeTools?.();
        throw error;
      }
      if (environment.revision === input.revision) {
        await environment.disposeTools?.();
        return undefined;
      }
      const servers = environment.mcp.enabled === false ? {} : (environment.mcp.servers ?? {});
      const key = createHash("sha256")
        .update(
          JSON.stringify({
            servers,
            network: environment.network,
            source: environment.mcpContentRevision,
          }),
        )
        .digest("hex");
      let lease = current?.key === key && !current.closed ? current : undefined;
      let created = false;
      if (!lease) {
        const port =
          environment.mcp.enabled === false
            ? undefined
            : (initialPort ??
              (Object.keys(servers).length
                ? options.createMcpPort({ revision: key, environment })
                : undefined));
        if (port === initialPort) initialPort = undefined;
        lease = { key, port, snapshot: { statuses: {}, tools: [] }, refs: 0, closed: false };
        leases.add(lease);
        created = true;
        try {
          if (port) {
            await environment.verifyMcpContentRevision?.();
            lease.snapshot = await port.connectConfiguredServers(servers, {
              workingDirectory: options.workingDirectory,
              workspaceIdentity: options.workspaceIdentity?.trim() || options.workingDirectory,
              trace: input.traceContext,
              capabilityRevision: environment.mcpContentRevision,
              signal: input.abortSignal,
              oauthAuthorizationTimeoutMs: MCP_RELOAD_AUTHORIZATION_TIMEOUT_MS,
            });
            // 握手可能跨越文件修改；发布前再次验证，避免把新进程标成旧脚本版本。
            await environment.verifyMcpContentRevision?.();
            // 配置中的连接都成功后才发布；缺失状态也不能被当作连接成功。
            for (const [name, config] of Object.entries(servers)) {
              if (config.enabled === false) continue;
              if (lease.snapshot.statuses[name]?.status !== "connected") {
                throw new Error(
                  "MCP capability preparation failed; the previous version remains active",
                );
              }
            }
          }
          input.abortSignal?.throwIfAborted();
          if (disposed) throw new Error("Capability source is closed");
        } catch (error) {
          await closeLease(lease);
          await environment.disposeTools?.();
          throw error;
        }
      }

      try {
        const registry = createToolRegistry();
        const descriptorNames = lease.snapshot.tools.map(toMcpToolName);
        if (new Set(descriptorNames).size !== descriptorNames.length)
          throw new Error("Duplicate MCP tool identity");
        if (lease.port)
          registerMcpTools(registry, lease.port, lease.snapshot.tools, {
            allowedTools: options.toolAllowlist,
            disallowedTools: options.toolDisallowlist,
            officialCuaServerNames: environment.officialCuaServerNames,
          });
        const tools = registry.list().map((name) => registry.get(name)!);
        const seen = new Set(tools.map((tool) => tool.metadata.name));
        for (const tool of environment.tools) {
          if (seen.has(tool.metadata.name)) throw new Error("Duplicate live tool identity");
          seen.add(tool.metadata.name);
          tools.push(tool);
        }
        lease.refs++;
        const owned = lease;
        let released = false;
        return {
          revision: environment.revision,
          tools,
          skills: environment.skills,
          instructions: environment.instructions,
          skillPort: environment.skillPort,
          pluginReferenceCatalog: environment.pluginReferenceCatalog,
          mcp: { config: environment.mcp, port: lease.port, snapshot: lease.snapshot },
          runtimeConfig: environment.runtimeConfig,
          commit() {
            if (disposed || owned.closed) throw new Error("Capability source is closed");
            options.onCommit?.(environment, owned.port);
            current = owned;
          },
          async release() {
            if (released) return;
            released = true;
            try {
              await environment.disposeTools?.();
            } finally {
              if (--owned.refs === 0) await closeLease(owned);
            }
          },
        };
      } catch (error) {
        if (created) await closeLease(lease);
        await environment.disposeTools?.();
        throw error;
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      options.closeWatcher?.();
      await Promise.all([...leases].map(closeLease));
      if (initialPort && options.ownsInitialMcpPort) await initialPort.close();
      initialPort = undefined;
    },
  };
}
