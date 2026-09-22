import type { McpPort } from "@zcode/contracts";
import { NodeMcpAdapter } from "./adapter.js";
import type { CreateMcpAdapterOptions } from "./adapter-types.js";
import { createMcpConnectionPool, type McpConnectionPool } from "./pool.js";

export type { CreateMcpAdapterOptions } from "./adapter-types.js";

/** Creates the concrete MCP adapter while preserving the package's public port. */
export function createMcpAdapter(options: CreateMcpAdapterOptions = {}): McpPort {
  return new NodeMcpAdapter(options);
}

/** Creates adapters scoped to the connection contexts owned by a shared pool. */
export function createMcpAdapterConnectionPool(
  options: CreateMcpAdapterOptions = {},
): McpConnectionPool {
  return createMcpConnectionPool({
    logger: options.logger,
    telemetry: options.telemetry,
    createAdapter: ({ connectionAdmission, connectionContext, workingDirectory }) =>
      createMcpAdapter({
        ...options,
        connectionAdmission,
        connectionContext,
        workingDirectory: workingDirectory ?? options.workingDirectory,
      }),
  });
}

export {
  createMcpConnectionPool,
  type McpConnectionPool,
  type McpConnectionPoolOptions,
} from "./pool.js";
export {
  createMcpTelemetryTracker,
  resolvePluginName,
  type McpTelemetryTracker,
  type McpTrackedProcess,
} from "./telemetry.js";
