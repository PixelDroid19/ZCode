import type { ModelTextResult } from "@zcode/contracts";
import {
  ModelErrorCode,
  ModelProtocolError,
  ModelTransportKind as ModelTransportKindValue,
} from "@zcode/contracts";
import { AiSdkModelAdapterError } from "./errors.js";
import { resolveAnthropicRequestMetadataUserId } from "./anthropic-request-metadata.js";
import { createGenerateTextOptions } from "./runner-options.js";
import {
  normalizeReasoning,
  normalizeSources,
  normalizeToolCalls,
  normalizeToolResults,
  normalizeUsage,
} from "./runner-normalization.js";
import { isDevelopmentModelIOEnv, shouldRecordModelIO } from "./runner-debug.js";
import { getGenerateTextResultMetadata, logGenerateTextDiagnostics } from "./runner-diagnostics.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import { scheduleEmptyCompletionRetry } from "./empty-completion-retry.js";
import {
  admissionWaitPublishers,
  createAttemptStatusContext,
  createStatusContext,
  publishModelStatus,
} from "./runner-status.js";
import { resolveModelForAttempt } from "./runner-runtime-headers.js";
import { admitAttempt, type AttemptAdmission } from "./request-admission.js";
import { retryAttemptLoopContinues, retryBudgetMaxAttempts } from "./retry-budget.js";
import { handleGenerateTextFailure } from "./runner-generate-failure.js";
import type { GenerateTextRunInput } from "./runner-generate-input.js";
import {
  serializeStructuredOutput,
  shouldRetryEmptyGenerateCompletion,
  throwIfProviderBusinessFinishError,
  waitForGenerateTextOrAbort,
} from "./runner-generate-result.js";
import {
  completeGenerateText,
  generateStatusPublishOptions,
  throwGenerateAdmissionFailure,
} from "./runner-generate-status.js";

