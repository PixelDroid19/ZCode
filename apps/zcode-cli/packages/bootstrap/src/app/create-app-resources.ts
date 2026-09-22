import { join } from "node:path";
import { createNodeToolArtifactStore, SqliteMemoryStore } from "@zcode/adapters/storage";
import { resolvePath } from "@zcode/adapters/config";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createNodeWebFetchHttpClientAdapter } from "@zcode/adapters/http";
import { createJimpImageProcessorAdapter } from "@zcode/adapters/image";
import { createPopplerPdfDocumentAdapter } from "@zcode/adapters/pdf";
import { createNodeSessionMailboxAdapter } from "@zcode/adapters/mailbox";
import { createMcpAdapter } from "@zcode/adapters/mcp";
import { AgentRuntime, PermissionService, buildPluginReferenceCatalog } from "@zcode/core";
import {
  createSessionEvent,
  type Logger,
  type SessionId,
  type TraceContext,
} from "@zcode/contracts";
import { resolveZCodeRuntimeEnv } from "@zcode/shared";
import { getCliStorageRoot, getModelIoDir, projectIdFromDirectory } from "./paths.js";
import {
  asInputHistoryStore,
  asLocalSettingStore,
  openStartupSessionStore,
  readProjectPermissionMode,
} from "./session-store.js";
import { resolvePluginRuntimeFeatures } from "./plugin-runtime-features.js";
import { resolveAppRuntimeConfig, runtimeConfigLogContext } from "./runtime-config.js";
import { createWorkspaceHookRuntimeSecurity } from "./workspace-hook-trust.js";
import {
  createNodeReplBrowserBroker,
  injectNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "./node-repl-browser-broker.js";
import { resolveBuiltInNodeReplMcpServers } from "./built-in-node-repl.js";
import { loadPluginAgentProfiles, loadZCodeAgentProfiles } from "../subagents.js";
import {
  debugRuntimeConfigResolved,
  markMcpAdapterInitialized,
  markStorageAdaptersInitialized,
  resolveStartupPlugins,
} from "./startup-marks.js";
import { isMessageEnabled } from "./app-config-options.js";
import type { ZCodeAppOptions } from "./types.js";
import type { ConfigResult } from "@zcode/adapters/config";
import type { StartupTimer } from "../startup-logging.js";

export interface NodeReplBrowserBrokerState {
  current?: NodeReplBrowserBroker;
  owned?: NodeReplBrowserBroker;
}

export type WorkspaceHookRuntimeSecurityHandle = ReturnType<
  typeof createWorkspaceHookRuntimeSecurity
>;

interface CreateAppResourcesInput {
  appVersion: string;
  browserBroker: NodeReplBrowserBrokerState;
  configResult: ConfigResult;
  getRuntime(): AgentRuntime;
  logger: Logger;
  options: ZCodeAppOptions;
  sessionId: SessionId;
  startupTimer: StartupTimer;
  traceContext: TraceContext;
  workingDirectory: string;
}

export async function createAppResources(input: CreateAppResourcesInput) {
  const {
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
  } = input;
  const storageRoot = resolvePath(configResult.config.storage.dir);
  const cliStorageRoot = getCliStorageRoot(storageRoot);
  const modelIoDir = getModelIoDir(
    cliStorageRoot,
    resolveZCodeRuntimeEnv(options.env ?? process.env) === "development",
  );
  const zcodeSubagentProfileOutcome = await loadZCodeAgentProfiles({
    logger,
    storageRoot,
    workingDirectory,
  });
  const zcodeSubagentProfiles = zcodeSubagentProfileOutcome.profiles;
  const pluginOutcome = resolveStartupPlugins({
    cliStorageRoot,
    configResult,
    env: options.env,
    logger,
    options,
    startupTimer,
    workingDirectory,
  });
  const pluginSubagentProfiles = loadPluginAgentProfiles({
    logger,
    plugins: pluginOutcome.plugins,
    reservedProfileNames: zcodeSubagentProfiles.map((profile) => profile.name),
    modelSelectionOverrides: zcodeSubagentProfileOutcome.pluginAgentModelSelectionOverrides,
  }).profiles;
  const pluginRuntimeFeatures = resolvePluginRuntimeFeatures(pluginOutcome);
  const builtInMcpServers = resolveBuiltInNodeReplMcpServers({
    pluginOutcome,
    workingDirectory,
  });
  // 用户目录已在 loader 前完成原地迁移；不能给项目/插件旧身份加内存兼容旁路。
  const subagentProfiles = [...zcodeSubagentProfiles, ...pluginSubagentProfiles];
  const ownsSessionStore = options.sessionStore === undefined;
  const sessionStore =
    options.sessionStore ?? (await openStartupSessionStore(configResult, startupTimer));
  const localSettingStore = asLocalSettingStore(sessionStore);
  const projectID = projectIdFromDirectory(workingDirectory);
  const persistedMode = options.runtimeConfig?.mode
    ? undefined
    : readProjectPermissionMode(localSettingStore, projectID);
  let { configuredMcpServers, runtimeConfig, untrustedProjectMcpServers } = resolveAppRuntimeConfig(
    {
      cliStorageRoot,
      configResult,
      options,
      persistedMode,
      pluginHooks: pluginOutcome.hooks,
      pluginMcpServers: pluginOutcome.mcpServers,
      builtInMcpServers,
      pluginRuntimeFeatures,
      builtInSubagentModelSelectionOverrides:
        zcodeSubagentProfileOutcome.builtInModelSelectionOverrides,
      subagentOutputRootDir: join(cliStorageRoot, "agents"),
      subagentProfiles,
      storageRoot,
      workingDirectory,
      workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
    },
  );
  const browserControlPort = options.browserControlPort;
  if (
    browserControlPort &&
    pluginRuntimeFeatures.browserUse === true &&
    runtimeConfig.mcp?.servers?.node_repl?.type === "stdio"
  ) {
    browserBroker.current =
      options.nodeReplBrowserBroker ??
      (browserBroker.owned = createNodeReplBrowserBroker({
        browserControlPort,
        logger,
        platform: options.platform,
      }));
    configuredMcpServers = injectNodeReplBrowserBroker(configuredMcpServers, browserBroker.current);
    runtimeConfig.mcp = {
      ...runtimeConfig.mcp,
      servers: injectNodeReplBrowserBroker(runtimeConfig.mcp.servers ?? {}, browserBroker.current),
    };
  }
  startupTimer.mark("ZCode runtime configuration resolved", {
    context: runtimeConfigLogContext(runtimeConfig, workingDirectory),
    event: "bootstrap.app.startup.runtime_config.completed",
    stage: "resolve_runtime_config",
  });
  // 初始身份目录用于启动；之后只有 runtime 已采用的版本可以进入会话视图。
  const pluginReferenceCatalog = buildPluginReferenceCatalog(pluginOutcome.plugins);
  runtimeConfig.pluginReferenceCatalog = pluginReferenceCatalog;
  const workspaceHookRuntimeSecurity = createWorkspaceHookRuntimeSecurity({
    appVersion,
    logger,
    projectConfigPath: options.projectConfigPath,
    policy: options.workspaceHookPolicy,
    policyProvider: options.workspaceHookPolicyProvider,
    reviewHost: options.workspaceHookReviewHost,
    workspaceHookTrustEnabled: options.workspaceHookTrustEnabled,
    runtimeRoot: configResult.sources.project.workspaceHookRuntimeRoot ?? {
      // Fallback 只在 config-factory 未导出时生效（理论上不会发生）。
      // 此处原本无条件按单层 runtimeConfig.hooks 重建 runtimeRoot，与
      // config-factory 遍历 default/user/project/env/cli 全部层的推导不一致，
      // 导致 review 快照与 toggle 重建的 bundleDigest 不同，
      // 「审核中 toggle」被误报为 workspace_hooks_snapshot_mismatch。
      enabled: runtimeConfig.hooks?.enabled === true,
      timeoutMs: runtimeConfig.hooks?.timeoutMs ?? 60_000,
      maxOutputBytes: runtimeConfig.hooks?.maxOutputBytes ?? 32_768,
    },
    sessionId,
    snapshot: configResult.sources.project.workspaceHookSnapshot,
    userConfigPath: configResult.sources.user.path,
    workingDirectory,
    ...(options.workspaceHookReviewHost
      ? {
          emitReviewEvent: async (event) => {
            const runtime = getRuntime();
            await runtime.appendEvent(
              createSessionEvent(event.type, sessionId, event.payload, {
                traceId: traceContext.traceId,
              }),
              traceContext,
            );
          },
          emitAdmissionEvent: async (event) => {
            const runtime = getRuntime();
            await runtime.appendEvent(
              createSessionEvent(event.type, sessionId, event.payload, {
                traceId: traceContext.traceId,
              }),
              traceContext,
            );
          },
        }
      : {}),
  });
  const permissionService = new PermissionService({
    allowedTools: new Set(configResult.config.permission.allowedTools),
    autoApproveHighRisk: configResult.config.permission.autoApproveHighRisk,
    disallowedTools: new Set(configResult.config.permission.disallowedTools),
    allowMediumRiskInAutoMode: configResult.config.permission.allowMediumRiskInAuto,
  });
  const inputHistoryStore = options.inputHistoryStore ?? asInputHistoryStore(sessionStore);
  const artifactStore =
    options.artifactStore ??
    createNodeToolArtifactStore({
      imageCacheRootDir: join(storageRoot, "cli", "image-cache"),
      pdfCacheRootDir: join(storageRoot, "cli", "pdf-cache"),
      rootDir: join(storageRoot, "cli", "artifacts"),
      videoCacheRootDir: join(storageRoot, "cli", "video-cache"),
    });
  const imageProcessorPort = options.imageProcessorPort ?? createJimpImageProcessorAdapter();
  const messageEnabled = isMessageEnabled(options.env ?? process.env);
  const sessionMailboxPort =
    options.sessionMailboxPort ??
    (messageEnabled
      ? createNodeSessionMailboxAdapter({
          rootDir: resolvePath(
            (options.env ?? process.env).ZCODE_MAILBOX_ROOT ?? "~/.zcode/mailbox",
          ),
        })
      : undefined);
  markStorageAdaptersInitialized({
    cliStorageRoot,
    hasInjectedArtifactStore: options.artifactStore !== undefined,
    hasInjectedSessionStore: options.sessionStore !== undefined,
    startupTimer,
    storageRoot,
  });
  const mcpPort =
    options.mcpPort ??
    (runtimeConfig.mcp?.enabled === false
      ? undefined
      : (options.mcpPortFactory?.({ workingDirectory }) ??
        createMcpAdapter({
          clientVersion: appVersion,
          env: options.env,
          logger,
          network: {
            httpProxy: configResult.config.network.httpProxy,
            noProxy: configResult.config.network.noProxy,
            caCertFile: configResult.config.network.caCertFile,
          },
          workingDirectory,
        })));
  const ownsMcpPort = options.mcpPort === undefined && mcpPort !== undefined;
  const executionPort =
    options.executionPort ??
    createNodeExecutionAdapter({
      onToolExecResource: options.onToolExecResource,
      network: {
        httpProxy: configResult.config.network.httpProxy,
        noProxy: configResult.config.network.noProxy,
        caCertFile: configResult.config.network.caCertFile,
      },
      outputRootDir: join(storageRoot, "cli", "exec"),
      processEnv: options.env ?? process.env,
    });
  const ownsExecutionPort = options.executionPort === undefined;
  const pdfDocumentPort =
    options.pdfDocumentPort ?? createPopplerPdfDocumentAdapter({ executionPort });
  // browser-use 控制端口：仅当宿主（desktop）注入时可用，无本地 fallback（纯 CLI 无浏览器底座）。
  const fileSystemPort = options.fileSystemPort ?? createNodeFileSystemAdapter();
  const httpClientPort =
    options.httpClientPort ??
    createNodeWebFetchHttpClientAdapter({
      env: options.env ?? process.env,
      timeoutMs: configResult.config.network.timeout,
      proxyUrl: configResult.config.network.httpProxy,
      noProxy: configResult.config.network.noProxy,
      caCertFile: configResult.config.network.caCertFile,
    });
  markMcpAdapterInitialized({
    configuredMcpServers,
    hasInjectedMcpPort: options.mcpPort !== undefined,
    mcpEnabled: runtimeConfig.mcp?.enabled !== false,
    startupTimer,
    trustedMcpServerCount: Object.keys(runtimeConfig.mcp?.servers ?? {}).length,
  });
  debugRuntimeConfigResolved({
    configResult,
    logger,
    runtimeConfig,
  });
  const memoryStore =
    runtimeConfig.memory?.enabled === false || runtimeConfig.memory?.use === false
      ? undefined
      : await SqliteMemoryStore.open({
          dbPath: join(cliStorageRoot, "memories", "experience.sqlite"),
        });
  return {
    artifactStore,
    cliStorageRoot,
    configuredMcpServers,
    executionPort,
    fileSystemPort,
    httpClientPort,
    imageProcessorPort,
    inputHistoryStore,
    localSettingStore,
    memoryStore,
    mcpPort,
    modelIoDir,
    ownsExecutionPort,
    ownsMcpPort,
    ownsSessionStore,
    pdfDocumentPort,
    permissionService,
    pluginOutcome,
    pluginReferenceCatalog,
    pluginRuntimeFeatures,
    projectID,
    runtimeConfig,
    sessionMailboxPort,
    sessionStore,
    storageRoot,
    untrustedProjectMcpServers,
    workspaceHookRuntimeSecurity:
      workspaceHookRuntimeSecurity as WorkspaceHookRuntimeSecurityHandle,
  };
}
