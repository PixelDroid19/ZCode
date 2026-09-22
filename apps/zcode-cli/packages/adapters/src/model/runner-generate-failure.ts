import { ModelRetryReason } from "@zcode/contracts";
import { classifyModelFailure, inspectProviderFailure } from "./failure-classifier.js";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { getResponseHeaders, unwrapRetryError } from "./failure-inspection.js";
import { offPeakTicketExpiredMessage, resolveOffPeakFailureDecision } from "./offpeak-retry.js";
import { repairReasoningHistoryAfterSignatureRejection } from "./reasoning-history-normalization.js";
import { recordGenerateTextDebug } from "./runner-debug.js";
import {
  generateStatusPublishOptions,
  publishGenerateRetryScheduledStatus,
} from "./runner-generate-status.js";
import type { GenerateTextRunInput } from "./runner-generate-input.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import {
  calculateRetryDelay,
  logRetryDelayDecision,
  sleep,
  toAdapterError,
} from "./runner-retry.js";
import { modelFailureStatusFields } from "./runner-telemetry.js";
import { publishModelStatus, type ModelStatusContext } from "./runner-status.js";
import type {
  AiSdkGenerateTextOptions,
  AiSdkModelTextRequest,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";
import { RuntimeHeadersRefreshError } from "./runner-runtime-headers.js";
import type { AttemptAdmission } from "./request-admission.js";
import { retryBudgetAllows } from "./retry-budget.js";
import { retryAllowedByFailurePolicy } from "./workflow-model-failure-policy.js";

export interface GenerateTextFailureRetryState {
  requestMessages: AiSdkModelTextRequest["messages"];
  retryImmediately: boolean;
  retryWithoutBudget: boolean;
  signatureRepairAttempted: boolean;
}

export async function handleGenerateTextFailure(input: {
  admission: AttemptAdmission;
  attempt: number;
  error: unknown;
  isDev: boolean;
  options: AiSdkGenerateTextOptions | undefined;
  recordModelIO: boolean;
  requestHeaders: Record<string, string>;
  requestHeaderCount: number;
  requestInvocationCompleted: boolean;
  requestMessages: AiSdkModelTextRequest["messages"];
  request: AiSdkModelTextRequest;
  resolved: ResolvedAiSdkModel;
  retryBudget: GenerateTextRunInput["request"]["modelRetryBudget"];
  retryBudgetAttempt: number;
  runner: GenerateTextRunInput;
  signatureRepairAttempted: boolean;
  startedAt: number;
  statusContext: ModelStatusContext;
  statusMaxAttempts: (extraAttempts: number) => number;
}): Promise<GenerateTextFailureRetryState> {
  const completedAt = Date.now();
  const classified = classifyModelFailure(input.error, input.runner.request.abortSignal);
  if (input.error instanceof RuntimeHeadersRefreshError) {
    classified.message = input.error.message;
    classified.retryable = false;
  }
  // off-peak 特判（仅 idle plan provider，见 offpeak-retry.ts）：排队 429 豁免预算、
  // 3102（兼容旧 3001）以稳定标记落败触发 desktop 侧续跑。
  const offPeak = resolveOffPeakFailureDecision({
    offPeak: input.resolved.accountAccess?.mode === "off-peak",
    failure: classified,
    error: unwrapRetryError(input.error),
  });
  const failure: ClassifiedModelFailure =
    offPeak?.kind === "ticketExpired"
      ? {
          ...classified,
          retryable: false,
          message: offPeakTicketExpiredMessage(classified.message),
        }
      : offPeak?.kind === "queued"
        ? { ...classified, retryable: true, retryReason: ModelRetryReason.OffpeakQueued }
        : classified;
  const responseHeaders = sanitizeModelNetworkHeaders(
    getResponseHeaders(unwrapRetryError(input.error)),
  );
  const repairedMessages =
    !input.signatureRepairAttempted && input.resolved.providerKind === "anthropic"
      ? repairReasoningHistoryAfterSignatureRejection(input.requestMessages, input.error)
      : undefined;
  const retryWithRepairedHistory = repairedMessages !== undefined;
  let statusContext = input.statusContext;
  if (repairedMessages) {
    // 签名只对生成它的 thinking block 有效。明确收到签名校验 400 时，
    // 只替换本次请求副本，并给一次不占普通 retry 预算的物理请求机会；不能通过
    // 回退 attempt 复用 requestId，也不能改写 canonical history。
    statusContext = {
      ...statusContext,
      maxAttempts: input.statusMaxAttempts(1),
    };
  }
  const canRetryWithFailurePolicy =
    offPeak?.kind === "queued"
      ? true
      : retryBudgetAllows(
          input.retryBudget,
          input.retryBudgetAttempt,
          input.runner.retry.maxAttempts,
        ) &&
        // workflow 流量（无上限预算）读策略表而不是分类器的 retryable；有界预算逐字不变。
        retryAllowedByFailurePolicy(
          failure,
          input.retryBudget,
          inspectProviderFailure(input.error).providerErrorCode,
        );
  const canRetry = retryWithRepairedHistory || canRetryWithFailurePolicy;

  if (input.options) {
    recordGenerateTextDebug({
      modelIoFullRetentionEnabled: input.runner.modelIoFullRetentionEnabled,
      attempt: input.attempt,
      debugDir: input.runner.debugDir,
      error: input.error,
      isDev: input.isDev,
      normalizedToolCalls: undefined,
      options: input.options,
      recordModelIO: input.recordModelIO,
      request: input.request,
      requestId: statusContext.requestId,
      resolved: input.resolved,
      startedAt: input.startedAt,
    });
  }
  await publishModelStatus(
    {
      ...statusContext,
      attempt: input.attempt,
      durationMs: completedAt - input.startedAt,
      message: failure.message,
      reason: failure.reason,
      requestHeaderCount: input.requestHeaderCount,
      requestHeaders: input.requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      retryable: canRetry,
      statusCode: failure.statusCode,
      ...modelFailureStatusFields(input.error, failure, input.options ? "response" : "prepare"),
      timestamp: new Date(completedAt).toISOString(),
      type: "model_request_failed",
    },
    {
      ...generateStatusPublishOptions(input.runner, input.admission),
      failureError: unwrapRetryError(input.error),
    },
  );

  if (!canRetry) {
    logRetryDelayDecision({
      attempt: input.attempt,
      canRetry,
      failure,
      logger: input.runner.logger,
      responseHeaders,
      statusContext,
    });
    throw toAdapterError(input.error, failure, statusContext, input.attempt, {
      errorPhase: input.requestInvocationCompleted ? "response" : "prepare",
    });
  }

  if (retryWithRepairedHistory) {
    input.runner.logger?.warn("Retrying model request after thinking signature rejection", {
      attempt: input.attempt,
      event: "model.reasoning_signature_repair.retry",
      maxAttempts: statusContext.maxAttempts,
      nextAttempt: input.attempt + 1,
      requestId: statusContext.requestId,
      status: "waiting",
    });
    await publishGenerateRetryScheduledStatus(
      input.runner,
      statusContext,
      input.attempt,
      0,
      {
        ...failure,
        retryReason: ModelRetryReason.ReasoningSignatureRepair,
      },
      input.requestHeaders,
      responseHeaders,
      input.admission,
    );
    return {
      requestMessages: repairedMessages,
      retryImmediately: true,
      retryWithoutBudget: false,
      signatureRepairAttempted: true,
    };
  }

  const delayMs =
    offPeak?.kind === "queued"
      ? offPeak.delayMs
      : calculateRetryDelay(input.runner.retry, input.retryBudgetAttempt, failure.retryAfterMs);
  logRetryDelayDecision({
    attempt: input.attempt,
    canRetry,
    delayMs,
    failure,
    logger: input.runner.logger,
    responseHeaders,
    statusContext,
  });

  await publishGenerateRetryScheduledStatus(
    input.runner,
    statusContext,
    input.attempt,
    delayMs,
    failure,
    input.requestHeaders,
    responseHeaders,
    input.admission,
  );

  // 退避期间不持票：槽位让给别人，重试再准入。
  input.admission.release();
  try {
    await sleep(delayMs, input.runner.request.abortSignal);
  } catch (sleepError) {
    const sleepFailure = classifyModelFailure(sleepError, input.runner.request.abortSignal);
    const sleepResponseHeaders = sanitizeModelNetworkHeaders(
      getResponseHeaders(unwrapRetryError(sleepError)),
    );
    await publishModelStatus(
      {
        ...statusContext,
        attempt: input.attempt,
        message: sleepFailure.message,
        reason: sleepFailure.reason,
        requestHeaderCount: input.requestHeaderCount,
        requestHeaders: input.requestHeaders,
        responseHeaderCount: Object.keys(sleepResponseHeaders).length,
        responseHeaders: sleepResponseHeaders,
        retryable: false,
        statusCode: sleepFailure.statusCode,
        ...modelFailureStatusFields(sleepError, sleepFailure, "connect"),
        timestamp: new Date().toISOString(),
        type: "model_request_failed",
      },
      {
        // 退避期间票据已归还：这次取消不属于任何一次尝试，不转投票据。
        ...generateStatusPublishOptions(input.runner),
        failureError: unwrapRetryError(sleepError),
      },
    );
    throw toAdapterError(sleepError, sleepFailure, statusContext, input.attempt, {
      errorPhase: "connect",
    });
  }

  return {
    requestMessages: input.requestMessages,
    retryImmediately: false,
    retryWithoutBudget: offPeak?.kind === "queued",
    signatureRepairAttempted: input.signatureRepairAttempted,
  };
}
