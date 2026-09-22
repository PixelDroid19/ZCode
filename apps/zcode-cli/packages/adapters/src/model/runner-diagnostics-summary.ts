import type { ModelUsage } from "@zcode/contracts";
import { detectProviderBusinessFinishError } from "./provider-finish-business-error.js";
import { asRecord, stringProperty } from "./runner-record.js";

export interface StreamDiagnosticFinishState {
  finishReason?: string;
  lastErrorChunk?: unknown;
  lastFinishChunk?: unknown;
  rawFinishReason?: unknown;
}

export function summarizeFinishChunkForDiagnostics(
  chunk: unknown,
): Record<string, unknown> | undefined {
  const record = asRecord(chunk);
  if (Object.keys(record).length === 0) {
    return undefined;
  }

  const response = asRecord(record.response);
  const providerMetadata = asRecord(record.providerMetadata);
  return {
    chunkKeys: diagnosticObjectKeys(record),
    finishReason: summarizeDiagnosticScalar(record.finishReason),
    rawFinishReason: summarizeDiagnosticScalar(record.rawFinishReason),
    providerMetadataKeys: diagnosticObjectKeys(providerMetadata),
    responseBody: summarizeProviderBody(response?.body ?? record.body),
    responseStatus: summarizeDiagnosticScalar(response?.status),
  };
}

export function summarizeOutboundModelHeaders(
  headers: Record<string, string> | undefined,
): Record<string, unknown> {
  if (!headers) {
    return { outboundHeaderKeys: [] };
  }

  return { outboundHeaderKeys: Object.keys(headers) };
}

export function summarizeFinishChunkBusinessScan(input: {
  providerId: string;
  providerKind?: string;
  diagnostics: StreamDiagnosticFinishState;
}): Record<string, unknown> {
  const finishSource =
    input.diagnostics.lastFinishChunk ??
    ({
      type: "finish",
      finishReason: input.diagnostics.finishReason,
      rawFinishReason: input.diagnostics.rawFinishReason,
    } satisfies Record<string, unknown>);

  const finishBusinessError = detectProviderBusinessFinishError({
    providerId: input.providerId,
    providerKind: input.providerKind,
    source: finishSource,
  });

  return {
    finishBusinessErrorCode: finishBusinessError?.providerCode ?? null,
    finishBusinessErrorMessage: finishBusinessError?.providerMessage ?? null,
    finishChunk: summarizeFinishChunkForDiagnostics(input.diagnostics.lastFinishChunk),
    finishChunkPreview: summarizeRawFinishChunkPreview(input.diagnostics.lastFinishChunk),
    lastErrorChunk: summarizeFinishChunkForDiagnostics(input.diagnostics.lastErrorChunk),
  };
}

export function summarizeRawFinishChunkPreview(
  chunk: unknown,
): Record<string, unknown> | undefined {
  if (chunk === undefined) {
    return undefined;
  }

  try {
    const serialized = JSON.stringify(chunk);
    if (serialized.length <= 2_048) {
      return JSON.parse(serialized) as Record<string, unknown>;
    }
    return {
      truncated: true,
      preview: serialized.slice(0, 2_048),
    };
  } catch {
    return summarizeFinishChunkForDiagnostics(chunk);
  }
}

export function summarizeProviderBody(body: unknown): Record<string, unknown> | undefined {
  if (body === undefined) return undefined;
  if (body === null) return { type: "null" };

  if (typeof body === "string") {
    return {
      length: body.length,
      preview: body.slice(0, 500),
      type: "string",
    };
  }

  if (typeof body !== "object") {
    return {
      type: typeof body,
      value: summarizeDiagnosticScalar(body),
    };
  }

  const record = body as Record<string, unknown>;
  return {
    code: summarizeDiagnosticScalar(record.code),
    error: summarizeProviderError(record.error),
    keys: diagnosticObjectKeys(record),
    message: summarizeDiagnosticScalar(record.message),
    msg: summarizeDiagnosticScalar(record.msg),
    status: summarizeDiagnosticScalar(record.status),
    success: typeof record.success === "boolean" ? record.success : undefined,
    type: Array.isArray(body) ? "array" : "object",
  };
}

export function summarizeStreamChunk(chunk: unknown): Record<string, unknown> {
  const record = asRecord(chunk);
  return {
    chunkKeys: diagnosticObjectKeys(record),
    chunkType: stringProperty(record, "type") ?? typeof chunk,
    finishReason: summarizeDiagnosticScalar(record.finishReason),
    rawFinishReason: summarizeDiagnosticScalar(record.rawFinishReason),
  };
}

export function summarizeModelUsage(usage?: ModelUsage): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  return {
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    serverToolUse: usage.serverToolUse,
    totalTokens: usage.totalTokens,
  };
}

export function summarizeDiagnosticScalar(value: unknown): unknown {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return Array.isArray(value) ? `[array:${value.length}]` : "[object]";
}

export function diagnosticObjectKeys(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  return Object.keys(value).slice(0, 20);
}

function summarizeProviderError(error: unknown): unknown {
  if (error === undefined || error === null || typeof error !== "object") {
    return summarizeDiagnosticScalar(error);
  }

  const record = error as Record<string, unknown>;
  return {
    code: summarizeDiagnosticScalar(record.code),
    keys: diagnosticObjectKeys(record),
    message: summarizeDiagnosticScalar(record.message),
    type: summarizeDiagnosticScalar(record.type),
  };
}
