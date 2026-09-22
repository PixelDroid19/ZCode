import {
  ModelErrorCode,
  ModelFailureReason as ModelFailureReasonValue,
  ModelProtocolError,
  ModelRetryReason,
} from "@zcode/contracts";
import { classifyModelFailure, type ClassifiedModelFailure } from "./failure-classifier.js";
import { getResponseHeaders, unwrapRetryError } from "./failure-inspection.js";
import { offPeakTicketExpiredMessage, resolveOffPeakFailureDecision } from "./offpeak-retry.js";
import { logStreamFailureDiagnostics } from "./runner-diagnostics.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import {
  calculateRetryDelay,
  logRetryDelayDecision,
  sleep,
  TerminalStreamChunkError,
  toAdapterError,
} from "./runner-retry.js";
import { publishModelStatus } from "./runner-status.js";
import { RuntimeHeadersRefreshError } from "./runner-runtime-headers.js";
import { modelFailureStatusFields, readModelFailureErrorPhase } from "./runner-telemetry.js";
import { closeStreamIteratorBestEffort } from "./runner-stream-cleanup.js";
import { resolveStreamFailureDecision } from "./runner-stream-failure-decision.js";
import { StreamAttemptSuccess } from "./runner-stream-attempt-success.js";
import { publishRetryScheduledStatus, statusPublishOptions } from "./runner-stream-support.js";
import type { StreamAttemptOutcome } from "./runner-stream-types.js";

export abstract class StreamAttemptFailure extends StreamAttemptSuccess {
  protected async handleAttemptFailure(error: unknown): Promise<StreamAttemptOutcome> {
    this.attemptFailed = true;
    await this.recordModelIODebug(error);
    if (error instanceof TerminalStreamChunkError) {
      this.awaitIteratorClose = true;
      throw error.adapterError;
    }
    if (
      error instanceof ModelProtocolError &&
      error.code === ModelErrorCode.ModelRequestAuthMissing
    ) {
      // stream 在 attempt try 内解析请求鉴权，过去会把网络前的类型化
      // 鉴权缺失错误重新归一化为通用请求失败；generate 则直接保留原始协议错误。
      throw error;
    }

    const completedAt = Date.now();
    const retryWithRepairedHistory =
      !this.emittedRetryBoundaryEvent && this.repairThinkingSignatureRejection(error);
    if (retryWithRepairedHistory) {
      this.statusContext = {
        ...this.statusContext,
        maxAttempts: this.statusMaxAttempts(1),
      };
    }
    const classified = classifyModelFailure(error, this.input.request.abortSignal);
    if (error instanceof RuntimeHeadersRefreshError) {
      classified.message = error.message;
      classified.retryable = false;
    }
    // off-peak 特判（仅 idle plan provider）：排队 429 豁免预算无限探测；3102 标记落败触发续跑。
    const offPeak = resolveOffPeakFailureDecision({
      offPeak: this.resolved.accountAccess?.mode === "off-peak",
      failure: classified,
      error: unwrapRetryError(error),
    });
    const failure: ClassifiedModelFailure =
      offPeak?.kind === "ticketExpired"
        ? {
            ...classified,
            retryable: false,
            message: offPeakTicketExpiredMessage(classified.message),
          }
        : offPeak?.kind === "queued"
          ? {
              ...classified,
              retryable: true,
              retryReason: ModelRetryReason.OffpeakQueued,
            }
          : classified;
    const errorPhase =
      readModelFailureErrorPhase(error) ??
      (this.streamIterator === undefined ? "prepare" : "stream");
    this.awaitIteratorClose = failure.reason !== ModelFailureReasonValue.Cancelled;
    const responseHeaders = sanitizeModelNetworkHeaders(
      getResponseHeaders(unwrapRetryError(error)),
    );
    const failureDecision = resolveStreamFailureDecision({
      attempt: this.retryBudgetAttempt,
      emittedRetryBoundaryEvent: this.emittedRetryBoundaryEvent,
      error,
      failure,
      maxAttempts: this.input.retry.maxAttempts,
      preserveProviderStreamBoundaries: this.input.request.preserveProviderStreamBoundaries,
      responseHeaders,
      retryBudget: this.state.retryBudget,
      streamIteratorCreated: this.streamIterator !== undefined,
      streamErrorChunkObserved: Boolean(
        this.diagnostics.lastErrorChunk || this.diagnostics.lastFinishChunk,
      ),
    });
    // off-peak 排队 429 豁免预算：不消耗 maxAttempts，SSE 可见输出边界仍适用。
    if (offPeak?.kind === "queued" && !this.emittedRetryBoundaryEvent) {
      failureDecision.canRetry = true;
    }
    if (retryWithRepairedHistory) {
      failureDecision.canRetry = true;
    }

    logStreamFailureDiagnostics({
      attempt: this.attempt,
      canRetry: failureDecision.canRetry,
      diagnostics: this.diagnostics,
      durationMs: completedAt - this.startedAt,
      emittedError: this.emittedError,
      emittedEvent: this.emittedEvent,
      emittedRetryBoundaryEvent: this.emittedRetryBoundaryEvent,
      error,
      failure,
      logger: this.input.logger,
      statusContext: this.statusContext,
    });
    await publishModelStatus(
      {
        ...this.statusContext,
        attempt: this.attempt,
        durationMs: completedAt - this.startedAt,
        message: failure.message,
        reason: failure.reason,
        requestHeaderCount: this.requestHeaderCount,
        requestHeaders: this.requestHeaders,
        responseHeaderCount: Object.keys(responseHeaders).length,
        responseHeaders,
        retryable: failureDecision.canRetry,
        statusCode: failure.statusCode,
        streamOutputCommitted: this.streamOutputCommitted,
        ...modelFailureStatusFields(error, failure, errorPhase),
        timestamp: new Date(completedAt).toISOString(),
        type: "model_request_failed",
      },
      {
        ...statusPublishOptions(this.input, this.admission),
        failureError: unwrapRetryError(error),
      },
    );
    this.terminalStatusPublished = true;

    if (retryWithRepairedHistory) {
      await publishRetryScheduledStatus(
        this.input,
        this.statusContext,
        this.attempt,
        0,
        {
          ...failure,
          retryReason: ModelRetryReason.ReasoningSignatureRepair,
        },
        this.requestHeaders,
        responseHeaders,
        this.admission,
      );
      return { kind: "retry" };
    }

    if (!failureDecision.canRetry) {
      logRetryDelayDecision({
        attempt: this.attempt,
        canRetry: failureDecision.canRetry,
        failure,
        logger: this.input.logger,
        responseHeaders,
        statusContext: this.statusContext,
      });
      throw toAdapterError(error, failure, this.statusContext, this.attempt, {
        ...failureDecision.context,
        errorPhase,
      });
    }

    const delayMs =
      offPeak?.kind === "queued"
        ? offPeak.delayMs
        : calculateRetryDelay(this.input.retry, this.retryBudgetAttempt, failure.retryAfterMs);
    logRetryDelayDecision({
      attempt: this.attempt,
      canRetry: failureDecision.canRetry,
      delayMs,
      failure,
      logger: this.input.logger,
      responseHeaders,
      statusContext: this.statusContext,
    });

    await publishRetryScheduledStatus(
      this.input,
      this.statusContext,
      this.attempt,
      delayMs,
      failure,
      this.requestHeaders,
      responseHeaders,
      this.admission,
    );
    // 退避期间不持票：槽位让给别人，重试再准入。
    this.admission.release();
    try {
      await sleep(delayMs, this.input.request.abortSignal);
    } catch (sleepError) {
      const sleepFailure = classifyModelFailure(sleepError, this.input.request.abortSignal);
      await publishModelStatus(
        {
          ...this.statusContext,
          attempt: this.attempt,
          durationMs: Date.now() - this.startedAt,
          message: sleepFailure.message,
          reason: sleepFailure.reason,
          requestHeaderCount: this.requestHeaderCount,
          requestHeaders: this.requestHeaders,
          retryable: false,
          statusCode: sleepFailure.statusCode,
          streamOutputCommitted: this.streamOutputCommitted,
          ...modelFailureStatusFields(sleepError, sleepFailure, "connect"),
          timestamp: new Date().toISOString(),
          type: "model_request_failed",
        },
        {
          // 退避期间票据已归还：这次取消不属于任何一次尝试，不转投票据。
          ...statusPublishOptions(this.input),
          failureError: unwrapRetryError(sleepError),
        },
      );
      this.terminalStatusPublished = true;
      throw toAdapterError(sleepError, sleepFailure, this.statusContext, this.attempt, {
        errorPhase: "connect",
      });
    }
    return {
      holdRetryBudget: offPeak?.kind === "queued",
      kind: "retry",
    };
  }

