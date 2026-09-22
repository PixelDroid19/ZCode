import type {
  AgentRuntimeConfig,
  PresentationSurface,
  WorkflowAgentRunner,
  WorkspaceHookReviewTarget,
} from "@zcode/core";

import type {
  WorkspaceHookReviewDecision,
  WorkspaceHookTrustRevokeTarget,
} from "@zcode/shared/zcode-protocol-v4";

import type { SessionStorePort } from "@zcode/contracts";

export interface WorkspaceHookReviewHostContext {
  taskId: string;
  runId: string;
  workspaceLabel: string;
  remoteSessionId?: string;
}

export type RespondWorkspaceHookReviewInput = WorkspaceHookReviewTarget & {
  decision: WorkspaceHookReviewDecision;
};

export type ToggleWorkspaceHookReviewItemInput = WorkspaceHookReviewTarget & {
  reviewItemId: string;
  enabled: boolean;
};

export type RevokeWorkspaceHookTrustInput =
  | (WorkspaceHookReviewTarget & { reviewItemIds: string[] })
  | WorkspaceHookTrustRevokeTarget;

export type ZCodeAppRuntimeConfigInput = AgentRuntimeConfig;

export interface ResolveLatestSessionOptions {
  directory: string;
  env?: NodeJS.ProcessEnv;
  sessionStore?: SessionStorePort;
}

export interface RunZCodeProtocolAgentOptions {
  /** 入口拥有退出时限；bootstrap 只编排取消和资源清理，不直接退出进程。 */
  lifecycle?: {
    readonly signal: AbortSignal;
    readonly deadlineAt: number | undefined;
    requestShutdown(error?: Error): void;
  };
  /** Desktop 内部命令：只运行原存储准备并退出。 */
  prepareStorageOnly?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  presentationSurface?: PresentationSurface;
  version?: string;
}

export interface ListZCodeSessionsOptions {
  directory?: string;
  env?: NodeJS.ProcessEnv;
  limit?: number;
  sessionStore?: SessionStorePort;
}

export type { ZCodeAppOptions } from "./app-options.js";

export type { SubmitPromptOptionsBase } from "./app-input-types.js";

export type { SubmitPromptOptions } from "./app-input-types.js";

export type { PrepareUserExecutionBoundary } from "./app-input-types.js";

export type { SteerTurnOptions } from "./app-input-types.js";

export type { SendInputOptions } from "./app-input-types.js";

export type { UserPromptInput } from "./app-input-types.js";

export type { PromptInput } from "./app-input-types.js";

export type { SendInputResult } from "./app-input-types.js";

export type { ResumeOptions } from "./app-input-types.js";

export type { ZCodePluginSetResult } from "./app-input-types.js";

export type { ZCodePluginUninstallResult } from "./app-input-types.js";

export type { SetLocaleResult } from "./app-input-types.js";

export type { ZCodeApp } from "./app-contract.js";

export type { ZCodeModelOption } from "@zcode/shared";

export type { WorkflowAgentRunner };
