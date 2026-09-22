import { createMcpAdapter } from "@zcode/adapters/mcp";
import { createLiveCapabilityWatcher } from "@zcode/adapters/live-tools";
import type { McpPort, McpServerConfig } from "@zcode/contracts";
import {
  createLiveCapabilityLoader,
  type LiveCapabilityLoaderOptions,
} from "./live-capability-loader.js";
import { createLiveCapabilitySource } from "./live-capability-source.js";

export function createAppCapabilitySource(
  input: LiveCapabilityLoaderOptions & {
    appVersion: string;
    initialMcpPort?: McpPort;
    ownsInitialMcpPort: boolean;
  },
) {
  const listeners = new Set<() => void>();
  let watcher: ReturnType<typeof createLiveCapabilityWatcher> | undefined;
  const loader = createLiveCapabilityLoader({
    ...input,
    onWatchPaths: (paths) => watcher?.update(paths),
  });
  watcher = createLiveCapabilityWatcher(loader.initialPaths, () => {
    for (const listener of listeners) listener();
  });
  let currentMcpPort = input.initialMcpPort;
  let currentMcpRevision: string | undefined;
  let configuredServers: Record<string, McpServerConfig> =
    input.initialRuntimeConfig.mcp?.servers ?? {};
  const source = createLiveCapabilitySource({
    workingDirectory: input.workingDirectory,
    workspaceIdentity:
      input.options.runtimeConfig?.workspaceIdentity ??
      input.options.runtimeConfig?.memory?.workspaceIdentity,
    load: loader.load,
    initialMcpPort: input.initialMcpPort,
    ownsInitialMcpPort: input.ownsInitialMcpPort,
    toolAllowlist: input.initialRuntimeConfig.toolAllowlist,
    toolDisallowlist: input.initialRuntimeConfig.toolDisallowlist,
    createMcpPort: ({ environment }) =>
      input.options.mcpPortFactory?.({ workingDirectory: input.workingDirectory }) ??
      createMcpAdapter({
        clientVersion: input.appVersion,
        env: input.options.env,
        logger: input.logger,
        network: environment.network,
        workingDirectory: input.workingDirectory,
      }),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    closeWatcher() {
      watcher?.close();
      listeners.clear();
    },
    onCommit(environment, port) {
      currentMcpPort = port;
      currentMcpRevision = environment.mcpContentRevision;
      configuredServers = environment.mcp.servers ?? {};
    },
  });
  return {
    source,
    getMcpPort: () => currentMcpPort,
    getMcpRevision: () => currentMcpRevision,
    getConfiguredServers: () => configuredServers,
  };
}
