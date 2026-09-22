import type { ModelStreamEvent } from "@zcode/contracts";
import { classifyModelFailure } from "./failure-classifier.js";
import {
  isSuspiciousStreamDiagnostics,
  isZeroOutputModelCompletion,
  logStreamDiagnostics,
} from "./runner-diagnostics.js";
import { canRetryEmptyCompletion, scheduleEmptyCompletionRetry } from "./empty-completion-retry.js";
import { detectProviderBusinessFinishError } from "./provider-finish-business-error.js";
import { TerminalStreamChunkError, toAdapterError } from "./runner-retry.js";
import { publishModelStatus } from "./runner-status.js";
import { providerRequestIdFromHeaders } from "./runner-telemetry.js";
import { applyStreamEventsToRetryBoundary } from "./runner-stream-chunk-events.js";
import { StreamAttemptConsume } from "./runner-stream-attempt-consume.js";
import { compactStreamFailureContext } from "./runner-stream-failure-decision.js";
import { resolveStreamResponseHeaders, statusPublishOptions } from "./runner-stream-support.js";
import type { StreamAttemptOutcome } from "./runner-stream-types.js";

export abstract class StreamAttemptSuccess extends StreamAttemptConsume {
  protected async *runAttemptBody(): AsyncGenerator<ModelStreamEvent, StreamAttemptOutcome> {
    await this.startProviderStream();
    const consumed = yield* this.consumeStream();
    if (consumed.kind === "retry") {
      return {
        holdRetryBudget: consumed.holdRetryBudget,
        kind: "retry",
      };
    }
    return yield* this.finishNaturalStream();
  }

