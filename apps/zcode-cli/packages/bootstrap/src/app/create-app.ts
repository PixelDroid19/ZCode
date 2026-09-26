import { resolve } from "node:path";
import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import { createConfig } from "@zcode/adapters/config";
import { createNodeContextSourceAdapter } from "@zcode/adapters/context";
import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import { AgentRuntime } from "@zcode/core";
import { createModelTelemetry } from "@zcode/telemetry";
import { createRootTraceContext, createSessionId } from "@zcode/contracts";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import { createModelAdapter } from "../model-factory.js";
import { scheduleStartupLogRetentionCleanup } from "../log-retention.js";
import { startupNow } from "../startup-logging.js";
import { createConfigCliOverrides, resolveEffectiveConfigResult } from "./app-config-options.js";
import { createAppApi } from "./create-app-api.js";
import { createAppDynamicWorkflowRunPort } from "./create-app-dynamic-workflow.js";
import { createAppFacades } from "./create-app-facades.js";
import { createAppResources, type NodeReplBrowserBrokerState } from "./create-app-resources.js";
import { createAppSessionLifecycle } from "./create-app-session-lifecycle.js";
import { collectDynamicWorkflowDisabledSkillPaths } from "./dynamic-workflow-gate.js";
import { createDynamicWorkflowSnippetService } from "./dynamic-workflow-snippet-service.js";
import { createAppCapabilitySource } from "./live-capabilities.js";
import { createRuntimeAiSdkModelExecutionConfig } from "../model-config.js";
import { createModelCatalogPort } from "./model-catalog-port.js";
import { createScriptWorkflowBridge } from "./script-workflow-methods.js";
import {
  createNodeReplBrowserBroker,
  injectNodeReplBrowserBroker,
} from "./node-repl-browser-broker.js";
import { ApiProviderModelRuntime } from "./provider-registry-model-runtime.js";
import {
  completeAppStartup,
  createAppStartupLogging,
  markConfigurationLoaded,
  markRuntimeConstructed,
  startAppStartup,
} from "./startup-marks.js";
import type { ZCodeApp, ZCodeAppOptions } from "./types.js";
import { collectDisabledPaths } from "../skill-command-overrides.js";
import { getWorkflowConcurrencyGovernor } from "./workflow-concurrency-governor.js";

