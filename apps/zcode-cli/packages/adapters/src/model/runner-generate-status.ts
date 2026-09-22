import type { ModelTextResult } from "@zcode/contracts";
import { classifyModelFailure } from "./failure-classifier.js";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { unwrapRetryError } from "./failure-inspection.js";
import { toAdapterError } from "./runner-retry.js";
import { recordGenerateTextDebug } from "./runner-debug.js";
import { logGenerateTextDiagnostics } from "./runner-diagnostics.js";
import { modelFailureStatusFields, providerRequestIdFromHeaders } from "./runner-telemetry.js";
import {
  createStatusContext,
  publishModelStatus,
  type ModelStatusContext,
} from "./runner-status.js";
import type { GenerateTextRunInput } from "./runner-generate-input.js";
import type {
  AiSdkGenerateTextOptions,
  AiSdkGenerateTextResult,
  AiSdkModelTextRequest,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";
import type { AttemptAdmission } from "./request-admission.js";

export function generateStatusPublishOptions(
  input: Pick<GenerateTextRunInput, "logger" | "request" | "statusSink">,
  admission?: AttemptAdmission,
) {
  return {
    logger: input.logger,
    requestStatusSink: input.request.statusSink,
    statusSink: input.statusSink,
    // 本次尝试的准入票据也是它的状态事件汇。
    ...(admission?.ticket === undefined ? {} : { admissionTicket: admission.ticket }),
  };
}

export async function throwGenerateAdmissionFailure(input: {
  attempt: number;
  error: unknown;
  requestHeaderCount: number;
  requestHeaders: Record<string, string>;
  runner: GenerateTextRunInput;
  statusContext: ModelStatusContext;
}): Promise<never> {
  const failure = classifyModelFailure(input.error, input.runner.request.abortSignal);
  await publishModelStatus(
    {
      ...input.statusContext,
      attempt: input.attempt,
      message: failure.message,
      reason: failure.reason,
      requestHeaderCount: input.requestHeaderCount,
      requestHeaders: input.requestHeaders,
      retryable: false,
      statusCode: failure.statusCode,
      ...modelFailureStatusFields(input.error, failure, "connect"),
      timestamp: new Date().toISOString(),
      type: "model_request_failed",
    },
    {
      ...generateStatusPublishOptions(input.runner),
      failureError: unwrapRetryError(input.error),
    },
  );
  throw toAdapterError(input.error, failure, input.statusContext, input.attempt, {
    errorPhase: "connect",
  });
}

export async function publishGenerateRetryScheduledStatus(
  input: Pick<GenerateTextRunInput, "logger" | "request" | "statusSink">,
  statusContext: ReturnType<typeof createStatusContext>,
  attempt: number,
  delayMs: number,
  failure: ClassifiedModelFailure,
  requestHeaders: Record<string, string>,
  responseHeaders: Record<string, string>,
  admission?: AttemptAdmission,
): Promise<void> {
  await publishModelStatus(
    {
      ...statusContext,
      attempt,
      delayMs,
      message: failure.message,
      nextAttempt: attempt + 1,
      reason: failure.retryReason,
      requestHeaderCount: Object.keys(requestHeaders).length,
      requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      statusCode: failure.statusCode,
      errorCode: failure.code,
      retryAfterMs: failure.retryAfterMs,
      timestamp: new Date().toISOString(),
      type: "model_retry_scheduled",
    },
    generateStatusPublishOptions(input, admission),
  );
}

export async function completeGenerateText(input: {
  admission: AttemptAdmission;
  attempt: number;
  completedAt: number;
  isDev: boolean;
  options: AiSdkGenerateTextOptions;
  reasoning: ModelTextResult["reasoning"];
  recordModelIO: boolean;
  requestHeaderCount: number;
  requestHeaders: Record<string, string>;
  request: AiSdkModelTextRequest;
  resolved: ResolvedAiSdkModel;
  responseHeaders: Record<string, string>;
  result: AiSdkGenerateTextResult;
  runner: GenerateTextRunInput;
  sources: ModelTextResult["sources"];
  startedAt: number;
  statusContext: ModelStatusContext;
  text: string;
  toolCalls: ModelTextResult["toolCalls"];
  toolResults: ModelTextResult["toolResults"];
  usage: ModelTextResult["usage"];
}): Promise<ModelTextResult> {
  recordGenerateTextDebug({
    modelIoFullRetentionEnabled: input.runner.modelIoFullRetentionEnabled,
    attempt: input.attempt,
    debugDir: input.runner.debugDir,
    isDev: input.isDev,
    normalizedToolCalls: input.toolCalls,
    options: input.options,
    recordModelIO: input.recordModelIO,
    request: input.request,
    requestId: input.statusContext.requestId,
    resolved: input.resolved,
    result: input.result,
    startedAt: input.startedAt,
  });
  logGenerateTextDiagnostics({
    attempt: input.attempt,
    completedAt: input.completedAt,
    logger: input.runner.logger,
    result: input.result,
    statusContext: input.statusContext,
    startedAt: input.startedAt,
    toolCallCount: input.toolCalls?.length ?? 0,
    usage: input.usage,
  });
  await publishModelStatus(
    {
      ...input.statusContext,
      attempt: input.attempt,
      durationMs: input.completedAt - input.startedAt,
      finishReason: input.result.finishReason,
      requestHeaderCount: input.requestHeaderCount,
      requestHeaders: input.requestHeaders,
      responseHeaderCount: Object.keys(input.responseHeaders).length,
      responseHeaders: input.responseHeaders,
      providerRequestId: providerRequestIdFromHeaders(input.responseHeaders),
      timestamp: new Date(input.completedAt).toISOString(),
      type: "model_request_completed",
      usage: input.usage,
    },
    generateStatusPublishOptions(input.runner, input.admission),
  );

  return {
    text: input.text,
    finishReason: input.result.finishReason,
    usage: input.usage,
    reasoning: input.reasoning,
    toolCalls: input.toolCalls,
    toolResults: input.toolResults,
    sources: input.sources,
    providerMetadata: input.result.providerMetadata as Record<string, unknown> | undefined,
  };
}
