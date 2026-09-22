import type {
  ModelCompletePayload,
  ModelNetworkStatusPayload,
  ModelStreamingPayload,
  SessionEvent,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import {
  conversationTelemetryFactSchema,
  type ConversationTelemetryFact,
} from "@zcode/shared/zcode-protocol-v4";
import {
  BoundedKeySet,
  BoundedValueMap,
  CompletedModelRequestIdentity,
  isStepUsageModelComplete,
  isStepUsageQuerySource,
  modelRequestQueueKey,
  nonNegative,
  optionalString,
  providerHostname,
  recordValue,
  streamingParentToolCallId,
  totalTokensOf,
} from "./conversation-telemetry-values.js";
interface ModelTelemetryState {
  readonly modelBySession: BoundedValueMap<{ modelName: string; modelProvider: string }>;
  readonly completedModelRequests: BoundedValueMap<CompletedModelRequestIdentity[]>;
  readonly firstStreamChunks: BoundedKeySet;
}
export function normalizeModelTelemetryFact(
  state: ModelTelemetryState,
  input: {
    base: Pick<
      ConversationTelemetryFact,
      "version" | "eventId" | "eventSeq" | "occurredAt" | "sessionId" | "turnId" | "memoryEnabled"
    >;
    event: SessionEvent;
    sessionId: string;
    turnId: string | undefined;
    sourceCommandId: string | undefined;
  },
): ConversationTelemetryFact | null {
  const { base, event, sessionId, turnId, sourceCommandId } = input;
  switch (event.type) {
    case SessionEventType.ModelNetworkStatus: {
      const payload = event.payload as ModelNetworkStatusPayload;
      // 准入等待的两端不是 provider 请求状态：
      // fact 的 status 枚举不收它们，显式跳过而不是让 schema.parse 抛出。
      if (payload.type === "model_request_queued" || payload.type === "model_request_admitted") {
        return null;
      }
      const modelProvider = String(payload.providerId);
      const modelName = String(payload.modelId);
      state.modelBySession.set(sessionId, { modelName, modelProvider });
      const fact = conversationTelemetryFactSchema.parse({
        ...base,
        kind: "model.request.status",
        ...(sourceCommandId ? { sourceCommandId } : {}),
        requestId: String(payload.requestId),
        status: payload.type,
        providerId: modelProvider,
        modelId: modelName,
        ...(payload.providerKind ? { providerKind: payload.providerKind } : {}),
        ...(providerHostname(payload.baseURL)
          ? { providerHostname: providerHostname(payload.baseURL) }
          : {}),
        transport: payload.transport,
        ...(payload.querySource ? { querySource: payload.querySource } : {}),
        ...(payload.queryId ? { queryId: String(payload.queryId) } : {}),
        attempt: payload.attempt,
        maxAttempts: payload.maxAttempts,
        ...(payload.type === "model_request_completed"
          ? {
              durationMs: payload.durationMs,
            }
          : {}),
        ...(payload.type === "model_request_failed"
          ? {
              ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
              reason: payload.reason,
              retryable: payload.retryable,
              ...(payload.statusCode !== undefined ? { statusCode: payload.statusCode } : {}),
            }
          : {}),
        ...(payload.type === "model_retry_scheduled"
          ? {
              delayMs: payload.delayMs,
              nextAttempt: payload.nextAttempt,
              reason: payload.reason,
              ...(payload.statusCode !== undefined ? { statusCode: payload.statusCode } : {}),
            }
          : {}),
        ...(payload.type === "model_stream_stalled"
          ? { idleMs: payload.idleMs, timeoutMs: payload.timeoutMs }
          : {}),
      });
      const querySource = optionalString(payload.querySource);
      if (payload.type === "model_request_completed" && isStepUsageQuerySource(querySource)) {
        const key = modelRequestQueueKey(sessionId, querySource);
        const queue = state.completedModelRequests.get(key) ?? [];
        queue.push({
          requestId: String(payload.requestId),
          providerId: modelProvider,
          modelId: modelName,
          ...(payload.providerKind ? { providerKind: payload.providerKind } : {}),
          ...(providerHostname(payload.baseURL)
            ? { providerHostname: providerHostname(payload.baseURL) }
            : {}),
        });
        state.completedModelRequests.set(key, queue);
      }
      return fact;
    }
    case SessionEventType.ModelStreaming: {
      const payload = event.payload as ModelStreamingPayload;
      const rawPayload = recordValue(event.payload);
      const channel =
        payload.kind === "text_delta"
          ? "text"
          : payload.kind === "reasoning_delta"
            ? "thought"
            : null;
      if (!channel) return null;
      const parentToolCallId = streamingParentToolCallId(rawPayload);
      const streamKey = `${sessionId}\0${turnId ?? ""}\0${channel}\0${String(payload.partId ?? "")}\0${parentToolCallId ?? ""}`;
      return conversationTelemetryFactSchema.parse({
        ...base,
        kind: "stream.chunk",
        ...(sourceCommandId ? { sourceCommandId } : {}),
        channel,
        chunkLength: payload.delta.length,
        firstChunk: state.firstStreamChunks.add(streamKey),
        ...(payload.assistantMessageId
          ? { assistantMessageId: String(payload.assistantMessageId) }
          : {}),
        ...(payload.partId ? { partId: String(payload.partId) } : {}),
        ...(parentToolCallId ? { parentToolCallId } : {}),
      });
    }
    case SessionEventType.ModelComplete: {
      const payload = event.payload as ModelCompletePayload;
      const requestQueueKey = modelRequestQueueKey(sessionId, optionalString(payload.querySource));
      const completedRequests = state.completedModelRequests.get(requestQueueKey) ?? [];
      const completedRequest = completedRequests.shift();
      if (completedRequests.length > 0) {
        state.completedModelRequests.set(requestQueueKey, completedRequests);
      } else {
        state.completedModelRequests.delete(requestQueueKey);
      }
      // 标题 sidecar 沿用当前 turnId，若把它的 ModelComplete 也转成
      // usage.delta，renderer 会把每轮标题的 64/8 tokens 累加进主对话 completion。
      // 本期只放行主轮和 subagent request usage；sidecar/compact/tool_internal 仍不外送。
      if (!isStepUsageModelComplete(payload)) return null;
      const usage = recordValue(payload.usage);
      return conversationTelemetryFactSchema.parse({
        ...base,
        kind: "usage.delta",
        ...(sourceCommandId ? { sourceCommandId } : {}),
        ...(completedRequest
          ? {
              requestId: completedRequest.requestId,
              providerId: completedRequest.providerId,
              modelId: completedRequest.modelId,
              ...(completedRequest.providerKind
                ? { providerKind: completedRequest.providerKind }
                : {}),
              ...(completedRequest.providerHostname
                ? { providerHostname: completedRequest.providerHostname }
                : {}),
            }
          : {}),
        inputTokens: nonNegative(usage.inputTokens) ?? 0,
        outputTokens: nonNegative(usage.outputTokens) ?? 0,
        totalTokens: totalTokensOf(usage),
        reasoningTokens: nonNegative(usage.reasoningTokens) ?? 0,
        cacheReadTokens: nonNegative(usage.cacheReadTokens) ?? nonNegative(usage.cacheTokens) ?? 0,
        cacheWriteTokens: nonNegative(usage.cacheWriteTokens) ?? 0,
      });
    }
    default:
      return null;
  }
}
