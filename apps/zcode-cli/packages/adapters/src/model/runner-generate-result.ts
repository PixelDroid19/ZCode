import type { ModelTextResult } from "@zcode/contracts";
import { canRetryEmptyCompletion } from "./empty-completion-retry.js";
import { detectProviderBusinessFinishError } from "./provider-finish-business-error.js";
import { isZeroOutputModelCompletion } from "./runner-diagnostics.js";
import type {
  AiSdkGenerateTextResult,
  AiSdkModelTextRequest,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";

export function serializeStructuredOutput(result: unknown): string {
  const output = (result as { output?: unknown }).output;
  if (output === undefined) {
    throw new Error("Structured output is unavailable");
  }
  const serialized = JSON.stringify(output);
  if (serialized === undefined) {
    throw new Error("Structured output is unavailable");
  }
  return serialized;
}

export function waitForGenerateTextOrAbort<T>(
  pending: Promise<T>,
  abortSignal: AbortSignal | undefined,
): Promise<T> {
  if (!abortSignal) {
    return pending;
  }

  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => {
      abortSignal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(
        abortSignal.reason instanceof Error
          ? abortSignal.reason
          : new Error("Model request was cancelled."),
      );
    };

    if (abortSignal.aborted) {
      onAbort();
      return;
    }

    abortSignal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function throwIfProviderBusinessFinishError(input: {
  result: AiSdkGenerateTextResult;
  resolved: ResolvedAiSdkModel;
}): void {
  const providerBusinessFinishError = detectProviderBusinessFinishError({
    providerId: String(input.resolved.providerId),
    providerKind: input.resolved.providerKind,
    source: {
      finishReason: input.result.finishReason,
      providerMetadata: input.result.providerMetadata,
      rawFinishReason: (input.result.providerMetadata as Record<string, unknown> | undefined)
        ?.rawFinishReason,
      response: (input.result as unknown as { response?: unknown }).response,
    },
  });
  if (providerBusinessFinishError) {
    throw providerBusinessFinishError;
  }
}

export function shouldRetryEmptyGenerateCompletion(input: {
  attempt: number;
  emptyCompletionRetryCount: number;
  request: AiSdkModelTextRequest;
  result: AiSdkGenerateTextResult;
  reasoning: ModelTextResult["reasoning"];
  retryMaxAttempts: number;
  text: string;
  toolCalls: ModelTextResult["toolCalls"];
  usage: ModelTextResult["usage"];
}): boolean {
  const reasoningLength = (input.reasoning ?? []).reduce(
    (total, block) => total + block.text.length,
    0,
  );
  return (
    input.request.preserveProviderStreamBoundaries !== true &&
    isZeroOutputModelCompletion({
      finishReason: input.result.finishReason,
      reasoningLength,
      textLength: input.text.length,
      toolCallCount: input.toolCalls?.length ?? 0,
      usage: input.usage,
    }) &&
    canRetryEmptyCompletion({
      abortSignal: input.request.abortSignal,
      attempt: input.attempt,
      maxAttempts: input.retryMaxAttempts,
      retryCount: input.emptyCompletionRetryCount,
    })
  );
}
