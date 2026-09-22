import {
  CoreErrorType,
  traceContextToLogContext,
  type ToolExecutionSpanWriter,
  type TraceContext,
} from "@zcode/contracts";
import { errorCategoryForToolError } from "./call-runner-model-output.js";
import type { ToolExecutionResult } from "../types.js";
import type { ToolExecuteOptions, ToolExecutorDeps } from "./types.js";

export function finishToolCallFailure(input: {
  deps: ToolExecutorDeps;
  toolCall: { id: string; name: string };
  traceContext: TraceContext;
  result: ToolExecutionResult;
  error: unknown;
  durationMs: number;
  failureStage: "handler" | "serialize" | "post_hook";
  options: ToolExecuteOptions | undefined;
  telemetry: ToolExecutionSpanWriter | undefined;
}): void {
  input.deps.logger?.error(
    "Tool call failed",
    input.error instanceof Error ? input.error : new Error(String(input.error)),
    {
      ...traceContextToLogContext(input.traceContext),
      durationMs: input.durationMs,
      event: "tool.call.failed",
      module: "core.tool.executor",
      status: "failed",
      toolCallId: input.toolCall.id,
      toolName: input.toolCall.name,
    },
  );

  if (input.options?.signal?.aborted || input.result.error?.type === CoreErrorType.ToolCancelled) {
    input.telemetry?.finishCancelled("abort_signal");
  } else {
    input.telemetry?.finishFailed(
      input.failureStage,
      errorCategoryForToolError(input.result.error?.type),
      // 原始异常只交给 Telemetry 做受控脱敏；result.error 是面向业务协议重新包装后的错误，
      // 不能覆盖 Trace 中用于定位根因的 source message/type/code。
      input.error,
    );
  }
}
