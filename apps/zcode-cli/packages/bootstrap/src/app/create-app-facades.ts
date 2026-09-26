import type { ConfigResult } from "@zcode/adapters/config";
import type {
  AgentRuntime,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  PermissionService,
} from "@zcode/core";
import type {
  AgentExecutionTelemetryPort,
  ExecutionPort,
  ImageProcessorPort,
  Logger,
  McpPort,
  SessionId,
  SessionStorePort,
  ToolArtifactStorePort,
  TraceContext,
} from "@zcode/contracts";
import { resolveZCodeBuiltinPromptCommand } from "../builtin-prompt-command.js";
import { resolveZCodeCustomCommandPrompt } from "../custom-command-prompt.js";
import { createInputFacade } from "./input-facade.js";
import { createSessionFacade } from "./session-facade.js";
import type { CreateSessionFacadeDeps } from "./session-facade-contract.js";
import { createWorkflowFacade } from "./workflow-facade.js";
import type { DynamicWorkflowRunAppPort } from "./create-app-dynamic-workflow.js";
import type { NodeReplBrowserBrokerState } from "./create-app-resources.js";
import type { createAppCapabilitySource } from "./live-capabilities.js";
import { resolveEffectiveLocale } from "./app-config-options.js";
import type { PrepareUserExecutionBoundary, ZCodeAppOptions } from "./types.js";

interface CreateAppFacadesInput {
  agentTelemetry: AgentExecutionTelemetryPort;
  appVersion: string;
  artifactStore: ToolArtifactStorePort;
  browserBroker: NodeReplBrowserBrokerState;
  cliStorageRoot: string;
  configResult: ConfigResult;
  configuredMcpServers: CreateSessionFacadeDeps["configuredMcpServers"];
  dynamicWorkflowRunPort: DynamicWorkflowRunAppPort;
  executionPort: ExecutionPort;
  imageProcessorPort: ImageProcessorPort;
  inputHistoryStore: Parameters<typeof createInputFacade>[0]["inputHistoryStore"];
  liveCapabilities: ReturnType<typeof createAppCapabilitySource>;
  localSettingStore: CreateSessionFacadeDeps["localSettingStore"];
  logger: Logger;
  loggerFactory: CreateSessionFacadeDeps["loggerFactory"];
  mcpPort?: McpPort;
  modelFactory: NonNullable<AgentRuntimeDeps["modelFactory"]>;
  options: ZCodeAppOptions;
  ownsExecutionPort: boolean;
  ownsSessionStore: boolean;
  pdfDocumentPort: Parameters<typeof createWorkflowFacade>[0]["pdfDocumentPort"];
  permissionService: PermissionService;
  prepareResume: CreateSessionFacadeDeps["prepareResume"];
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  projectID: CreateSessionFacadeDeps["projectID"];
  runtime: AgentRuntime;
  runtimeConfig: AgentRuntimeConfig;
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  storageRoot: string;
  traceContext: TraceContext;
  untrustedProjectMcpServers: Set<string>;
  workingDirectory: string;
}

export interface AppFacades {
  inputFacade: ReturnType<typeof createInputFacade>;
  sessionFacade: ReturnType<typeof createSessionFacade>;
  workflowFacade: ReturnType<typeof createWorkflowFacade>;
}

export function createAppFacades(input: CreateAppFacadesInput): AppFacades {
  const {
    agentTelemetry,
    appVersion,
    artifactStore,
    browserBroker,
    cliStorageRoot,
    configResult,
    configuredMcpServers,
    dynamicWorkflowRunPort,
    executionPort,
    imageProcessorPort,
    inputHistoryStore,
    liveCapabilities,
    localSettingStore,
    logger,
    loggerFactory,
    mcpPort,
    modelFactory,
    options,
    ownsExecutionPort,
    ownsSessionStore,
    pdfDocumentPort,
    permissionService,
    prepareResume,
    prepareUserExecutionBoundary,
    projectID,
    runtime,
    runtimeConfig,
    sessionId,
    sessionStore,
    storageRoot,
    traceContext,
    untrustedProjectMcpServers,
    workingDirectory,
  } = input;
  const inputFacade = createInputFacade({
    artifactStore,
    customCommandPromptResolver: async (text, resolverOptions) => {
      const builtinPrompt = resolveZCodeBuiltinPromptCommand(text, {
        // 内置命令与目录使用同一开关，手动输入不能绕过 headless 工作流门禁。
        dynamicWorkflowEnabled: runtimeConfig.dynamicWorkflowEnabled,
        workingDirectory,
      });
      if (builtinPrompt !== undefined) {
        return builtinPrompt;
      }
      return await resolveZCodeCustomCommandPrompt(text, {
        env: options.env,
        executionPort,
        logger,
        projectConfigPath: options.projectConfigPath,
        sessionId,
        signal: resolverOptions?.abortSignal,
        skipUserConfig: options.skipUserConfig,
        traceContext: resolverOptions?.traceContext ?? traceContext,
        userConfigPath: options.userConfigPath,
        workingDirectory,
      });
    },
    inputHistoryStore,
    logger,
    prepareUserExecutionBoundary,
    runtime,
    sessionId,
    traceContext,
  });
  const workflowFacade = createWorkflowFacade({
    agentTelemetry,
    appOptions: options,
    appVersion,
    artifactStore,
    cliStorageRoot,
    configResult,
    eventSink: options.eventSink,
    imageProcessorPort,
    pdfDocumentPort,
    logger,
    mcpPort,
    modelFactory,
    permissionService,
    prepareUserExecutionBoundary,
    runtime,
    runtimeConfig,
    sessionId,
    sessionStore,
    storageRoot,
    traceContext,
    workingDirectory,
  });
  const sessionFacade = createSessionFacade({
    // App 关闭时停下本会话拥有的 dwf run：
    // 引擎活在本 App 的闭包里，关掉 App 而不停它，journal 行会停在 running 等下一次孤儿收敛。
    ...(dynamicWorkflowRunPort === undefined
      ? {}
      : { closeDynamicWorkflowRuns: () => dynamicWorkflowRunPort.close() }),
    configResult,
    configuredMcpServers,
    ...(options.configuredDefaultModelSelection
      ? {
          configuredDefaultModelSelection: options.configuredDefaultModelSelection,
        }
      : {}),
    executionPort,
    localSettingStore,
    logger,
    loggerFactory,
    mcpPort,
    ownsExecutionPort,
    // capability source owns connection generations and drains their individual leases.
    ownsMcpPort: false,
    getLiveMcpPort: liveCapabilities.getMcpPort,
    getLiveMcpRevision: liveCapabilities.getMcpRevision,
    workspaceIdentity: runtimeConfig.workspaceIdentity ?? runtimeConfig.memory?.workspaceIdentity,
    getLiveMcpServers: liveCapabilities.getConfiguredServers,
    closeNodeReplBrowserBroker: async () => {
      await browserBroker.owned?.close();
    },
    ownsSessionStore,
    prepareUserExecutionBoundary,
    prepareResume,
    projectID,
    providerRegistry: options.providerRegistry,
    resolveUiLocale: (locale) => resolveEffectiveLocale(locale, options),
    runtime,
    sessionId,
    sessionStore,
    traceContext,
    untrustedProjectMcpServers,
    workingDirectory,
  });
  return { inputFacade, sessionFacade, workflowFacade };
}
