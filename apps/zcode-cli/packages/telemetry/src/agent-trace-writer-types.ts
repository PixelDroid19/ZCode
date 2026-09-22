import { SpanKind, type Attributes, type Context, type Link, type Span } from "@opentelemetry/api";

import type {
  AgentTelemetryAbandonReason,
  AgentTelemetryExecutionContext,
} from "@zcode/contracts/telemetry";

import {
  BaseSpanWriter,
  type ActiveWriterContext,
  type WriterHealth,
} from "./agent-trace-support.js";

import { type AgentTelemetryMetricRecorder } from "./agent-metrics.js";

export interface StartWriterOptions {
  attributes?: Attributes;
  context?: Context;
  correlation?: AgentTelemetryExecutionContext;
  kind?: SpanKind;
  links?: Link[];
  parent?: ActiveWriterContext;
  spanName: string;
  toolCallId?: string;
}

export type TrackedWriter = BaseSpanWriter & {
  abandon(reason: AgentTelemetryAbandonReason): void;
  readonly state: ActiveWriterContext;
};

export interface TraceWriterHost {
  readonly health: WriterHealth;
  readonly metrics: AgentTelemetryMetricRecorder;
  safeCreate<T>(spanName: string, create: () => T, fallback: T): T;
  startSpan(options: StartWriterOptions): Span;
  track<T extends TrackedWriter>(writer: T): T;
  untrack(writer: TrackedWriter): void;
}
