import {
  getCurrentModelInvocationContext,
  modelMessageContentToText,
  type Model,
  type ModelRequest,
  type ModelTextResult,
  type ModelUsage,
  type ModelNetworkStatusEvent,
} from "@zcode/contracts";
import { AiSdkModelAdapter, type CreateAiSdkModelOptions } from "@zcode/adapters/model";

export interface CallObservation {
  operation: string;
  durationMs: number;
  usage?: ModelUsage;
  toolCalls?: ModelTextResult["toolCalls"];
  text?: string;
  error?: ReturnType<typeof safeError>;
  recalled: boolean;
  options: Model["options"];
  memoryContext: string[];
}

export interface AttemptObservation {
  type: string;
  operation?: string;
  attempt: number;
  durationMs?: number;
  usage?: ModelUsage;
  error?: { code?: string; status?: number; reason?: string };
}

export function safeError(error: unknown) {
  const value = error as { name?: string; code?: string; context?: { statusCode?: number } };
  return { name: value?.name ?? "Error", code: value?.code, status: value?.context?.statusCode };
}

export class ObservedAdapter extends AiSdkModelAdapter {
  readonly calls: CallObservation[] = [];
  readonly attempts: AttemptObservation[] = [];
  private requestCount = 0;

  constructor(
    env: NodeJS.ProcessEnv,
    private readonly requestLimit = 160,
    private readonly requestTimeoutMs = 45_000,
    private readonly turnSignal?: AbortSignal,
  ) {
    super({ env, retry: { maxAttempts: 1 } });
    this.addStatusSink({ publish: (event) => this.observeAttempt(event) });
  }

  override createModel(options: CreateAiSdkModelOptions): Model {
    return this.observe(super.createModel(options));
  }

  private observe(model: Model): Model {
    return {
      providerId: model.providerId,
      modelId: model.modelId,
      properties: model.properties,
      optionSpecs: model.optionSpecs,
      options: model.options,
      bind: (options) => this.observe(model.bind(options)),
      generateText: (request) => this.generate(model, request),
      streamText: () => {
        throw new Error("The benchmark requires non-streaming model requests");
      },
    };
  }

  private async generate(model: Model, request: ModelRequest): Promise<ModelTextResult> {
    if (++this.requestCount > this.requestLimit)
      throw new Error("Benchmark model-call budget exceeded");
    const started = performance.now();
    const operation = getCurrentModelInvocationContext()?.modelCall?.operation ?? "unknown";
    const record: CallObservation = {
      operation,
      durationMs: 0,
      recalled: JSON.stringify(request.messages).includes("# Recalled experience records"),
      options: { ...model.options, ...request.options },
      memoryContext: request.messages.flatMap((message) => {
        const text = modelMessageContentToText(message.content);
        const marker = text.indexOf("# Recalled experience records");
        if (marker >= 0) return [text.slice(marker)];
        return message.role === "tool" ? [text] : [];
      }),
    };
    this.calls.push(record);
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    try {
      const result = await model.generateText({
        ...request,
        abortSignal: AbortSignal.any([
          timeout,
          ...[request.abortSignal, this.turnSignal].filter(
            (signal): signal is AbortSignal => signal !== undefined,
          ),
        ]),
      });
      Object.assign(record, {
        usage: result.usage,
        toolCalls: result.toolCalls,
        text: result.text,
      });
      return result;
    } catch (error) {
      record.error = safeError(error);
      throw error;
    } finally {
      record.durationMs = Math.round(performance.now() - started);
    }
  }

  private observeAttempt(event: ModelNetworkStatusEvent): void {
    if (event.type !== "model_request_completed" && event.type !== "model_request_failed") return;
    // Do not serialize raw events: they can contain provider headers and credentials.
    this.attempts.push({
      type: event.type,
      operation: event.modelCall?.operation,
      attempt: event.attempt,
      durationMs: event.durationMs,
      ...(event.type === "model_request_completed"
        ? { usage: event.usage }
        : {
            error: { code: event.errorCode, status: event.statusCode, reason: event.reason },
          }),
    });
  }
}

export function usage(calls: readonly { usage?: ModelUsage; error?: unknown }[]) {
  const fields = [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
  ] as const;
  return {
    calls: calls.length,
    errors: calls.filter((call) => call.error).length,
    missingUsage: calls.filter((call) => call.usage?.totalTokens === undefined).length,
    complete:
      calls.length > 0 &&
      calls.every((call) => !call.error && call.usage?.totalTokens !== undefined),
    webSearchRequests: calls.some(
      (call) => call.usage?.serverToolUse?.webSearchRequests !== undefined,
    )
      ? calls.reduce((sum, call) => sum + (call.usage?.serverToolUse?.webSearchRequests ?? 0), 0)
      : null,
    webFetchRequests: calls.some(
      (call) => call.usage?.serverToolUse?.webFetchRequests !== undefined,
    )
      ? calls.reduce((sum, call) => sum + (call.usage?.serverToolUse?.webFetchRequests ?? 0), 0)
      : null,
    ...Object.fromEntries(
      fields.map((field) => [
        field,
        calls.some((call) => call.usage?.[field] !== undefined)
          ? calls.reduce((sum, call) => sum + (call.usage?.[field] ?? 0), 0)
          : null,
      ]),
    ),
  };
}
