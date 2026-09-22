import { type Attributes, type Context, type Span } from "@opentelemetry/api";

import type {
  AgentTelemetryAbandonReason,
  AgentTelemetryCancellationReason,
  AgentTelemetryErrorCategory,
  ModelAttemptFailureStage,
  ModelAttemptSpanWriter,
  ModelAttemptTraceStart,
  ModelCallFailureStage,
  ModelCallSpanWriter,
  ModelFinishReason,
  ModelReasoningControlType,
  ModelReasoningState,
  ResponseModelTelemetryDescriptor,
} from "@zcode/contracts/telemetry";

import {
  compactAttributes,
  finiteNonNegative,
  integer,
  isAbortLike,
  safeEnum,
  safeString,
  type ActiveWriterContext,
  type WriterHealth,
  type WriterTerminalObservation,
} from "./agent-trace-support.js";

import { type AgentTelemetryMetricRecorder, type ModelTokenType } from "./agent-metrics.js";

import {
  httpResponseCompatibilityAttributes,
  modelResponseCompatibilityAttributes,
} from "./compatibility-adapters.js";

import { sanitizeErrorMessage } from "./error-sanitizer.js";

import { TrackedBaseWriter } from "./agent-trace-base-writer.js";

import { type TrackedWriter } from "./agent-trace-writer-types.js";

import { classifyErrorCategory, lifecycleKeys } from "./agent-trace-writer-labels.js";

export class ModelCallWriter extends TrackedBaseWriter implements ModelCallSpanWriter {
  private attemptCount = 0;
  private hadFailedAttempt = false;
  readonly logicalCallId: string | undefined;
  readonly modelRole: string | undefined;
  readonly operation: string | undefined;

  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    private readonly metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
    private readonly createAttempt: (
      writer: ModelCallWriter,
      input: ModelAttemptTraceStart,
    ) => ModelAttemptSpanWriter,
    logicalCallId: string | undefined,
    operation: string | undefined,
    modelRole: string | undefined,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("model_call"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
    this.logicalCallId = logicalCallId;
    this.operation = operation;
    this.modelRole = modelRole;
  }

  startAttempt(input: ModelAttemptTraceStart): ModelAttemptSpanWriter {
    this.attemptCount += 1;
    return this.createAttempt(this, input);
  }

  markFallbackSelected(reason: string): void {
    this.addEvent("fallback_selected", { reason: safeString(reason, 128) });
  }

