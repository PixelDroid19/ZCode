import type { TextStreamPart, ToolSet } from "ai";
import type { ModelStreamEvent } from "@zcode/contracts";
import { resolveAnthropicRequestMetadataUserId } from "./anthropic-request-metadata.js";
import { classifyModelFailure } from "./failure-classifier.js";
import { unwrapRetryError } from "./failure-inspection.js";
import {
  admissionWaitPublishers,
  createAttemptStatusContext,
  publishModelStatus,
  publishModelTelemetryMilestone,
} from "./runner-status.js";
import { createStreamDiagnostics } from "./runner-diagnostics.js";
import { createStreamTextOptions } from "./runner-options.js";
import { recordStreamTextDebug } from "./runner-debug.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import { admitAttempt, type AttemptAdmission } from "./request-admission.js";
import { repairReasoningHistoryAfterSignatureRejection } from "./reasoning-history-normalization.js";
import { toAdapterError } from "./runner-retry.js";
import {
  resolveModelStreamIdleTimeoutMs,
  createLinkedAbortController,
} from "./stream-idle-timeout.js";
import { StreamingToolCallAssembler } from "./streaming-tool-call-assembler.js";
import type { AiSdkStreamTextResult, ResolvedAiSdkModel } from "./runner-runtime.js";
import { resolveModelForAttempt } from "./runner-runtime-headers.js";
import { modelFailureStatusFields } from "./runner-telemetry.js";
import { observeVisibleStreamEvent, statusPublishOptions } from "./runner-stream-support.js";
import type { RunStreamTextInput, StreamRunState } from "./runner-stream-types.js";

export abstract class StreamAttemptBase {
  protected readonly attemptAbortController: ReturnType<typeof createLinkedAbortController>;
  protected readonly attemptRequest;
  protected readonly diagnostics: ReturnType<typeof createStreamDiagnostics> =
    createStreamDiagnostics();
  protected readonly pendingRetrySafeEvents: ModelStreamEvent[] = [];
  protected readonly retryBudgetAttempt: number;
  protected readonly startedAt = Date.now();
  protected readonly streamIdleTimeoutMs: number;
  protected readonly toolCallAssembler: StreamingToolCallAssembler;
  protected admission!: AttemptAdmission;
  protected attemptFailed = false;
  protected awaitIteratorClose = false;
  protected emittedError = false;
  protected emittedEvent = false;
  protected emittedRetryBoundaryEvent = false;
  protected offPeakQueueHoldFromStreamChunk = false;
  protected options: ReturnType<typeof createStreamTextOptions> | undefined;
  protected requestHeaderCount = 0;
  protected requestHeaders: Record<string, string> = {};
  protected resolved: ResolvedAiSdkModel;
  protected result: AiSdkStreamTextResult | undefined;
  protected retryScheduledFromStreamChunk = false;
  protected statusContext;
  protected streamIterator: AsyncIterator<TextStreamPart<ToolSet>> | undefined;
  protected streamMaxIdleMs = 0;
  protected streamOutputCommitted = false;
  protected streamReachedNaturalEnd = false;
  protected streamStallCount = 0;
  protected terminalStatusPublished = false;
  protected timeToFirstContentMs: number | undefined;
  protected timeToFirstProviderEventMs: number | undefined;
  protected timeToFirstTextMs: number | undefined;

  constructor(
    protected readonly input: RunStreamTextInput,
    protected readonly state: StreamRunState,
    protected readonly attempt: number,
    protected readonly statusMaxAttempts: (extraAttempts: number) => number,
  ) {
    this.retryBudgetAttempt = attempt - Number(state.signatureRepairAttempted);
    this.streamIdleTimeoutMs = resolveModelStreamIdleTimeoutMs({
      baseTimeoutMs: input.streamIdleTimeoutMs,
      retryNumber: (input.request.streamIdleTimeoutRetryNumber ?? 0) + this.retryBudgetAttempt - 1,
    });
    this.attemptAbortController = createLinkedAbortController(input.request.abortSignal);
    this.attemptRequest = {
      ...input.request,
      abortSignal: this.attemptAbortController.signal,
      messages: state.requestMessages,
    };
    this.statusContext = createAttemptStatusContext(
      {
        ...state.baseStatusContext,
        maxAttempts: statusMaxAttempts(Number(state.signatureRepairAttempted)),
      },
      attempt,
    );
    this.toolCallAssembler = new StreamingToolCallAssembler({ logger: input.logger });
    this.resolved = input.resolved;
  }

  protected async admit(): Promise<void> {
    try {
      this.admission = await admitAttempt({
        admission: this.input.request.modelRequestAdmission,
        model: {
          providerId: String(this.resolved.providerId),
          modelId: String(this.resolved.modelId),
        },
        signal: this.input.request.abortSignal,
        ...admissionWaitPublishers(
          this.statusContext,
          this.attempt,
          statusPublishOptions(this.input),
        ),
      });
    } catch (admitError) {
      this.attemptAbortController.cleanup();
      const admitFailure = classifyModelFailure(admitError, this.input.request.abortSignal);
      await publishModelStatus(
        {
          ...this.statusContext,
          attempt: this.attempt,
          durationMs: Date.now() - this.startedAt,
          message: admitFailure.message,
          reason: admitFailure.reason,
          requestHeaderCount: this.requestHeaderCount,
          requestHeaders: this.requestHeaders,
          retryable: false,
          statusCode: admitFailure.statusCode,
          streamOutputCommitted: this.streamOutputCommitted,
          ...modelFailureStatusFields(admitError, admitFailure, "connect"),
          timestamp: new Date().toISOString(),
          type: "model_request_failed",
        },
        {
          ...statusPublishOptions(this.input),
          failureError: unwrapRetryError(admitError),
        },
      );
      throw toAdapterError(admitError, admitFailure, this.statusContext, this.attempt, {
        errorPhase: "connect",
      });
    }
  }

