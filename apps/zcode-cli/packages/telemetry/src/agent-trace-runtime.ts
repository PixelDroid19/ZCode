import { context, ROOT_CONTEXT, SpanKind, trace, type Span, type Tracer } from "@opentelemetry/api";

import type {
  AgentExecutionTelemetryPort,
  AgentStepSpanWriter,
  AgentStepTraceStart,
  AgentTelemetryExecutionContext,
  AgentTurnSpanWriter,
  AgentTurnTraceStart,
  CommandExecutionSpanWriter,
  CommandTraceStart,
  CompactionTraceStart,
  ContextCompactionSpanWriter,
  DetachedOperationSpanWriter,
  DetachedOperationTraceStart,
  ModelCallSpanWriter,
  ModelCallTraceStart,
  ModelExecutionTelemetryPort,
  TelemetryIdentitySnapshot,
  ToolExecutionSpanWriter,
  ToolTraceStart,
} from "@zcode/contracts/telemetry";

import {
  activeWriterContext,
  compactAttributes,
  contextFromCausation,
  executionProjection,
  integer,
  safeEnum,
  safeId,
  safeString,
  type WriterHealth,
} from "./agent-trace-support.js";

import {
  NOOP_AGENT_TELEMETRY_METRICS,
  type AgentMetricSpanName,
  type AgentTelemetryMetricRecorder,
} from "./agent-metrics.js";

import { toolCompatibilityAttributes } from "./compatibility-adapters.js";

import { type StartWriterOptions, type TrackedWriter } from "./agent-trace-writer-types.js";

import {
  causationLink,
  inheritedMetadata,
  positiveLimit,
  stepMetricLabels,
  toolMetricLabels,
  turnMetricLabels,
} from "./agent-trace-writer-labels.js";

import { ModelSpanFactory } from "./agent-trace-model-factory.js";

import { StepWriter, TurnWriter } from "./agent-trace-turn-writers.js";

import { NOOP_STEP_WRITER, NOOP_TOOL_WRITER, NOOP_TURN_WRITER } from "./agent-trace-noop.js";

import { ToolWriter } from "./agent-trace-tool-writers.js";

import { OperationSpanFactory } from "./agent-trace-operation-factory.js";
import { type TraceWriterHost } from "./agent-trace-writer-types.js";

export interface AgentTraceRuntimeOptions extends WriterHealth {
  identity?: TelemetryIdentitySnapshot;
  maxActiveWriters?: number;
  metrics?: AgentTelemetryMetricRecorder;
  tracer: Tracer;
}

