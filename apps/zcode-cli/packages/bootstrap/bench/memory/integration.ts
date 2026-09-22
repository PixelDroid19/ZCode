import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyMemory, runTurn, snapshot, memoryDigest } from "./app.js";
import { score } from "./cases.js";

const properties = {
  contextWindow: 128000,
  inputFormat: {
    supportsAudio: false,
    supportsImage: false,
    supportsPdf: false,
    supportsText: true,
    supportsVideo: false,
  },
  outputFormat: { supportsText: true },
  supportsToolCall: true,
  supportsJsonSchemaOutput: false,
  supportsMidConversationSystem: false,
  supportsNativeWebSearch: false,
};
const optionSpecs = {
  maxOutputTokens: { max: 2048, map: "{}" },
  reasoningLevel: { values: ["low"], map: "{}" },
};
const providerId = "local-deterministic";
const modelId = "deterministic";
const selection = { providerId, modelId, options: { reasoningLevel: "low" } };

type RequestBody = {
  messages?: Array<{ role?: string; content?: unknown }>;
  tools?: Array<{ name?: string; function?: { name?: string } }>;
};
type ProviderObservation = {
  phase: "foreground" | "extraction";
  hasMemoryTool: boolean;
  responseKind: "text" | "memory_save";
};
const providerObservations: ProviderObservation[] = [];

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const block = item as { text?: unknown; content?: unknown };
      return typeof block.text === "string" ? block.text : contentText(block.content);
    })
    .join("\n");
}
function bodyHasTranscript(body: RequestBody): boolean {
  return (
    body.messages?.some((message) =>
      contentText(message.content).includes("Durable transcript (JSON, one message per line):"),
    ) ?? false
  );
}
function bodyHasToolResult(body: RequestBody): boolean {
  return body.messages?.some((message) => message.role === "tool") ?? false;
}
function bodyHasRecall(body: RequestBody): boolean {
  return (
    body.messages?.some((message) =>
      contentText(message.content).includes("# Recalled experience records"),
    ) ?? false
  );
}
function bodyHasMemoryTool(body: RequestBody): boolean {
  return (
    body.tools?.some((tool) => tool.name === "Memory" || tool.function?.name === "Memory") ?? false
  );
}
function responseBody(message: Record<string, unknown>, finishReason: string) {
  return JSON.stringify({
    id: "local-" + (providerObservations.length + 1),
    object: "chat.completion",
    created: 1,
    model: modelId,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

const server = createServer((request, response) => {
  if (request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RequestBody;
      const extraction = bodyHasTranscript(body);
      const hasMemoryTool = bodyHasMemoryTool(body);
      if (extraction) {
        if (bodyHasToolResult(body)) {
          providerObservations.push({ phase: "extraction", hasMemoryTool, responseKind: "text" });
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(
              responseBody(
                { role: "assistant", content: "Deterministic extraction completed." },
                "stop",
              ),
            );
          return;
        }
        providerObservations.push({
          phase: "extraction",
          hasMemoryTool,
          responseKind: "memory_save",
        });
        const input = {
          action: "save",
          scope: "project",
          outcome: "recorded",
          content: {
            topicKey: "local-deterministic-repair",
            kind: "episode",
            title: "Deterministic local repair",
            summary: "Use fencingMode=epoch-local for the local harness repair.",
            problem: "The previous owner retained a stale lease.",
            resolution: "Set fencingMode=epoch-local before retrying the worker.",
            rationale: "stale_owner_local requires a new fencing epoch.",
            applicability: "The local deterministic integration workspace.",
            tags: ["local", "fixture"],
          },
          evidence: [
            { kind: "agent", summary: "The deterministic provider observed the teaching turn." },
          ],
        };
        response.writeHead(200, { "content-type": "application/json" }).end(
          responseBody(
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "local-memory-save",
                  type: "function",
                  function: { name: "Memory", arguments: JSON.stringify(input) },
                },
              ],
            },
            "tool_calls",
          ),
        );
        return;
      }

      const recalled = bodyHasRecall(body);
      const message = recalled
        ? {
            role: "assistant",
            content: JSON.stringify({
              answer: "epoch-local",
              status: "recorded",
              reason: "stale_owner_local",
            }),
          }
        : {
            role: "assistant",
            content: JSON.stringify({ answer: null, status: "unknown", reason: null }),
          };
      providerObservations.push({ phase: "foreground", hasMemoryTool, responseKind: "text" });
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(responseBody(message, "stop"));
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: { message: error instanceof Error ? error.message : String(error) },
        }),
      );
    }
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Local provider did not bind");
const baseURL = "http://127.0.0.1:" + address.port + "/v1";
const provider = {
  providerId,
  providerName: "Local deterministic integration provider",
  config: {
    access: { type: "api-key", apiKey: "local-fixture" },
    api: { type: "openai-chat-completions", baseUrl: baseURL },
  },
  models: [{ modelId, config: { properties, optionSpecs } }],
};
const registryService = {
  getView: () => ({ providers: [provider], revision: 1 }),
  getProvider: (id: string) => (id === providerId ? provider : undefined),
  getModel: (id: string, model: string) =>
    id === providerId && model === modelId ? provider.models[0] : undefined,
  validateSelection: (value: typeof selection) =>
    value.providerId === providerId &&
    value.modelId === modelId &&
    value.options?.reasoningLevel === "low"
      ? { ok: true }
      : { ok: false, code: "provider-not-found", providerId: value.providerId },
  onDidChange: () => () => undefined,
};
const registry = { runtime: { registryService } } as never;
const root = await mkdtemp(join(tmpdir(), "zcode-memory-harness-check-"));
const report: Record<string, unknown> = {
  integration: "deterministic-local-provider",
  simulatedUsage: true,
};