  protected async startProviderStream(): Promise<void> {
    this.resolved = await resolveModelForAttempt({
      attempt: this.attempt,
      request: this.attemptRequest,
      resolveModel: this.input.resolveModel,
    });
    const anthropicMetadataUserId = await resolveAnthropicRequestMetadataUserId({
      env: this.input.env,
      providerKind: this.resolved.providerKind,
      sessionId: this.statusContext.sessionId,
    });
    this.options = createStreamTextOptions({
      anthropicMetadataUserId,
      env: this.input.env,
      includeModelIO: this.state.recordModelIO,
      request: this.attemptRequest,
      resolved: this.resolved,
      statusContext: this.statusContext,
    });
    this.requestHeaders = sanitizeModelNetworkHeaders(this.options.headers);
    this.requestHeaderCount = Object.keys(this.requestHeaders).length;
    await publishModelStatus(
      {
        ...this.statusContext,
        attempt: this.attempt,
        requestHeaderCount: this.requestHeaderCount,
        requestHeaders: this.requestHeaders,
        timestamp: new Date(this.startedAt).toISOString(),
        type: "model_request_started",
      },
      statusPublishOptions(this.input, this.admission),
    );
    this.result = this.input.runtime.streamText(this.options);
    this.streamIterator = this.result.fullStream[Symbol.asyncIterator]();
  }

  protected repairThinkingSignatureRejection = (error: unknown): boolean => {
    if (this.state.signatureRepairAttempted || this.resolved.providerKind !== "anthropic") {
      return false;
    }
    const repairedMessages = repairReasoningHistoryAfterSignatureRejection(
      this.state.requestMessages,
      error,
    );
    if (!repairedMessages) return false;

    // 签名只对生成它的 thinking block 有效。流尚未提交输出时，只替换
    // 本次请求副本，并给一次不占普通 retry 预算且拥有新 requestId 的物理请求机会；
    // 不能把清理结果写回 canonical history。
    this.state.signatureRepairAttempted = true;
    this.state.requestMessages = repairedMessages;
    this.input.logger?.warn("Retrying model stream after thinking signature rejection", {
      attempt: this.attempt,
      event: "model.reasoning_signature_repair.retry",
      maxAttempts: this.input.retry.maxAttempts + 1,
      nextAttempt: this.attempt + 1,
      requestId: this.statusContext.requestId,
      status: "waiting",
    });
    return true;
  };

  protected async publishVisibleMilestones(observation: {
    contentMs?: number;
    textMs?: number;
  }): Promise<void> {
    if (this.timeToFirstContentMs === undefined && observation.contentMs !== undefined) {
      this.timeToFirstContentMs = observation.contentMs;
      await publishModelTelemetryMilestone(
        {
          ...this.statusContext,
          attempt: this.attempt,
          elapsedMs: observation.contentMs,
          timestamp: new Date(this.startedAt + observation.contentMs).toISOString(),
          type: "model_first_content",
        },
        { logger: this.input.logger, statusSink: this.input.statusSink },
      );
    }
    if (this.timeToFirstTextMs === undefined && observation.textMs !== undefined) {
      this.timeToFirstTextMs = observation.textMs;
      await publishModelTelemetryMilestone(
        {
          ...this.statusContext,
          attempt: this.attempt,
          elapsedMs: observation.textMs,
          timestamp: new Date(this.startedAt + observation.textMs).toISOString(),
          type: "model_first_text",
        },
        { logger: this.input.logger, statusSink: this.input.statusSink },
      );
    }
  }

  protected async *emitVisibleEvents(
    events: readonly ModelStreamEvent[],
  ): AsyncGenerator<ModelStreamEvent> {
    for (const event of events) {
      const observation = observeVisibleStreamEvent(event, Date.now() - this.startedAt);
      await this.publishVisibleMilestones(observation);
      this.streamOutputCommitted = this.streamOutputCommitted || observation.outputCommitted;
      yield event;
    }
  }

  protected async recordModelIODebug(error?: unknown): Promise<void> {
    if (!this.state.recordModelIO || !this.options) return;
    await recordStreamTextDebug({
      modelIoFullRetentionEnabled: this.input.modelIoFullRetentionEnabled,
      attempt: this.attempt,
      debugDir: this.input.debugDir,
      ...(error === undefined ? {} : { error }),
      isDev: this.state.isDev,
      normalizedToolCalls: this.toolCallAssembler.snapshotNormalizedToolCalls(),
      options: this.options,
      recordModelIO: this.state.recordModelIO,
      request: this.attemptRequest,
      requestId: this.statusContext.requestId,
      resolved: this.resolved,
      result: this.result,
      startedAt: this.startedAt,
    });
  }
}
