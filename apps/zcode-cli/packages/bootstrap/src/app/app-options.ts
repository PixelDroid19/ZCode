import type { ZCodeToolExecResource } from "@zcode/shared";

import type { AiSdkModelAdapter } from "@zcode/adapters/model";

import type { ProviderRuntimeHeadersPort, WorkspaceHookPolicyProvider } from "@zcode/core";

import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";

import type { ModelProviderSourceTitle } from "../model-config.js";

import type {
  AutomationPort,
  BrowserControlPort,
  ContextSourcePort,
  ExecutionPort,
  ExecutionShellSelection,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  InputHistoryStorePort,
  LoggerFactory,
  McpPort,
  McpServerConfig,
  ModelSelection,
  OffPeakPort,
  PdfDocumentPort,
  PermissionBrokerPort,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionMailboxPort,
  SessionStorePort,
  SkillPort,
  ToolArtifactStorePort,
  TraceContext,
  UiLocale,
  WorkflowEvent,
} from "@zcode/contracts";

import type { NodeReplBrowserBroker } from "./node-repl-browser-broker.js";

import type { AgentTelemetryRuntimeOwner, WorkspaceHookPolicy } from "@zcode/contracts";

import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";

import { type WorkspaceHookReviewHostContext, type ZCodeAppRuntimeConfigInput } from "./types.js";

export interface ZCodeAppOptions {
  sessionId?: SessionId;
  resume?: boolean;
  version?: string;
  traceContext?: TraceContext;
  runtimeConfig?: ZCodeAppRuntimeConfigInput;
  /** Explicit session maps are fixed; directory projections opt into live file resolution. */
  mcpServersSource?: "directory" | "session";
  /** Original directory values before host-only workspace/credential augmentation. */
  mcpServersBase?: Record<string, McpServerConfig>;
  /**
   * stdio 协议模式的 agent 进程由 Electron host 拉起，模型服务需要看到 electron 来源。
   * 普通 CLI 不传，继续使用 cli 默认值。
   */
  sourceTitle?: ModelProviderSourceTitle;
  eventStore?: SessionEventStorePort;
  sessionStore?: SessionStorePort;
  sessionMailboxPort?: SessionMailboxPort;
  inputHistoryStore?: InputHistoryStorePort;
  modelAdapter?: AiSdkModelAdapter;
  /** Worker 进程拥有的 Registry；App 只借用，不负责释放。 */
  providerRegistry: ProviderRegistryModelSource;
  resolveEffectiveModelSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
  /** 新 Session 使用的 Environment 默认选择；仅在没有显式 runtime modelSelection 时参与初始化。 */
  configuredDefaultModelSelection?: ModelSelection;
  modelIoFullRetentionEnabled?: boolean;
  /** 同进程嵌入宿主可注入完整的 borrowed 进程级 Owner；Endpoint 配置不得覆盖它。 */
  telemetryOwner?: AgentTelemetryRuntimeOwner;
  /**
   * provider runtime headers 端口：主 runtime 每次调用报自己的会话；child runtime 一律向父
   * runtime 取派生实例。
   */
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
  loggerFactory?: LoggerFactory;
  officialPluginRoots?: string[];
  pluginStorageRoot?: string;
  executionPort?: ExecutionPort;
  /** 资源遥测旁路；由协议宿主注入，主任务和 workflow 的执行适配器共用。 */
  onToolExecResource?: (sample: ZCodeToolExecResource) => void;
  /** browser-use 控制端口；注入后 node_repl 的 agent.browsers.* 可用。缺省则不可用。 */
  browserControlPort?: BrowserControlPort;
  /** 可由协议宿主注入的进程级 node_repl Browser broker；缺省时 app 自建并拥有。 */
  nodeReplBrowserBroker?: NodeReplBrowserBroker;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  artifactStore?: ToolArtifactStorePort;
  contextSourcePort?: ContextSourcePort;
  skillPort?: SkillPort;
  mcpPort?: McpPort;
  /** 由宿主提供 per-app lease；产出的端口归 app 所有。 */
  mcpPortFactory?: (input: { workingDirectory?: string }) => McpPort;
  permissionBroker?: PermissionBrokerPort;
  eventSink?: SessionEventSink;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | string;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  uiDetectedLocale?: string | null;
  uiLocale?: UiLocale;
  onWorkflowEvent?: (event: WorkflowEvent) => void | Promise<void>;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  /** 首次真实用户执行或 cold-resume fallback 时解析一次，之后由 app 生命周期缓存。 */
  resolveInitialBashShellSelection?: () => Promise<ExecutionShellSelection | undefined>;
  /** Trusted embedder policy; workspace/project files cannot populate this field. */
  workspaceHookPolicy?: WorkspaceHookPolicy;
  /** Protocol Host-owned provider shared by session Runtime and no-session Settings pretrust. */
  workspaceHookPolicyProvider?: WorkspaceHookPolicyProvider;
  /** Rollout gate; false keeps project Hooks hard-blocked and does not read Trust records. */
  workspaceHookTrustEnabled?: boolean;
  /** Presence means this owner Host supports the dedicated Workspace Hook review route. */
  workspaceHookReviewHost?: WorkspaceHookReviewHostContext;
}