try {
  const teachingOff = await runTurn({
    root,
    profile: "learn-off",
    projectKey: "local-project-off",
    arm: "off",
    learning: true,
    prompt: "Teach this repair: use fencingMode=epoch-local because stale_owner_local.",
    registry,
    selection,
  });
  if (teachingOff.error || teachingOff.extractionUsage.calls !== 0)
    throw new Error("OFF teaching unexpectedly extracted memory");
  const offRecords = await snapshot(root, "learn-off", "local-project-off");
  if (offRecords.records.length !== 0) throw new Error("OFF teaching wrote memory");
  report.teachingOff = {
    records: offRecords.records.length,
    extractionCalls: teachingOff.extractionUsage.calls,
  };
  const teaching = await runTurn({
    root,
    profile: "learn",
    projectKey: "local-project",
    arm: "on",
    learning: true,
    prompt: "Teach this repair: use fencingMode=epoch-local because stale_owner_local.",
    registry,
    selection,
  });
  const learned = await snapshot(root, "learn", "local-project");
  const extractionRequests = providerObservations.filter((item) => item.phase === "extraction");
  report.teaching = {
    foregroundMemoryMutations: teaching.mutatingForegroundCalls,
    foregroundUsage: teaching.foregroundUsage,
    extractionUsage: teaching.extractionUsage,
    learnedRecords: learned.records.length,
    extractionRequests,
    observedCalls: teaching.calls.map((call) => ({
      operation: call.operation,
      recalled: call.recalled,
      hasToolCalls: Boolean(call.toolCalls?.length),
      hasTranscriptInObservation: JSON.stringify(call).includes("Durable transcript"),
    })),
  };
  if (teaching.error) throw new Error("Deterministic teaching failed");
  if (teaching.mutatingForegroundCalls !== 0)
    throw new Error("foreground Memory mutation was not disallowed");
  if (teaching.extractionUsage.calls < 1)
    throw new Error("automatic extraction made no model call");
  if (learned.records.length !== 1)
    throw new Error("expected one extracted record, got " + learned.records.length);
  if (extractionRequests.length < 1 || extractionRequests.some((item) => !item.hasMemoryTool)) {
    throw new Error("extraction request did not receive the Memory tool");
  }

  await copyMemory(root, "learn", "query-on");
  await copyMemory(root, "learn", "query-off");
  const beforeOn = await memoryDigest(root, "query-on");
  const beforeOff = await memoryDigest(root, "query-off");
  const queryPrompt = "What fencing value and cause were recorded for the local repair?";
  const queryOn = await runTurn({
    root,
    profile: "query-on",
    projectKey: "local-project",
    arm: "on",
    learning: false,
    prompt: queryPrompt,
    registry,
    selection,
  });
  const queryOff = await runTurn({
    root,
    profile: "query-off",
    projectKey: "local-project",
    arm: "off",
    learning: false,
    prompt: queryPrompt,
    registry,
    selection,
  });
  const onAfter = await snapshot(root, "query-on", "local-project");
  const offAfter = await snapshot(root, "query-off", "local-project");
  report.query = {
    on: {
      response: queryOn.response,
      recalledCalls: queryOn.calls.filter((call) => call.recalled).length,
      foregroundUsage: queryOn.foregroundUsage,
      extractionUsage: queryOn.extractionUsage,
      recordsAfter: onAfter.records.length,
    },
    off: {
      response: queryOff.response,
      recalledCalls: queryOff.calls.filter((call) => call.recalled).length,
      foregroundUsage: queryOff.foregroundUsage,
      extractionUsage: queryOff.extractionUsage,
      recordsAfter: offAfter.records.length,
    },
  };
  if (queryOn.error || queryOff.error) throw new Error("query turn failed");
  if (
    beforeOn !== (await memoryDigest(root, "query-on")) ||
    beforeOff !== (await memoryDigest(root, "query-off"))
  )
    throw new Error("Evaluation changed a memory snapshot");
  if (
    !teaching.totalUsage.complete ||
    !teaching.physicalUsage.complete ||
    teaching.unexpectedOperations.length
  )
    throw new Error("Usage attribution is incomplete");
  if (queryOn.extractionUsage.calls || queryOff.extractionUsage.calls)
    throw new Error("Evaluation scheduled extraction");
  if (!queryOn.calls.some((call) => call.recalled))
    throw new Error("ON query did not receive recalled context");
  if (queryOff.calls.some((call) => call.recalled))
    throw new Error("OFF query received recalled context");
  if (!queryOn.response.includes('"answer":"epoch-local"'))
    throw new Error("ON query did not preserve the extracted memory");
  if (!queryOff.response.includes('"status":"unknown"'))
    throw new Error("OFF query unexpectedly answered from memory");
  const expected = { answer: "epoch-local", status: "recorded", reason: "stale_owner_local" };
  if (!score(queryOn.response, expected).passed || score(queryOff.response, expected).passed)
    throw new Error("The evaluator did not distinguish the paired answers");
  if (
    JSON.stringify([teaching.calls, queryOn.calls, queryOff.calls]).includes("Durable transcript")
  ) {
    throw new Error("observer calls leaked the durable transcript");
  }
  report.providerObservationCount = providerObservations.length;
  report.status = "passed";
  console.log(JSON.stringify(report, null, 2));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