export async function createZCodeApp(options: ZCodeAppOptions): Promise<ZCodeApp> {
  if (!options?.providerRegistry) {
    throw new Error("createZCodeApp requires a Provider Registry");
  }
  const startupStartedAt = startupNow();
  const appVersion = options.version ?? "0.0.0";
  const sessionId = options.sessionId ?? createSessionId();
  const traceContext = options.traceContext ?? createRootTraceContext({ sessionId });
  const workingDirectory = resolve(options.runtimeConfig?.workingDirectory ?? process.cwd());
  const configResult = resolveEffectiveConfigResult(
    createConfig({
      env: options.env,
      projectConfigPath: options.projectConfigPath,
      workingDirectory,
      workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
      skipUserConfig: options.skipUserConfig,
      userConfigPath: options.userConfigPath,
      cliOverrides: createConfigCliOverrides(options),
    }),
    options,
  );
  const { loggerFactory, logger, modelLogger, startupTimer } = createAppStartupLogging({
    options,
    traceContext,
    startedAt: startupStartedAt,
  });
  startAppStartup({
    hasInjectedModelAdapter: options.modelAdapter !== undefined,
    resume: options.resume === true,
    startupTimer,
  });
  markConfigurationLoaded({
    configResult,
    startupTimer,
  });
  const modelTelemetry = createModelTelemetry({
    owner: options.telemetryOwner,
    sessionId,
  });
  const browserBroker: NodeReplBrowserBrokerState = {};
  let providerModelRuntime: ApiProviderModelRuntime | undefined;
  let memoryStore: Awaited<ReturnType<typeof createAppResources>>["memoryStore"];
  let disposeStartupCapabilities: (() => Promise<void> | void) | undefined;
  try {
    let runtime: AgentRuntime | undefined;
    const getRuntime = (): AgentRuntime => {
      if (!runtime) throw new Error("ZCode runtime is not initialized yet.");
      return runtime;
    };
    const browserControlPort = options.browserControlPort;
    const appResources = await createAppResources({
      appVersion,
      browserBroker,
      configResult,
      getRuntime,
      logger,
      options,
      sessionId,
      startupTimer,
      traceContext,
      workingDirectory,
    });
    memoryStore = appResources.memoryStore;
    const {
      artifactStore,
      bundledSkillRoots,
      cliStorageRoot,
      configuredMcpServers,
      executionPort,
      fileSystemPort,
      httpClientPort,
      imageProcessorPort,
      inputHistoryStore,
      localSettingStore,
      memoryStore: runtimeMemoryStore,
      mcpPort,
      modelIoDir,
      ownsExecutionPort,
      ownsMcpPort,
      ownsSessionStore,
      pdfDocumentPort,
      permissionService,
      pluginOutcome,
      pluginReferenceCatalog,
      projectID,
      runtimeConfig,
      sessionMailboxPort,
      sessionStore,
      storageRoot,
      untrustedProjectMcpServers,
      workspaceHookRuntimeSecurity,
    } = appResources;
    const { prepareResume, prepareUserExecutionBoundary, resumeFromStore } =
      createAppSessionLifecycle({
        getRuntime,
        logger,
        options,
        sessionId,
        sessionStore,
        traceContext,
      });

    const modelExecutionConfig = createRuntimeAiSdkModelExecutionConfig(options.env, {
      appVersion,
      network: configResult.config.network,
      sourceTitle: options.sourceTitle,
    });
    const modelAdapter =
      options.modelAdapter ??
      createModelAdapter({
        env: options.env,
        logger: modelLogger,
        modelIoDir,
        modelIoFullRetentionEnabled: options.modelIoFullRetentionEnabled,
        executionConfig: modelExecutionConfig,
        statusSink: modelTelemetry.statusSink,
        streamIdleTimeoutMs: configResult.config.modelStream.idleTimeoutMs,
      });
    if (options.modelAdapter && modelTelemetry.statusSink) {
      modelAdapter.addStatusSink(modelTelemetry.statusSink);
    }
    // 进程级并发治理器：run service 拿它的窄端口给
    // driver（每个 actor runtime 一个请求级准入端口）；主 runtime 挂它的 observer（下面 deps）——
    // 不排队、不看冷却，但计入在飞并喂信号。进程级单例——配额本就在账号上，不按会话分。
    // 不再经 adapter 级 addStatusSink 喂信号：同一事件只能沿 ticket 喂一次。
    const workflowConcurrencyGovernor = getWorkflowConcurrencyGovernor();
    modelAdapter.setModelIoFullRetentionEnabled(options.modelIoFullRetentionEnabled ?? false);
    providerModelRuntime = new ApiProviderModelRuntime({
      registry: options.providerRegistry,
      modelAdapter,
    });
    providerModelRuntime.start();
    // model factory 提前到三条 workflow child 装配线之前构造：script workflow bridge、dwf actor
    // runtime 与 expert workflow facade 都**共享**父会话这一份 factory——Registry 视图更新后
    // 新建的 Model 才看得到，child 不各自冻结一份。
    const modelFactory = providerModelRuntime.modelFactory;
    const scriptWorkflowFacade = createScriptWorkflowBridge({
      agentTelemetry: modelTelemetry.agentExecution,
      appOptions: options,
      appVersion,
      artifactStore,
      configResult,
      fileSystemPort,
      httpClientPort,
      imageProcessorPort,
      pdfDocumentPort,
      logger,
      mcpPort,
      modelFactory,
      permissionService,
      prepareUserExecutionBoundary,
      getRuntime,
      runtimeConfig,
      sessionId,
      sessionStore,
      storageRoot,
      traceContext,
      workingDirectory,
    });

    const dynamicWorkflowRunPort = createAppDynamicWorkflowRunPort({
      agentTelemetry: modelTelemetry.agentExecution,
      appVersion,
      artifactStore,
      configResult,
      concurrency: workflowConcurrencyGovernor,
      executionPort,
      fileSystemPort,
      getRuntime,
      httpClientPort,
      imageProcessorPort,
      logger,
      mcpPort,
      modelFactory,
      options,
      permissionService,
      runtimeConfig,
      sessionId,
      sessionStore,
      storageRoot,
      traceContext,
      workingDirectory,
    });
    // dwf snippet service：EvalWorkflowSnippet 的执行面。刻意**不**依赖 dwf journal——
    // snippet 完全瞬态（内存 journal），不该被 run service 的 durability 前提连坐；
    // 所以即使 run 端口因 journal 缺席而不构造，实验通道仍然可用。
    const dynamicWorkflowSnippetPort = createDynamicWorkflowSnippetService({
      executionPort,
      fileSystemPort,
      logger,
    });
    // 模型目录：工具层把用户说的模型名解析成 workflow run 的子代理选型（model-catalog-port.ts）。
    const modelCatalogPort = createModelCatalogPort({
      registry: options.providerRegistry,
      currentSelection: () => getRuntime().getSessionModelSelection(),
    });
    const liveCapabilities = createAppCapabilitySource({
      options,
      initialConfig: configResult,
      initialPlugins: pluginOutcome,
      bundledSkillRoots,
      initialRuntimeConfig: runtimeConfig,
      initialMcpPort: mcpPort,
      ownsInitialMcpPort: ownsMcpPort,
      appVersion,
      cliStorageRoot,
      storageRoot,
      workingDirectory,
      logger,
      transformMcpServers(servers, features) {
        if (browserControlPort && features?.browserUse && servers.node_repl?.type === "stdio") {
          browserBroker.current ??=
            options.nodeReplBrowserBroker ??
            (browserBroker.owned = createNodeReplBrowserBroker({
              browserControlPort,
              logger,
              platform: options.platform,
            }));
          return injectNodeReplBrowserBroker(servers, browserBroker.current);
        }
        return servers;
      },
    });
    disposeStartupCapabilities = () => liveCapabilities.source.dispose?.();
    runtime = new AgentRuntime(sessionId, runtimeConfig, {
      capabilitySource: liveCapabilities.source,
      agentTelemetry: modelTelemetry.agentExecution,
      // 主代理的模型请求过治理器的 observer：立即放行，但让治理器看见它的 429 / 成功。
      modelRequestAdmission: workflowConcurrencyGovernor.observer(),
      eventStore: options.eventStore ?? createInMemorySessionEventStore(),
      sessionStore,
      sessionMailboxPort,
      logger,
      executionPort,
      workspaceHookAdmission: workspaceHookRuntimeSecurity?.admission,
      workspaceHookSnapshot: workspaceHookRuntimeSecurity?.snapshot,
      browserControlPort,
      fileSystemPort,
      httpClientPort,
      imageProcessorPort,
      pdfDocumentPort,
      artifactStore,
      memoryStore: runtimeMemoryStore,
      memoryWorkspaceRoot: workingDirectory,
      contextSourcePort:
        options.contextSourcePort ?? createNodeContextSourceAdapter({ env: options.env }),
      skillPort:
        configResult.config.features.skill && configResult.config.skills.enabled
          ? (options.skillPort ??
            createNodeSkillAdapter({
              extraRoots: configResult.config.skills.roots,
              extraResolvedRoots: [...pluginOutcome.skillRoots, ...bundledSkillRoots],
              disabledPaths: [
                ...collectDisabledPaths(configResult.config.skillOverrides),
                // 动态工作流灰度关闭时不提供 dynamic-workflows 技能：
                // 十个工具都不在场，再让模型读到「怎么写工作流脚本」只会诱导它去调不存在的工具。
                ...(runtimeConfig.dynamicWorkflowEnabled === false
                  ? collectDynamicWorkflowDisabledSkillPaths(bundledSkillRoots)
                  : []),
              ],
            }))
          : undefined,
      mcpPort,
      eventSink: options.eventSink,
      modelFactory,
      modelIoDir,
      providerRuntimeHeadersPort: options.providerRuntimeHeadersPort,
      resolveEffectiveModelSelection: options.resolveEffectiveModelSelection,
      isRemoteWorkspace: () =>
        isRemoteWorkspaceIdentity(runtimeConfig.memory?.workspaceIdentity ?? ""),
      permissionBroker: options.permissionBroker,
      permissionService,
      workflowPort: scriptWorkflowFacade.workflowPort,
      dynamicWorkflowRunPort,
      dynamicWorkflowSnippetPort,
      modelCatalogPort,
      automationPort: options.automationPort,
      offPeakPort: options.offPeakPort,
      appVersion,
      traceContext,
    });
    disposeStartupCapabilities = () => getRuntime().disposeCapabilities();
    markRuntimeConstructed({
      hasInjectedModelAdapter: options.modelAdapter !== undefined,
      sessionId,
      startupTimer,
    });
    completeAppStartup({
      sessionId,
      startupTimer,
      workingDirectory,
    });
    scheduleStartupLogRetentionCleanup(loggerFactory, logger);
    const { inputFacade, sessionFacade, workflowFacade } = createAppFacades({
      agentTelemetry: modelTelemetry.agentExecution,
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
    });

    const closeSession = sessionFacade.close;
    return createAppApi({
      artifactStore,
      closeSession,
      configResult,
      dynamicWorkflowRunPort,
      fileSystemPort,
      getRuntime,
      inputFacade,
      memoryStore,
      modelAdapter,
      modelTelemetry,
      options,
      pluginReferenceCatalog,
      prepareUserExecutionBoundary,
      providerModelRuntime,
      resumeFromStore,
      runtime,
      scriptWorkflowFacade,
      sessionFacade,
      sessionId,
      sessionStore,
      traceContext,
      workflowFacade,
      workingDirectory,
      workspaceHookRuntimeSecurity,
    });
  } catch (error) {
    await disposeStartupCapabilities?.();
    try {
      await memoryStore?.close();
    } catch (closeError) {
      logger.warn("Failed to close experience memory store after startup failure", {
        error: closeError instanceof Error ? closeError.message : String(closeError),
        event: "memory.store.startup_cleanup_failed",
      });
    }
    providerModelRuntime?.dispose();
    void modelTelemetry.shutdown().catch(() => undefined);
    void browserBroker.owned?.close();
    startupTimer.fail("ZCode app startup failed", error, {
      context: { sessionId, workingDirectory },
      event: "bootstrap.app.startup.failed",
      stage: "total",
    });
    throw error;
  }
}