export async function runGenerateText(input: GenerateTextRunInput): Promise<ModelTextResult> {
  // 重试预算档位：workflow actor 的请求带 unbounded，
  // 只放宽瞬态失败的放弃条件；状态事件里的 maxAttempts 以 0 表示无上限。
  const retryBudget = input.request.modelRetryBudget;
  const statusMaxAttempts = (extraAttempts: number): number =>
    retryBudgetMaxAttempts(retryBudget, input.retry.maxAttempts + extraAttempts);
  const baseStatusContext = createStatusContext({
    maxAttempts: statusMaxAttempts(0),
    request: input.request,
    resolved: input.resolved,
    transport: ModelTransportKindValue.Http,
  });
  const recordModelIO =
    input.request.metadata?.skipTranscript !== true && shouldRecordModelIO(input.env);
  const isDev = isDevelopmentModelIOEnv(input.env);
  let requestMessages = input.request.messages;
  let signatureRepairAttempted = false;
  let emptyCompletionRetryCount = 0;

  for (
    let attempt = 1;
    retryAttemptLoopContinues(
      retryBudget,
      attempt,
      input.retry.maxAttempts + Number(signatureRepairAttempted),
    );
    attempt += 1
  ) {
    const retryBudgetAttempt = attempt - Number(signatureRepairAttempted);
    const attemptRequest = { ...input.request, messages: requestMessages };
    const startedAt = Date.now();
    let resolved = input.resolved;
    let statusContext = createAttemptStatusContext(
      {
        ...baseStatusContext,
        maxAttempts: statusMaxAttempts(Number(signatureRepairAttempted)),
      },
      attempt,
    );
    let options: ReturnType<typeof createGenerateTextOptions> | undefined;
    let requestInvocationCompleted = false;
    let requestHeaders: Record<string, string> = {};
    let requestHeaderCount = 0;

    // 进程级准入：每次尝试发出前等槽位，
    // 票据在本次尝试结束时归还（成功 / 失败 / 抛出都经 finally；退避 sleep 之前先归还）。等待中被
    // 取消 → 与 sleep 被取消同一条路：记 connect 阶段的 cancelled 失败，抛出。
    let admission: AttemptAdmission;
    try {
      admission = await admitAttempt({
        admission: input.request.modelRequestAdmission,
        model: { providerId: String(resolved.providerId), modelId: String(resolved.modelId) },
        signal: input.request.abortSignal,
        ...admissionWaitPublishers(statusContext, attempt, generateStatusPublishOptions(input)),
      });
    } catch (admitError) {
      return await throwGenerateAdmissionFailure({
        attempt,
        error: admitError,
        requestHeaderCount,
        requestHeaders,
        runner: input,
        statusContext,
      });
    }

    try {
      resolved = await resolveModelForAttempt({
        attempt,
        request: attemptRequest,
        resolveModel: input.resolveModel,
      });
      const anthropicMetadataUserId = await resolveAnthropicRequestMetadataUserId({
        env: input.env,
        providerKind: resolved.providerKind,
        sessionId: statusContext.sessionId,
      });
      options = createGenerateTextOptions({
        anthropicMetadataUserId,
        env: input.env,
        includeModelIO: recordModelIO,
        request: attemptRequest,
        resolved,
        statusContext,
      });
      requestHeaders = sanitizeModelNetworkHeaders(options.headers);
      requestHeaderCount = Object.keys(requestHeaders).length;
      await publishModelStatus(
        {
          ...statusContext,
          attempt,
          requestHeaderCount,
          requestHeaders,
          timestamp: new Date(startedAt).toISOString(),
          type: "model_request_started",
        },
        generateStatusPublishOptions(input, admission),
      );

      // 部分非流式 provider/fetch 兼容层收到 AbortSignal 后不会及时 settle
      // generateText promise，导致 runtime 已 Stop，goal verifier 仍要等上游自然返回才收口。
      // adapter 是本地取消契约边界：signal 一旦 abort 就立即拒绝，迟到 provider 结果只丢弃。
      const pendingResult = input.runtime.generateText(options);
      // options 构造成功不等于 runtime 已接受请求；同步 setup 异常会在调用点直接抛出。
      // 只有 generateText 调用返回 pending promise 后才进入 response 归因边界，避免把本地 setup 记成 provider。
      requestInvocationCompleted = true;
      const result = await waitForGenerateTextOrAbort(pendingResult, input.request.abortSignal);
      const responseHeaders = sanitizeModelNetworkHeaders(
        getGenerateTextResultMetadata(result)?.response?.headers,
      );
      throwIfProviderBusinessFinishError({ result, resolved });
      const usage = normalizeUsage(result.totalUsage ?? result.usage);
      const toolCalls = normalizeToolCalls(result, input.logger);
      const toolResults = normalizeToolResults(result, toolCalls);
      const sources = normalizeSources(result);
      const text = input.request.responseJsonSchema
        ? serializeStructuredOutput(result)
        : result.text;
      const reasoning = normalizeReasoning(result.reasoning);
      if (
        shouldRetryEmptyGenerateCompletion({
          attempt,
          emptyCompletionRetryCount,
          request: input.request,
          result,
          reasoning,
          retryMaxAttempts: input.retry.maxAttempts,
          text,
          toolCalls,
          usage,
        })
      ) {
        const completedAt = Date.now();
        // 空 completion 是 provider promise 正常 resolve，不会进入异常重试 catch；
        // 必须在 adapter 返回前识别并重试一次，否则 core 只能收到最终空响应错误。
        logGenerateTextDiagnostics({
          attempt,
          completedAt,
          logger: input.logger,
          result,
          startedAt,
          statusContext,
          toolCallCount: toolCalls?.length ?? 0,
          usage,
        });
        emptyCompletionRetryCount += 1;
        await scheduleEmptyCompletionRetry({
          abortSignal: input.request.abortSignal,
          attempt,
          completedAt,
          errorPhase: "response",
          logger: input.logger,
          requestHeaders,
          requestStatusSink: input.request.statusSink,
          responseHeaders,
          retry: input.retry,
          retryBudgetAttempt,
          startedAt,
          statusContext,
          statusSink: input.statusSink,
        });
        continue;
      }
      const completedAt = Date.now();

      return await completeGenerateText({
        admission,
        attempt,
        completedAt,
        isDev,
        options,
        reasoning,
        recordModelIO,
        requestHeaderCount,
        requestHeaders,
        request: attemptRequest,
        resolved,
        responseHeaders,
        result,
        runner: input,
        sources,
        startedAt,
        statusContext,
        text,
        toolCalls,
        toolResults,
        usage,
      });
    } catch (error) {
      // 合并后鉴权解析进入 attempt try；与 stream 一致保留网络前凭据缺失的类型化错误。
      if (
        error instanceof ModelProtocolError &&
        error.code === ModelErrorCode.ModelRequestAuthMissing
      )
        throw error;
      const retryState = await handleGenerateTextFailure({
        admission,
        attempt,
        error,
        isDev,
        options,
        recordModelIO,
        requestHeaders,
        requestHeaderCount,
        requestInvocationCompleted,
        requestMessages,
        request: attemptRequest,
        resolved,
        retryBudget,
        retryBudgetAttempt,
        runner: input,
        signatureRepairAttempted,
        startedAt,
        statusContext,
        statusMaxAttempts,
      });
      requestMessages = retryState.requestMessages;
      signatureRepairAttempted = retryState.signatureRepairAttempted;
      if (retryState.retryImmediately) {
        continue;
      }
      if (retryState.retryWithoutBudget) {
        // 排队等待不消耗重试预算：回退计数让 for 自增后原地重试，无限探测。
        attempt -= 1;
      }
    } finally {
      admission.release();
    }
  }

  throw new AiSdkModelAdapterError(
    ModelErrorCode.ModelRequestFailed,
    "Model request failed before an attempt could complete",
    { context: { requestId: baseStatusContext.requestId } },
  );
}