  recordAttemptFailed(): void {
    this.hadFailedAttempt = true;
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  finishFailed(
    stage: ModelCallFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishAbandoned(reason: AgentTelemetryAbandonReason): void {
    this.finishAbandonedIfOpen(reason);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) {
      this.finishCancelledIfOpen("abort_signal");
    } else {
      const category = classifyErrorCategory(error);
      this.finishFailedIfOpen("unhandled", category, error);
    }
  }

  protected override recordTerminalDetailMetrics(
    outcome: string,
    observation: WriterTerminalObservation,
  ): void {
    const retryState =
      this.attemptCount <= 1
        ? "not_needed"
        : outcome === "completed" && this.hadFailedAttempt
          ? "recovered"
          : "not_recovered";
    this.metrics.recordModelCallAttempts(
      this.attemptCount,
      compactAttributes({
        ...this.metricLabels,
        error_category: observation.errorCategory,
        outcome,
        retry_state: retryState,
      }),
    );
  }
}

export class ModelAttemptWriter extends TrackedBaseWriter implements ModelAttemptSpanWriter {
  private firstContent = false;
  private firstContentMs: number | undefined;
  private firstProviderEvent = false;
  private firstProviderEventMs: number | undefined;
  private firstText = false;
  private firstTextMs: number | undefined;
  private stallCount = 0;
  private streamMaxIdleMs = 0;
  private readonly usage = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };

  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    private readonly metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    private readonly onAttemptFailed: () => void,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("model_attempt"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  setProviderRequestId(requestId: string): void {
    this.setAttribute("zcode.model_attempt.provider_request_id", safeString(requestId, 256));
  }

  setResponseModel(model: ResponseModelTelemetryDescriptor): void {
    const value = safeString(model.model, 128);
    this.setAttribute("zcode.model_attempt.response_model", value);
    this.setAttributes(modelResponseCompatibilityAttributes({ responseModel: value }));
  }

  setEffectiveReasoningState(state: ModelReasoningState): void {
    this.setAttribute("zcode.model_attempt.reasoning_effective_state", safeEnum(state));
  }

  setEffectiveReasoningControl(control: ModelReasoningControlType): void {
    this.setAttribute("zcode.model_attempt.reasoning_effective_control", safeEnum(control));
  }

  setEffectiveReasoningLevel(level: string): void {
    this.setAttribute("zcode.model_attempt.reasoning_effective_level", safeString(level, 128));
  }

  setEffectiveReasoningBudgetTokens(tokens: number): void {
    this.setAttribute(
      "zcode.model_attempt.reasoning_effective_budget_tokens",
      finiteNonNegative(tokens),
    );
  }

  setFinishReason(reason: ModelFinishReason): void {
    const value = safeString(reason, 128);
    this.setAttribute("zcode.model_attempt.finish_reason", value);
    this.setAttributes(modelResponseCompatibilityAttributes({ finishReason: value }));
  }

  setInputTokens(tokens: number): void {
    this.setUsage("inputTokens", "input", tokens, "zcode.model_attempt.input_tokens");
    this.setAttributes(modelResponseCompatibilityAttributes({ inputTokens: tokens }));
  }

  setOutputTokens(tokens: number): void {
    this.setUsage("outputTokens", "output", tokens, "zcode.model_attempt.output_tokens");
    this.setAttributes(modelResponseCompatibilityAttributes({ outputTokens: tokens }));
  }

  setReasoningTokens(tokens: number): void {
    this.setUsage("reasoningTokens", "reasoning", tokens, "zcode.model_attempt.reasoning_tokens");
  }

  setCacheReadTokens(tokens: number): void {
    this.setUsage("cacheReadTokens", "cache_read", tokens, "zcode.model_attempt.cache_read_tokens");
  }

  setCacheWriteTokens(tokens: number): void {
    this.setUsage(
      "cacheWriteTokens",
      "cache_write",
      tokens,
      "zcode.model_attempt.cache_write_tokens",
    );
  }

  setStreamOutputCommitted(committed: boolean): void {
    this.setAttribute("zcode.model_attempt.stream_output_committed", committed);
  }

  setHttpStatusCode(statusCode: number): void {
    const normalized = integer(statusCode);
    this.setAttribute("zcode.model_attempt.http_status_code", normalized);
    this.setAttributes(httpResponseCompatibilityAttributes(statusCode));
  }

  setProviderErrorCode(code: string): void {
    this.setAttribute("zcode.model_attempt.provider_error_code", safeString(code, 128));
  }

  setProviderErrorMessage(message: string): void {
    this.setAttribute("zcode.model_attempt.provider_error_message", sanitizeErrorMessage(message));
  }

  setRetryAfterMs(delayMs: number): void {
    this.setAttribute("zcode.model_attempt.retry_after_ms", finiteNonNegative(delayMs));
  }

  markFirstProviderEvent(): void {
    if (this.firstProviderEvent) return;
    this.firstProviderEvent = true;
    const elapsed = this.elapsedMs();
    this.firstProviderEventMs = elapsed;
    this.setAttribute("zcode.model_attempt.time_to_first_provider_event_ms", elapsed);
    this.addEvent("first_provider_event");
  }

  markFirstContent(): void {
    if (this.firstContent) return;
    this.firstContent = true;
    const elapsed = this.elapsedMs();
    this.firstContentMs = elapsed;
    this.setAttribute("zcode.model_attempt.time_to_first_content_ms", elapsed);
    this.addEvent("first_content");
  }

  markFirstText(): void {
    if (this.firstText) return;
    this.firstText = true;
    const elapsed = this.elapsedMs();
    this.firstTextMs = elapsed;
    this.setAttribute("zcode.model_attempt.time_to_first_text_ms", elapsed);
    this.addEvent("first_text");
  }

  markStreamStalled(idleMs: number): void {
    const normalized = finiteNonNegative(idleMs);
    if (normalized === undefined) return;
    this.stallCount += 1;
    this.streamMaxIdleMs = Math.max(this.streamMaxIdleMs, normalized);
    this.addEvent("stream_stalled", { idle_ms: normalized });
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  finishFailed(
    stage: ModelAttemptFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.onAttemptFailed();
    this.finishFailedIfOpen(stage, category, error);
  }

  finishAbandoned(reason: AgentTelemetryAbandonReason): void {
    this.finishAbandonedIfOpen(reason);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) {
      this.finishCancelledIfOpen("abort_signal");
    } else {
      const category = classifyErrorCategory(error);
      this.onAttemptFailed();
      this.finishFailedIfOpen("unhandled", category, error);
    }
  }

  private setUsage(
    field: keyof ModelAttemptWriter["usage"],
    tokenType: ModelTokenType,
    value: number,
    attribute: string,
  ): void {
    const normalized = finiteNonNegative(value);
    if (normalized === undefined) return;
    const delta = normalized - this.usage[field];
    if (delta < 0) return;
    this.usage[field] = normalized;
    this.safe(() => this.metrics.recordModelTokenDelta(tokenType, delta, this.metricLabels));
    this.setAttribute(attribute, normalized);
  }

  protected override recordTerminalDetailMetrics(
    outcome: string,
    observation: WriterTerminalObservation,
  ): void {
    this.metrics.recordModelAttemptDetail(
      compactAttributes({
        ...this.metricLabels,
        error_category: observation.errorCategory,
        outcome,
      }),
      {
        firstContentMs: this.firstContentMs,
        firstProviderEventMs: this.firstProviderEventMs,
        firstTextMs: this.firstTextMs,
        stallCount: this.stallCount,
        streamMaxIdleMs: this.streamMaxIdleMs,
      },
    );
  }
}