export class AgentExecutionTelemetryRuntime
  implements AgentExecutionTelemetryPort, ModelExecutionTelemetryPort
{
  private readonly activeWriters = new Set<TrackedWriter>();
  private capacityWarningActive = false;
  private identity: TelemetryIdentitySnapshot;
  private readonly maxActiveWriters: number;
  private readonly tracer: Tracer;
  private readonly health: WriterHealth;
  private readonly metrics: AgentTelemetryMetricRecorder;

  constructor(options: AgentTraceRuntimeOptions) {
    this.tracer = options.tracer;
    this.maxActiveWriters = positiveLimit(options.maxActiveWriters, 5_000);
    this.health = { onWarning: options.onWarning };
    this.metrics = options.metrics ?? NOOP_AGENT_TELEMETRY_METRICS;
    this.identity = options.identity ?? { identityState: "unknown" };
    const writerHost: TraceWriterHost = {
      health: this.health,
      metrics: this.metrics,
      safeCreate: (name, create, fallback) => this.safeCreate(name, create, fallback),
      startSpan: (options) => this.startSpan(options),
      track: (writer) => this.track(writer),
      untrack: (writer) => {
        this.activeWriters.delete(writer);
      },
    };
    this.modelSpans = new ModelSpanFactory(writerHost);
    this.operationSpans = new OperationSpanFactory(writerHost);
  }

  updateIdentity(snapshot: TelemetryIdentitySnapshot): void {
    this.identity = {
      identityState: snapshot.identityState,
      ...(safeId(snapshot.userSubjectId) ? { userSubjectId: safeId(snapshot.userSubjectId) } : {}),
    };
  }

  captureCausation() {
    const active = activeWriterContext();
    if (!active) return undefined;
    const spanContext = active.span.spanContext();
    if (!trace.isSpanContextValid(spanContext)) return undefined;
    return {
      isRemote: spanContext.isRemote ?? false,
      spanId: spanContext.spanId,
      traceFlags: spanContext.traceFlags,
      traceId: spanContext.traceId,
      ...(spanContext.traceState ? { traceState: spanContext.traceState.serialize() } : {}),
      sessionId: active.correlation?.sessionId,
      turnId: active.correlation?.turnId,
      toolCallId: active.toolCallId,
    };
  }

  startTurn(input: AgentTurnTraceStart): AgentTurnSpanWriter {
    const correlation: AgentTelemetryExecutionContext = {
      ...input.context,
      identityState: this.identity.identityState,
      ...(this.identity.userSubjectId ? { userSubjectId: this.identity.userSubjectId } : {}),
    };
    const linkedRoot = input.causationMode !== "child";
    const links =
      input.causation && linkedRoot ? [causationLink(input.causation, "spawned_by")] : undefined;
    return this.safeCreate(
      "agent_turn",
      () => {
        const parentContext =
          input.causation && !linkedRoot ? contextFromCausation(input.causation) : ROOT_CONTEXT;
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(correlation, {
              includeActor: true,
              includeAgent: true,
              includeIdentity: true,
              includeQuery: true,
              includeSession: true,
            }),
            "zcode.agent_turn.turn_number": integer(input.turnNumber),
            "zcode.agent_turn.input_source": safeEnum(input.inputSource),
          }),
          context: parentContext,
          correlation,
          links,
          spanName: "agent_turn",
        });
        return this.track(
          new TurnWriter(
            span,
            parentContext,
            {
              correlation,
              spanName: "agent_turn",
            },
            this.health,
            this.metrics,
            turnMetricLabels(correlation, input.inputSource),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_TURN_WRITER,
    );
  }

  startStep(input: AgentStepTraceStart): AgentStepSpanWriter {
    const parent = activeWriterContext();
    return this.safeCreate(
      "agent_step",
      () => {
        const parentContext = parent?.activeContext ?? context.active();
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent?.correlation),
            "zcode.agent_step.step_id": safeId(input.stepId),
            "zcode.agent_step.step_index": integer(input.stepIndex),
          }),
          context: parentContext,
          correlation: parent?.correlation,
          parent,
          spanName: "agent_step",
          toolCallId: parent?.toolCallId,
        });
        return this.track(
          new StepWriter(
            span,
            parentContext,
            inheritedMetadata(parent, "agent_step"),
            this.health,
            this.metrics,
            stepMetricLabels(parent?.correlation),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_STEP_WRITER,
    );
  }

  startTool(input: ToolTraceStart): ToolExecutionSpanWriter {
    const parent = activeWriterContext();
    return this.safeCreate(
      "tool_execution",
      () => {
        const parentContext = parent?.activeContext ?? context.active();
        const toolName = safeString(input.registeredToolName, 128);
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent?.correlation, { includeActor: true }),
            "zcode.execution.tool_call_id": safeId(input.toolCallId),
            "zcode.tool_execution.tool_name": toolName,
            ...toolCompatibilityAttributes({
              toolCallId: input.toolCallId,
              toolName: input.registeredToolName,
            }),
          }),
          context: parentContext,
          correlation: parent?.correlation,
          parent,
          spanName: "tool_execution",
          toolCallId: safeId(input.toolCallId),
        });
        return this.track(
          new ToolWriter(
            span,
            parentContext,
            {
              ...inheritedMetadata(parent, "tool_execution"),
              toolCallId: safeId(input.toolCallId),
            },
            this.health,
            this.metrics,
            toolMetricLabels(input.registeredToolName),
            (writer) => this.activeWriters.delete(writer),
            (command) => this.startCommand(command),
          ),
        );
      },
      NOOP_TOOL_WRITER,
    );
  }

  startCompaction(input: CompactionTraceStart): ContextCompactionSpanWriter {
    return this.operationSpans.startCompaction(input);
  }

  startDetachedOperation(input: DetachedOperationTraceStart): DetachedOperationSpanWriter {
    return this.operationSpans.startDetachedOperation(input);
  }

  startCall(input: ModelCallTraceStart): ModelCallSpanWriter {
    return this.modelSpans.startCall(input);
  }

  abandonSession(sessionId: string): void {
    for (const writer of this.activeWriters) {
      if (writer.state.correlation?.sessionId === sessionId) {
        writer.abandon("session_shutdown");
      }
    }
  }

  abandonProcess(): void {
    for (const writer of this.activeWriters) writer.abandon("process_shutdown");
  }

  private startCommand(
    input: CommandTraceStart & { parent: ToolWriter },
  ): CommandExecutionSpanWriter {
    return this.operationSpans.startCommand(input);
  }

  private startSpan(options: StartWriterOptions): Span {
    return this.tracer.startSpan(
      options.spanName,
      {
        attributes: options.attributes,
        kind: options.kind ?? SpanKind.INTERNAL,
        links: options.links,
      },
      options.context ?? context.active(),
    );
  }

  private track<T extends TrackedWriter>(writer: T): T {
    this.activeWriters.add(writer);
    return writer;
  }

  private safeCreate<T>(spanName: string, create: () => T, fallback: T): T {
    if (this.activeWriters.size >= this.maxActiveWriters) {
      this.safeMetric(() =>
        this.metrics.recordCreationDrop(spanName as AgentMetricSpanName, "process_capacity"),
      );
      if (!this.capacityWarningActive) {
        this.capacityWarningActive = true;
        try {
          this.health.onWarning?.("Telemetry active writer capacity was reached", {
            activeWriterCount: this.activeWriters.size,
            maxActiveWriters: this.maxActiveWriters,
            spanName,
          });
        } catch {
          // 健康回调同样属于旁路。
        }
      }
      return fallback;
    }
    this.capacityWarningActive = false;
    try {
      return create();
    } catch (error) {
      this.safeMetric(() =>
        this.metrics.recordCreationDrop(spanName as AgentMetricSpanName, "unknown"),
      );
      try {
        this.health.onWarning?.("Telemetry writer creation failed", {
          errorType: error instanceof Error ? error.name : typeof error,
          spanName,
        });
      } catch {
        // 健康回调同样属于旁路。
      }
      return fallback;
    }
  }

  private safeMetric(record: () => void): void {
    try {
      record();
    } catch (error) {
      try {
        this.health.onWarning?.("Telemetry metric operation failed", {
          errorType: error instanceof Error ? error.name : typeof error,
        });
      } catch {
        // Metric 与健康回调都属于旁路。
      }
    }
  }

  private readonly modelSpans: ModelSpanFactory;
  private readonly operationSpans: OperationSpanFactory;
}

export { NoopAgentExecutionTelemetry } from "./agent-trace-noop.js";
