import { normalizeModelSelection } from "@zcode/provider";
import type { MessageId } from "@zcode/contracts";
import { listMcpServerStatuses } from "../mcp-config.js";
import { loadSessionTranscriptFromStore } from "../session-transcript.js";
import { createSubagentObservation } from "./subagent-observation.js";
import { completeAuxiliaryRegistryModelSelection } from "./provider-registry-selection.js";
import type { CreateSessionFacadeDeps, SessionFacade } from "./session-facade-contract.js";

export function createSessionOperations(
  deps: CreateSessionFacadeDeps,
): Pick<
  SessionFacade,
  | "cancelBackgroundTask"
  | "connectMcpServer"
  | "disconnectMcpServer"
  | "forkFromCheckpoint"
  | "generateWorkspaceText"
  | "listCheckpoints"
  | "listMcpServers"
  | "loadSessionTranscript"
  | "readBackgroundBashOutput"
  | "readSubagents"
  | "readSubagentTranscript"
  | "readTodos"
  | "setCustomSessionTitle"
  | "testModelConnectivity"
> {
  return {
    loadSessionTranscript: async () =>
      await loadSessionTranscriptFromStore({
        sessionId: deps.sessionId,
        sessionStore: deps.sessionStore,
      }),
    ...createSubagentObservation(deps),
    readTodos: async () => deps.sessionStore.readTodos({ sessionID: deps.sessionId }),
    setCustomSessionTitle: async (input) =>
      deps.runtime.setCustomSessionTitle({
        title: input.title,
        traceContext: input.traceContext ?? deps.traceContext,
      }),
    listMcpServers: async () => {
      await deps.runtime.refreshCapabilities({ traceContext: deps.traceContext });
      return listMcpServerStatuses(
        deps.getLiveMcpPort ? deps.getLiveMcpPort() : deps.mcpPort,
        deps.getLiveMcpServers?.() ?? deps.configuredMcpServers,
        deps.untrustedProjectMcpServers,
      );
    },
    connectMcpServer: async (name) => {
      await deps.runtime.refreshCapabilities({ traceContext: deps.traceContext });
      const config = (deps.getLiveMcpServers?.() ?? deps.configuredMcpServers)[name];
      if (!config) {
        throw new Error(`MCP server is not configured: ${name}`);
      }
      const mcpPort = deps.getLiveMcpPort ? deps.getLiveMcpPort() : deps.mcpPort;
      if (!mcpPort) {
        throw new Error("MCP is disabled");
      }
      return mcpPort.connectServer(name, config, {
        trace: deps.traceContext,
        workingDirectory: deps.workingDirectory,
        // 重连沿用已发布代际及远端身份，不能把同路径 workspace 合并到无版本 lease。
        workspaceIdentity: deps.workspaceIdentity?.trim() || deps.workingDirectory,
        capabilityRevision: deps.getLiveMcpRevision?.(),
      });
    },
    readBackgroundBashOutput: (workId, sessionId) =>
      deps.runtime.readBackgroundBashOutput(workId, sessionId),
    cancelBackgroundTask: async (taskId, options) =>
      deps.runtime.cancelBackgroundTask(taskId, {
        traceContext: options?.traceContext ?? deps.traceContext,
      }),
    disconnectMcpServer: async (name) => {
      const mcpPort = deps.getLiveMcpPort ? deps.getLiveMcpPort() : deps.mcpPort;
      if (!mcpPort) return undefined;
      return mcpPort.disconnectServer(name);
    },
    listCheckpoints: async (options) => {
      await deps.prepareResume();
      return deps.runtime.listWorkspaceCheckpoints(options);
    },
    forkFromCheckpoint: async (options) => {
      await deps.prepareResume(options?.traceContext);
      return deps.runtime.forkWorkspaceFromCheckpoint({
        targetCheckpointId: options?.targetCheckpointId,
        targetMessageId: options?.targetMessageId as MessageId | undefined,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },
    generateWorkspaceText: async (input, options) => {
      // 辅助文本入口只规范化模型身份；具体的最低档位由 Core 的辅助请求调用点显式决定。
      const selection =
        normalizeModelSelection(deps.providerRegistry.getView(), input.selection) ??
        input.selection;
      return await deps.runtime.generateWorkspaceText(
        { ...input, selection },
        {
          abortSignal: options?.abortSignal,
          traceContext: options?.traceContext ?? deps.traceContext,
        },
      );
    },
    testModelConnectivity: async (input, options) => {
      // 连接测试用的 Model 也要先绑定最低档位，否则严格 Factory 会先因缺档位失败。
      const selection = completeAuxiliaryRegistryModelSelection(
        deps.providerRegistry,
        input.selection,
      );
      await deps.runtime.testModelConnectivity(
        { ...input, selection },
        {
          abortSignal: options?.abortSignal,
          traceContext: options?.traceContext ?? deps.traceContext,
        },
      );
    },
  };
}
