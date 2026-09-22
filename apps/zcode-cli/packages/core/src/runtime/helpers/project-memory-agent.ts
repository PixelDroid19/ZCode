import type { Model, ModelInputMessage, ModelToolContract, TraceContext } from "../deps.js";
import type { AgentTelemetryCausation, ModelApiOperation } from "@zcode/contracts";
import {
  PermissionService,
  createDenyPermissionBroker,
  createToolExecutor,
  defaultPermissionConfig,
  traceContextToLogContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createToolRegistry } from "../../tool/registry.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "../methods/model-runtime-headers.js";
import { createRuntimeModel, withModelInvocationContext } from "../methods/runtime-model.js";
import { createRuntimeMemoryAccess } from "./project-memory.js";

export interface ProjectMemoryAgentContext {
  causation?: AgentTelemetryCausation;
  model: Model;
  operation: ModelApiOperation;
  tools: readonly ModelToolContract[];
  traceContext: TraceContext;
}

export function captureProjectMemoryAgentContext(
  runtime: AgentRuntimeInternal,
  input: {
    /** Extraction 继承产生该工作的 Turn Model。 */
    model?: Model;
    operation: ModelApiOperation;
    traceContext: TraceContext;
  },
): ProjectMemoryAgentContext {
  const baseModel =
    input.model ??
    createRuntimeModel(runtime, {
      selection: runtime.getSessionModelSelection(),
    });
  const model = withModelInvocationContext(baseModel, (request) => ({
    // Extraction 不写回同一 model-io 目录，避免后台请求在后续 Extraction 中自反馈。
    metadata: {
      ...traceContextToLogContext(input.traceContext),
      querySource: input.operation,
      skipTranscript: true,
    },
    modelRequestSessionType: "other",
    modelCall: { operation: input.operation },
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(runtime, {
      abortSignal: request.abortSignal,
      model,
      traceContext: input.traceContext,
    }),
    traceContext: input.traceContext,
  }));
  return {
    causation: runtime.agentTelemetry.captureCausation(),
    model,
    operation: input.operation,
    tools: runtime
      .getTools(model)
      .filter((tool) => tool.name === "Memory")
      .map((tool) => ({ ...tool })),
    traceContext: input.traceContext,
  };
}

export function buildProjectMemoryAgentProviderMessages(prompt: string): ModelInputMessage[] {
  return [
    {
      role: "system",
      content:
        "Extract durable experience using only the Memory tool and the evidence transcript supplied by the user message.",
    },
    { role: "user", content: prompt },
  ];
}

export function createProjectMemoryAgentToolExecutor(
  runtime: AgentRuntimeInternal,
  context: ProjectMemoryAgentContext,
) {
  const memoryRegistry = createToolRegistry();
  const memoryTool = runtime.registry.get("Memory");
  if (memoryTool) memoryRegistry.register(memoryTool);
  return createToolExecutor({
    emitEvent: async () => {},
    getMode: () => "yolo",
    logger: runtime.logger,
    maxConcurrency: 1,
    memoryStore: runtime.memoryStore,
    getMemoryAccess: () => createRuntimeMemoryAccess(runtime, context.traceContext),
    model: context.model,
    permissionBroker: createDenyPermissionBroker(),
    permissionService: new PermissionService(defaultPermissionConfig),
    registry: memoryRegistry,
    runtimeScope: "main",
    sessionId: runtime.sessionId,
    sessionStore: runtime.sessionStore,
    traceContext: context.traceContext,
  });
}
