import type { AgentRuntimeConfig } from "../types.js";
import type { MemoryAccess } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { resolveProjectMemoryRoot } from "../../memory/project-root.js";

export function isStructuredMemoryEnabled(
  runtime: AgentRuntimeInternal,
  config: AgentRuntimeConfig = runtime.config,
): boolean {
  return (
    runtime.memoryStore !== undefined &&
    config.memory?.enabled !== false &&
    config.memory?.use !== false
  );
}

export function createRuntimeMemoryAccess(
  runtime: AgentRuntimeInternal,
  traceContext?: MemoryAccess["traceContext"],
  signal?: AbortSignal,
): Pick<MemoryAccess, "projectKey" | "sessionId" | "agentId"> &
  Pick<MemoryAccess, "traceContext" | "signal"> {
  return {
    projectKey:
      runtime.config.memory?.workspaceIdentity?.trim() ||
      runtime.memoryWorkspaceRoot ||
      runtime.workspaceRoot,
    sessionId: runtime.sessionId,
    ...(runtime.config.agentName ? { agentId: runtime.config.agentName } : {}),
    ...(traceContext ? { traceContext } : {}),
    ...(signal ? { signal } : {}),
  };
}

export function resolveEnabledProjectMemoryRoot(
  config: AgentRuntimeConfig,
  workspacePath: string,
): string | undefined {
  const memory = config.memory;
  if (!memory?.enabled || memory.use === false || !memory.cliStorageRoot) return undefined;
  if (!isMainMemoryTaskType(config.taskType)) return undefined;

  return resolveProjectMemoryRoot({
    cliStorageRoot: memory.cliStorageRoot,
    workspaceIdentity: memory.workspaceIdentity,
    workspacePath,
  });
}

function isMainMemoryTaskType(taskType: AgentRuntimeConfig["taskType"]): boolean {
  return (
    taskType === undefined ||
    taskType === "interactive" ||
    taskType === "fork" ||
    taskType === "selection_side_chat" ||
    taskType === "workflow_parent"
  );
}