  protected async cleanupAttempt(): Promise<void> {
    if (
      !this.streamReachedNaturalEnd &&
      (this.attemptFailed || this.input.request.preserveProviderStreamBoundaries === true)
    ) {
      // 普通 stream 的 429 retry 失败若不进入本清理分支，
      // AI SDK fullStream tee 会持有旧 provider 请求，连续重试会让后续物理请求卡在发送前。
      // 失败 attempt 必须无条件中止并释放；普通 consumer 主动提前结束仍保持原语义。
      if (!this.attemptAbortController.signal.aborted) {
        this.attemptAbortController.controller.abort(
          new Error("Model stream attempt ended before natural EOF."),
        );
      }
      if (!this.attemptFailed && !this.terminalStatusPublished && !this.emittedError) {
        // consumer 侧的校验异常只会触发 AsyncIteratorClose，不会回到上面的 catch；
        // 将已启动的物理请求收口为 cancelled，避免 fallback 前遗留悬空 started 状态。
        const completedAt = Date.now();
        await publishModelStatus(
          {
            ...this.statusContext,
            attempt: this.attempt,
            durationMs: completedAt - this.startedAt,
            message: "Model stream consumer closed before natural EOF.",
            reason: ModelFailureReasonValue.Cancelled,
            requestHeaderCount: this.requestHeaderCount,
            requestHeaders: this.requestHeaders,
            retryable: false,
            errorCode: "model_request_cancelled",
            errorPhase: "stream",
            exceptionType: "AbortError",
            streamOutputCommitted: this.streamOutputCommitted,
            timestamp: new Date(completedAt).toISOString(),
            type: "model_request_failed",
          },
          statusPublishOptions(this.input, this.admission),
        );
      }
      if (this.attemptFailed && this.awaitIteratorClose) {
        await closeStreamIteratorBestEffort(this.streamIterator, {
          attempt: this.attempt,
          logger: this.input.logger,
          result: this.result,
        });
      } else {
        void closeStreamIteratorBestEffort(this.streamIterator, {
          attempt: this.attempt,
          logger: this.input.logger,
        });
      }
    } else if (this.attemptAbortController.signal.aborted) {
      // 普通 main 保留既有生命周期：只有 caller/idle 已经 abort 时才 best-effort 关闭 iterator。
      void closeStreamIteratorBestEffort(this.streamIterator, {
        attempt: this.attempt,
        logger: this.input.logger,
      });
    }
    this.attemptAbortController.cleanup();
    // 兜底归还（成功 / 抛出 / 消费者提前 return 都到这里）；正常失败路径已在 sleep 前归还，幂等。
    this.admission.release();
  }
}
