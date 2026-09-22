import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { ResolvedModelTelemetryDescriptor } from "@zcode/contracts/telemetry";
import { NOOP_AGENT_TELEMETRY_METRICS } from "../src/agent-metrics.js";
import { AgentExecutionTelemetryRuntime } from "../src/agent-trace-runtime.js";

const manager = new AsyncLocalStorageContextManager();
before(() => context.setGlobalContextManager(manager.enable()));
after(() => {
  context.disable();
  manager.disable();
});

const execution = {
  actorKind: "main",
  launchSurface: "standalone_cli",
  sessionId: "session-one",
  turnId: "turn-one",
} as const;
const target: ResolvedModelTelemetryDescriptor = {
  providerId: "fixture",
  providerKind: "openai-compatible",
  requestedModel: "fixture-model",
  reasoning: {
    capability: "unsupported",
    requestedState: "disabled",
    requestedControl: "provider_default",
    effectiveState: "disabled",
    effectiveControl: "provider_default",
  },
};
const callInput = {
  callCause: "initial",
  logicalCallId: "call-one",
  operation: "agent_step",
  requested: target,
  streaming: true,
} as const;

function tracing() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { exporter, provider, tracer: provider.getTracer("readiness-test") };
}

test("model and operation factories preserve parentage, identity and terminal cleanup", async () => {
  const { exporter, provider, tracer } = tracing();
  const terminals: string[] = [];
  const runtime = new AgentExecutionTelemetryRuntime({
    tracer,
    identity: { identityState: "authenticated", userSubjectId: "fixture-user" },
    metrics: {
      ...NOOP_AGENT_TELEMETRY_METRICS,
      recordSpanTerminal: (name) => terminals.push(name),
    },
  });
  try {
    const turn = runtime.startTurn({ context: execution, turnNumber: 1 });
    await turn.run(async () => {
      await Promise.resolve();
      const call = runtime.startCall(callInput);
      call.run(() => {
        const attempt = call.startAttempt({
          apiOperation: "chat_completions",
          attemptCause: "initial",
          attemptNumber: 1,
          maxAttempts: 1,
          requestId: "request-one",
          target,
          transport: "sse",
        });
        attempt.finishCompleted();
        call.finishCompleted();
      });
      const tool = runtime.startTool({ registeredToolName: "Bash", toolCallId: "tool-one" });
      tool.run(() => {
        const command = tool.startCommand({
          category: "shell",
          commandCount: 1,
          safeName: "echo",
          sandboxed: true,
        });
        command.finishCompleted();
        tool.finishCompleted();
      });
      runtime
        .startCompaction({
          trigger: "manual",
          phase: "standalone_turn",
          modelMode: "non_streaming",
        })
        .finishCompleted();
      const causation = runtime.captureCausation();
      assert.ok(causation);
      runtime
        .startDetachedOperation({
          context: execution,
          causation,
          executionKind: "background",
          operation: "session_title_generation",
          trigger: "turn",
        })
        .finishCompleted();
      turn.finishCompleted();
    });
    runtime.abandonSession(execution.sessionId);
    runtime.abandonProcess();
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const span = (name: string) => {
      const found = spans.find((item) => item.name === name);
      assert.ok(found, name);
      return found;
    };
    const turnSpan = span("agent_turn");
    assert.equal(spans.length, 7);
    assert.equal(terminals.length, 7, "cleanup must not finalize a writer twice");
    for (const name of ["model_call", "tool_execution", "context_compaction"]) {
      assert.equal(span(name).parentSpanContext?.spanId, turnSpan.spanContext().spanId);
    }
    assert.equal(
      span("model_attempt").parentSpanContext?.spanId,
      span("model_call").spanContext().spanId,
    );
    assert.equal(
      span("command_execution").parentSpanContext?.spanId,
      span("tool_execution").spanContext().spanId,
    );
    assert.equal(span("detached_operation").parentSpanContext, undefined);
    assert.equal(
      span("detached_operation").links[0]?.context.spanId,
      turnSpan.spanContext().spanId,
    );
    assert.equal(turnSpan.attributes["zcode.execution.identity_state"], "authenticated");
  } finally {
    await provider.shutdown();
  }
});

test("all factories share the capacity limit and session cleanup releases it", async () => {
  const { exporter, provider, tracer } = tracing();
  const drops: string[] = [];
  const runtime = new AgentExecutionTelemetryRuntime({
    tracer,
    maxActiveWriters: 1,
    metrics: {
      ...NOOP_AGENT_TELEMETRY_METRICS,
      recordCreationDrop: (name, reason) => drops.push(`${name}:${reason}`),
    },
  });
  try {
    const turn = runtime.startTurn({ context: execution, turnNumber: 1 });
    runtime.startCall(callInput).finishCompleted();
    runtime
      .startCompaction({
        trigger: "manual",
        phase: "standalone_turn",
        modelMode: "non_streaming",
      })
      .finishCompleted();
    assert.deepEqual(drops, ["model_call:process_capacity", "context_compaction:process_capacity"]);
    runtime.abandonSession("another-session");
    assert.equal(exporter.getFinishedSpans().length, 0);
    runtime.abandonSession(execution.sessionId);
    turn.finishCompleted();
    runtime.startCall(callInput).finishCompleted();
    runtime
      .startCompaction({
        trigger: "manual",
        phase: "standalone_turn",
        modelMode: "non_streaming",
      })
      .finishCompleted();
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 3);
    assert.equal(spans[0]?.attributes["zcode.agent_turn.abandon_reason"], "session_shutdown");
  } finally {
    await provider.shutdown();
  }
});
