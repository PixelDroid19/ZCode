import type { ModelStreamEvent } from "@zcode/contracts";
import { publishModelStatus, publishModelTelemetryMilestone } from "./runner-status.js";
import { isZeroOutputModelCompletion } from "./runner-diagnostics.js";
import { canRetryEmptyCompletion } from "./empty-completion-retry.js";
import {
  compactDirectToolCallCommitEvent,
  handleStreamChunk,
} from "./runner-stream-chunk-events.js";
import { readNextWithStreamIdleTimeout } from "./stream-idle-timeout.js";
import { statusPublishOptions } from "./runner-stream-support.js";
import { StreamAttemptBase } from "./runner-stream-attempt-base.js";

export interface StreamConsumeOutcome {
  holdRetryBudget?: boolean;
  kind: "natural" | "retry";
}

export abstract class StreamAttemptConsume extends StreamAttemptBase {
  protected async *consumeStream(): AsyncGenerator<ModelStreamEvent, StreamConsumeOutcome> {
    if (!this.streamIterator) {
      throw new Error("Model stream iterator was not initialized");
    }

    while (true) {
      const next = await readNextWithStreamIdleTimeout(this.streamIterator, {
        abortController: this.attemptAbortController.controller,
        onTimeout: async (error) => {
          this.streamStallCount += 1;
          this.streamMaxIdleMs = Math.max(this.streamMaxIdleMs, error.idleMs);
          await publishModelStatus(
            {
              ...this.statusContext,
              attempt: this.attempt,
              idleMs: error.idleMs,
              message: error.message,
              requestHeaderCount: this.requestHeaderCount,
              requestHeaders: this.requestHeaders,
              timeoutMs: error.timeoutMs,
              timestamp: new Date().toISOString(),
              type: "model_stream_stalled",
            },
            statusPublishOptions(this.input, this.admission),
          );
        },
        timeoutMs: this.streamIdleTimeoutMs,
      });
      if (next.done) {
        this.streamReachedNaturalEnd = true;
        return { kind: "natural" };
      }
      if (this.timeToFirstProviderEventMs === undefined) {
        this.timeToFirstProviderEventMs = Date.now() - this.startedAt;
        await publishModelTelemetryMilestone(
          {
            ...this.statusContext,
            attempt: this.attempt,
            elapsedMs: this.timeToFirstProviderEventMs,
            timestamp: new Date(this.startedAt + this.timeToFirstProviderEventMs).toISOString(),
            type: "model_first_provider_event",
          },
          { logger: this.input.logger, statusSink: this.input.statusSink },
        );
      }

      let event: Awaited<ReturnType<typeof handleStreamChunk>>;
      try {
        event = await handleStreamChunk({
          admission: this.admission,
          attempt: this.attempt,
          chunk: next.value,
          diagnostics: this.diagnostics,
          emittedRetryBoundaryEvent: this.emittedRetryBoundaryEvent,
          input: this.input,
          pendingRetrySafeEvents: this.pendingRetrySafeEvents,
          requestHeaderCount: this.requestHeaderCount,
          requestHeaders: this.requestHeaders,
          repairThinkingSignatureRejection: this.repairThinkingSignatureRejection,
          retryBudgetAttempt: this.retryBudgetAttempt,
          startedAt: this.startedAt,
          statusContext: this.statusContext,
          toolCallAssembler: this.toolCallAssembler,
        });
      } catch (error) {
        const directToolCommit = compactDirectToolCallCommitEvent(this.input.request, next.value);
        if (directToolCommit) {
          // 完整 direct tool-call 已是 provider 事件；name/input 校验即使抛错，
          // 也不能让 adapter 当作首事件前失败再次 SSE 重放。
          this.emittedRetryBoundaryEvent = true;
          for (const pendingEvent of this.pendingRetrySafeEvents.splice(0)) {
            this.emittedEvent = true;
            yield pendingEvent;
          }
          // 无 raw message-block provenance 的 provider 可能直接给完整 tool-call。
          // 先把 inferred block stop 交给隐藏 collector，再传播校验错误，避免 HTTP 重放。
          this.emittedEvent = true;
          yield directToolCommit;
        }
        throw error;
      }
      const shouldHoldEmptyCompletionEvents =
        !event.emittedError &&
        event.visibleEvents.some((visibleEvent) => visibleEvent.type === "finish") &&
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
        });
      if (shouldHoldEmptyCompletionEvents) {
        // finish 会把已缓存的 start 一并刷给 core；先暂存到自然 EOF，确认这是
        // generic empty 后再重试，避免第一次 attempt 的 finish/start 泄漏到 UI。
        event.visibleEvents.length = 0;
      }
      this.emittedError = this.emittedError || event.emittedError;
      this.emittedEvent = this.emittedEvent || event.emittedEvent;
      this.emittedRetryBoundaryEvent =
        this.emittedRetryBoundaryEvent || event.emittedRetryBoundaryEvent;

      if (event.retryScheduled) {
        // SSE error chunk 的 retry 是正常控制流，不会进入 catch；
        // 若不显式标记失败，finally 会跳过旧 attempt 的 iterator/tee 清理。
        // 下一次物理请求必须等待本轮 abort 与有界清理后才能启动。
        this.attemptFailed = true;
        this.awaitIteratorClose = true;
        this.retryScheduledFromStreamChunk = true;
        this.offPeakQueueHoldFromStreamChunk = event.offPeakQueueHold;
        return {
          holdRetryBudget: event.offPeakQueueHold,
          kind: "retry",
        };
      }
      if (event.terminalError) {
        throw event.terminalError;
      }
      if (event.visibleEvents.length > 0) {
        yield* this.emitVisibleEvents(event.visibleEvents);
      }
    }
  }
}
