import type { Logger, ModelStatusSink } from "@zcode/contracts";
import type { ModelRetryBudget } from "@zcode/contracts";
import type { EnvRecord } from "./model-execution.js";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";
import type {
  AiSdkModelRuntime,
  AiSdkModelTextRequest,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";
import type { ModelStatusContext } from "./runner-status.js";

export interface RunStreamTextInput {
  debugDir?: string;
  env: EnvRecord;
  logger?: Logger;
  modelIoFullRetentionEnabled: boolean;
  request: AiSdkModelTextRequest;
  resolveModel: () => ResolvedAiSdkModel;
  resolved: ResolvedAiSdkModel;
  retry: ResolvedAiSdkModelRetryOptions;
  runtime: AiSdkModelRuntime;
  statusSink?: ModelStatusSink;
  streamIdleTimeoutMs: number;
}

export interface StreamRunState {
  baseStatusContext: ModelStatusContext;
  emptyCompletionRetryCount: number;
  isDev: boolean;
  recordModelIO: boolean;
  requestMessages: AiSdkModelTextRequest["messages"];
  retryBudget: ModelRetryBudget | undefined;
  signatureRepairAttempted: boolean;
}

export type StreamAttemptOutcome =
  | { kind: "completed" }
  | { holdRetryBudget?: boolean; kind: "retry" };
