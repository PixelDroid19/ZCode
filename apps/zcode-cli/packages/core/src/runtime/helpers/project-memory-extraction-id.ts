import { createHash } from "node:crypto";
import type { ModelToolCall } from "../deps.js";

export function extractionToolCallId(call: ModelToolCall): string {
  const input = call.input;
  const action =
    input && typeof input === "object" && !Array.isArray(input) && "action" in input
      ? input.action
      : undefined;
  if (action !== "save" && action !== "update" && action !== "forget") return call.id;
  // Provider 的 toolCallId 在重试时会变化；遗忘后的旧输入也不能绕过 tombstone 复活。
  const digest = createHash("sha256")
    .update(stableJson(input))
    .digest("hex");
  return `memory-extraction-${digest}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}