  private async *finishNaturalStream(): AsyncGenerator<ModelStreamEvent, StreamAttemptOutcome> {
    if (!this.result) {
      throw new Error("Model stream result was not initialized");
    }
    const streamResult = this.result;
    const flushedEvents = applyStreamEventsToRetryBoundary({
      emittedRetryBoundaryEvent: this.emittedRetryBoundaryEvent,
      events: this.toolCallAssembler.flush(),
      pendingRetrySafeEvents: this.pendingRetrySafeEvents,
      preserveProviderStreamBoundaries: this.input.request.preserveProviderStreamBoundaries,
    });
    this.emittedEvent = this.emittedEvent || flushedEvents.emittedEvent;
    this.emittedRetryBoundaryEvent =
      this.emittedRetryBoundaryEvent || flushedEvents.emittedRetryBoundaryEvent;
    if (flushedEvents.visibleEvents.length > 0) {
      yield* this.emitVisibleEvents(flushedEvents.visibleEvents);
    }

    for (const pendingEvent of this.pendingRetrySafeEvents.splice(0)) {
      this.emittedEvent = true;
      yield* this.emitVisibleEvents([pendingEvent]);
    }

    if (!this.emittedError) {
      // 自然 EOF 后合成的业务错误会通过 TerminalStreamChunkError 直接离开外层 catch；
      // compact 上下文在普通主链路为空，因此必须在合成现场显式保留 stream 阶段。
      // 先识别 provider business error，再考虑 generic empty；否则额度等
      // HTTP 200 空流会被误判成可重试的暂时性空响应。
      const hiddenProviderBusinessError = detectProviderBusinessFinishError({
        providerId: String(this.statusContext.providerId),
        providerKind: this.statusContext.providerKind,
        source:
          this.diagnostics.lastFinishChunk ??
          ({
            type: "finish",
            finishReason: this.diagnostics.finishReason,
            rawFinishReason: this.diagnostics.rawFinishReason,
          } satisfies Record<string, unknown>),
      });
      if (hiddenProviderBusinessError) {
        const failure = classifyModelFailure(
          hiddenProviderBusinessError,
          this.input.request.abortSignal,
        );
        throw new TerminalStreamChunkError(
          toAdapterError(hiddenProviderBusinessError, failure, this.statusContext, this.attempt, {
            ...compactStreamFailureContext(
              this.input.request.preserveProviderStreamBoundaries,
              "response_body",
            ),
            errorPhase: "stream",
          }),
        );
      }

      if (isSuspiciousStreamDiagnostics(this.diagnostics)) {
        // 403 JSON 等业务错误有时不会让 AI SDK 抛出 error chunk，流会以空 completion 结束；
        // 若不在 adapter 层终止，core 会误报 “Model returned no text...”。
        const streamEndedWithoutOutputError = detectProviderBusinessFinishError({
          providerId: String(this.statusContext.providerId),
          providerKind: this.statusContext.providerKind,
          source: this.diagnostics.lastErrorChunk ?? this.diagnostics.lastFinishChunk,
        });
        if (streamEndedWithoutOutputError) {
          const failure = classifyModelFailure(
            streamEndedWithoutOutputError,
            this.input.request.abortSignal,
          );
          throw new TerminalStreamChunkError(
            toAdapterError(
              streamEndedWithoutOutputError,
              failure,
              this.statusContext,
              this.attempt,
              {
                ...compactStreamFailureContext(
                  this.input.request.preserveProviderStreamBoundaries,
                  "response_body",
                ),
                errorPhase: "stream",
              },
            ),
          );
        }

        if (
          this.input.request.preserveProviderStreamBoundaries !== true &&
          isZeroOutputModelCompletion({
            finishReason: this.diagnostics.finishReason,
            reasoningLength: this.diagnostics.reasoningDeltaChars,
            textLength: this.diagnostics.textDeltaChars,
            toolCallCount: this.diagnostics.toolCallCount,
            usage: this.diagnostics.usage,
          }) &&
          canRetryEmptyCompletion({
            abortSignal: this.input.request.abortSignal,
            attempt: this.attempt,
            maxAttempts: this.input.retry.maxAttempts,
            retryCount: this.state.emptyCompletionRetryCount,
          })
        ) {
          const responseHeaders = await resolveStreamResponseHeaders(streamResult);
          const completedAt = Date.now();
          // finish 会把 retry-safe 前奏刷成可见事件；空 completion 需在
          // flush 前进入一次 adapter retry，避免 core 把第一次 attempt 当成已完成。
          logStreamDiagnostics({
            attempt: this.attempt,
            diagnostics: this.diagnostics,
            durationMs: completedAt - this.startedAt,
            emittedError: this.emittedError,
            emittedEvent: this.emittedEvent,
            logger: this.input.logger,
            outboundHeaders: this.resolved.headers,
            statusContext: this.statusContext,
          });
          this.state.emptyCompletionRetryCount += 1;
          await scheduleEmptyCompletionRetry({
            abortSignal: this.input.request.abortSignal,
            attempt: this.attempt,
            completedAt,
            errorPhase: "stream",
            logger: this.input.logger,
            requestHeaders: this.requestHeaders,
            requestStatusSink: this.input.request.statusSink,
            responseHeaders,
            retry: this.input.retry,
            retryBudgetAttempt: this.retryBudgetAttempt,
            startedAt: this.startedAt,
            statusContext: this.statusContext,
            statusSink: this.input.statusSink,
            streamOutputCommitted: false,
          });
          return { kind: "retry" };
        }
      }
    }

    logStreamDiagnostics({
      attempt: this.attempt,
      diagnostics: this.diagnostics,
      durationMs: Date.now() - this.startedAt,
      emittedError: this.emittedError,
      emittedEvent: this.emittedEvent,
      logger: this.input.logger,
      outboundHeaders: this.resolved.headers,
      statusContext: this.statusContext,
    });
    if (!this.emittedError) {
      const completedAt = Date.now();
      const responseHeaders = await resolveStreamResponseHeaders(streamResult);
      await publishModelStatus(
        {
          ...this.statusContext,
          attempt: this.attempt,
          durationMs: completedAt - this.startedAt,
          requestHeaderCount: this.requestHeaderCount,
          requestHeaders: this.requestHeaders,
          responseHeaderCount: Object.keys(responseHeaders).length,
          responseHeaders,
          providerRequestId: providerRequestIdFromHeaders(responseHeaders),
          finishReason: this.diagnostics.finishReason,
          usage: this.diagnostics.usage,
          timeToFirstProviderEventMs: this.timeToFirstProviderEventMs,
          timeToFirstContentMs: this.timeToFirstContentMs,
          timeToFirstTextMs: this.timeToFirstTextMs,
          streamMaxIdleMs: this.streamMaxIdleMs || undefined,
          streamStallCount: this.streamStallCount,
          streamOutputCommitted: this.streamOutputCommitted,
          timestamp: new Date(completedAt).toISOString(),
          type: "model_request_completed",
        },
        statusPublishOptions(this.input, this.admission),
      );
      this.terminalStatusPublished = true;
    }
    await this.recordModelIODebug();
    return { kind: "completed" };
  }
}
