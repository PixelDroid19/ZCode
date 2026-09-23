import {
  selectActiveConversationBranch,
  type MessageId,
  type MessageWithParts,
  type Logger,
  type TraceContext,
} from "../deps.js";
import type { ModelInputMessage, ModelToolCall } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { auxiliaryModelOptions } from "../../model/auxiliary-model-options.js";
import { modelContentForToolResult, isErrorForToolResult } from "../helpers/tool-result.js";
import {
  buildProjectMemoryAgentProviderMessages,
  captureProjectMemoryAgentContext,
  createProjectMemoryAgentToolExecutor,
  FINISH_MEMORY_EXTRACTION_TOOL_NAME,
  type ProjectMemoryAgentContext,
} from "./project-memory-agent.js";
import { extractionToolCallId } from "./project-memory-extraction-id.js";
import { isStructuredMemoryEnabled } from "./project-memory.js";
import { buildStructuredExtractionPrompt } from "./project-memory-transcript.js";

const EXTRACTION_MAX_STEPS = 4;
const EXTRACTION_DRAIN_TIMEOUT_MS = 60_000;
interface ProjectMemoryExtractionSnapshot extends ProjectMemoryAgentContext {
  boundaryMessageId: MessageId;
  durableMessages: readonly MessageWithParts[];
}

type ExtractionStatus = "success" | "no-op" | "error" | "aborted";
interface ExtractionResult {
  status: ExtractionStatus;
  processedBoundary?: MessageId;
}

export interface ProjectMemoryExtractionScheduler {
  drain(): Promise<void>;
  getCursor(): MessageId | undefined;
  hasPendingWork(): boolean;
  schedule(
    snapshot: ProjectMemoryExtractionSnapshot | Promise<ProjectMemoryExtractionSnapshot>,
  ): void;
  shutdown(): void;
}

export function isProjectMemoryEnabled(this: AgentRuntimeInternal): boolean {
  return isStructuredMemoryEnabled(this);
}

export function scheduleProjectMemoryExtraction(
  runtime: AgentRuntimeInternal,
  input: { model: ProjectMemoryAgentContext["model"]; traceContext: TraceContext },
): void {
  if (
    runtime.shuttingDown ||
    runtime.config.memory?.extractionEnabled === false ||
    !isStructuredMemoryEnabled(runtime) ||
    !runtime.sessionStore ||
    !runtime.registry.has("Memory")
  ) {
    return;
  }

  const snapshotBoundaryMessageId = runtime.latestConversationMessageId;
  if (!snapshotBoundaryMessageId) return;
  const sessionStore = runtime.sessionStore;
  const snapshotBase = captureProjectMemoryAgentContext(runtime, {
    model: input.model,
    operation: "project_memory_extract",
    traceContext: input.traceContext,
  });
  const snapshot = Promise.all([
    sessionStore.messages({ sessionID: runtime.sessionId }),
    sessionStore.getSession(runtime.sessionId),
  ]).then(([messages, session]): ProjectMemoryExtractionSnapshot => {
    const activeMessages = selectActiveConversationBranch(messages, {
      branchCutAfterMessageId: session?.revert?.branchCutAfterMessageID,
      rewindCreatedMessageId: session?.revert?.createdMessageID,
      rewindKeptMessageIds: session?.revert?.keptMessageIDs,
      rewindTargetMessageId: session?.revert?.targetMessageID,
    });
    const boundaryIndex = activeMessages.findIndex(
      (message) => message.info.id === snapshotBoundaryMessageId,
    );
    if (boundaryIndex < 0) {
      throw new Error("Experience extraction boundary is missing from the active branch.");
    }
    return {
      ...snapshotBase,
      boundaryMessageId: snapshotBoundaryMessageId,
      durableMessages: activeMessages.slice(0, boundaryIndex + 1),
    };
  });

  runtime.memoryExtractionScheduler ??= createExtractionScheduler(
    (extraction) =>
      executeProjectMemoryExtraction(
        runtime,
        extraction.snapshot,
        extraction.cursor,
        extraction.signal,
        extraction.continuation,
      ),
    runtime.logger,
    runtime.sessionId,
  );
  runtime.memoryExtractionScheduler.schedule(snapshot);
}

export async function drainMemoryExtractions(
  this: AgentRuntimeInternal,
  timeoutMs: number | null = EXTRACTION_DRAIN_TIMEOUT_MS,
): Promise<void> {
  const scheduler = this.memoryExtractionScheduler;
  if (!scheduler) return;
  if (timeoutMs === null) {
    await scheduler.drain();
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      scheduler.drain(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function createExtractionScheduler(
  execute: (input: {
    snapshot: ProjectMemoryExtractionSnapshot;
    cursor: MessageId | undefined;
    signal: AbortSignal;
    continuation: boolean;
  }) => Promise<ExtractionResult>,
  logger?: Logger,
  sessionId?: string,
): ProjectMemoryExtractionScheduler {
  let cursor: MessageId | undefined;
  let latestPending: Promise<ProjectMemoryExtractionSnapshot | undefined> | undefined;
  let running: Promise<void> | undefined;
  let shuttingDown = false;
  const controller = new AbortController();

  const run = async (
    first: Promise<ProjectMemoryExtractionSnapshot | undefined>,
  ): Promise<void> => {
    let current: Promise<ProjectMemoryExtractionSnapshot | undefined> | undefined = first;
    let continuation = false;
    try {
      while (current && !shuttingDown) {
        let snapshot: ProjectMemoryExtractionSnapshot | undefined;
        try {
          snapshot = await current;
        } catch {
          snapshot = undefined;
        }
        if (snapshot && !shuttingDown) {
          try {
            const result = await execute({
              snapshot,
              cursor,
              signal: controller.signal,
              continuation,
            });
            if (!shuttingDown && result.processedBoundary) {
              cursor = result.processedBoundary;
              const processedIndex = snapshot.durableMessages.findIndex(
                (message) => message.info.id === result.processedBoundary,
              );
              const boundaryIndex = snapshot.durableMessages.findIndex(
                (message) => message.info.id === snapshot.boundaryMessageId,
              );
              if (processedIndex >= 0 && processedIndex < boundaryIndex) {
                current = Promise.resolve(snapshot);
                continuation = true;
                continue;
              }
            }
            continuation = false;
          } catch {
            // Failed extraction leaves the cursor in place so a later turn can retry the evidence.
            continuation = false;
          }
        } else {
          continuation = false;
        }
        current = latestPending;
        latestPending = undefined;
      }
    } finally {
      if (shuttingDown) latestPending = undefined;
      running = undefined;
    }
  };

  return {
    async drain() {
      while (running) await running;
    },
    getCursor: () => cursor,
    hasPendingWork: () => running !== undefined || latestPending !== undefined,
    schedule(snapshot) {
      if (shuttingDown) return;
      const acquisition = Promise.resolve(snapshot).catch((error) => {
        if (!shuttingDown) {
          logger?.warn("Experience memory snapshot acquisition failed", {
            error: error instanceof Error ? error.message : String(error),
            event: "memory.extraction.snapshot_failed",
            sessionId,
          });
        }
        return undefined;
      });
      if (running) {
        latestPending = acquisition;
      } else {
        running = run(acquisition);
      }
    },
    shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      latestPending = undefined;
      controller.abort();
    },
  };
}

async function executeProjectMemoryExtraction(
  runtime: AgentRuntimeInternal,
  snapshot: ProjectMemoryExtractionSnapshot,
  cursor: MessageId | undefined,
  signal: AbortSignal,
  continuation = false,
): Promise<ExtractionResult> {
  const transcriptMessages = messagesAfterCursor(snapshot.durableMessages, cursor);
  if (!continuation && !transcriptMessages.some(isExtractionTrigger)) {
    return { status: "no-op", processedBoundary: snapshot.boundaryMessageId };
  }

  const telemetry = runtime.agentTelemetry.detached({
    causation: snapshot.causation,
    executionKind: "background",
    operation: "project_memory_extract",
    targetKind: "project_memory",
    traceContext: snapshot.traceContext,
    trigger: "scheduler",
  });

  return telemetry.run(async () => {
    try {
      if (signal.aborted) {
        telemetry.finishCancelled("abort_signal");
        return { status: "aborted" };
      }
      const promptResult = buildStructuredExtractionPrompt(snapshot.durableMessages, cursor);
      const messages = buildProjectMemoryAgentProviderMessages(promptResult.prompt);
      const executor = createProjectMemoryAgentToolExecutor(runtime, snapshot);
      let executedAny = false;
      let failedAny = false;
      let completed = false;

      for (let step = 0; step < EXTRACTION_MAX_STEPS; step += 1) {
        signal.throwIfAborted();
        const response = await snapshot.model.generateText({
          abortSignal: signal,
          messages,
          options: auxiliaryModelOptions(snapshot.model),
          toolChoice: "required",
          tools: [...snapshot.tools],
        });
        const toolCalls = response.toolCalls ?? [];
        if (response.text.trim()) {
          // 文本中的 JSON 不是写入；即使同组含结束工具，也不能把未执行的操作当成完成。
          failedAny = true;
          break;
        }
        messages.push(assistantMessage(response.text, toolCalls));
        if (toolCalls.length === 0) {
          // 真实模型可能把 Memory 调用写成 JSON 文本；文本不是已执行的工具调用，不能据此推进游标。
          failedAny = true;
          break;
        }
        const finishIndex = toolCalls.findIndex(
          (call) => call.name === FINISH_MEMORY_EXTRACTION_TOOL_NAME,
        );
        if (finishIndex >= 0 && finishIndex !== toolCalls.length - 1) {
          // 结束信号之后不能再执行写入；整组调用先拒绝，避免提交后又宣称提取已完成。
          failedAny = true;
          break;
        }

        for (const toolCall of toolCalls) {
          signal.throwIfAborted();
          if (toolCall.name === FINISH_MEMORY_EXTRACTION_TOOL_NAME) {
            if (!isValidFinishMemoryExtractionInput(toolCall.input)) {
              failedAny = true;
              break;
            }
            completed = true;
            continue;
          }
          if (toolCall.name !== "Memory") {
            failedAny = true;
            messages.push(
              toolErrorMessage(toolCall, "Only Memory and FinishMemoryExtraction are available."),
            );
            continue;
          }
          const result = await executor.execute(
            {
              id: extractionToolCallId(toolCall),
              name: toolCall.name,
              input: toolCall.input,
            },
            { signal, traceContext: snapshot.traceContext },
          );
          executedAny ||= result.success;
          failedAny ||= !result.success;
          messages.push({
            content: modelContentForToolResult(result),
            isError: isErrorForToolResult(result),
            role: "tool",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          });
        }
        if (completed || failedAny) break;
      }

      if (failedAny || !completed) {
        // 写入失败或模型未明确结束时保留游标，让后续提取能够再次处理同一批证据。
        telemetry.finishFailed("execute", "internal", new Error("Memory extraction did not complete."));
        return { status: "error" };
      }
      telemetry.finishCompleted();
      return {
        status: executedAny ? "success" : "no-op",
        processedBoundary: promptResult.processedBoundary,
      };
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        telemetry.finishCancelled("abort_signal");
        return { status: "aborted" };
      }
      telemetry.finishFailed("execute", "internal", error);
      return { status: "error" };
    }
  });
}

function isValidFinishMemoryExtractionInput(input: unknown): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const fields = Object.keys(input);
  return (
    fields.length === 1 &&
    fields[0] === "reason" &&
    typeof (input as { reason?: unknown }).reason === "string"
  );
}

function messagesAfterCursor(
  messages: readonly MessageWithParts[],
  cursor: MessageId | undefined,
): readonly MessageWithParts[] {
  if (!cursor) return messages;
  const cursorIndex = messages.findIndex((message) => message.info.id === cursor);
  return cursorIndex < 0 ? messages : messages.slice(cursorIndex + 1);
}

function isExtractionTrigger(message: MessageWithParts): boolean {
  if (message.info.role !== "user") return false;
  if (message.info.source === "subagent") return true;
  if (message.info.synthetic === true || message.info.visibility === "model-only") return false;
  if (message.info.source !== undefined) return false;
  if (message.info.semantics && message.info.semantics.origin !== "real_user") return false;
  if (
    message.info.semantics &&
    (message.info.semantics.uiVisibility !== "visible" ||
      message.info.semantics.providerVisibility !== "visible" ||
      message.info.semantics.transcriptVisibility !== "visible")
  ) {
    return false;
  }
  if (message.info.anchor && message.info.anchor.origin !== "realUser") return false;
  return message.parts.some(
    (part) => part.type === "text" && part.ignored !== true && part.synthetic !== true,
  );
}

function assistantMessage(text: string, calls: readonly ModelToolCall[]): ModelInputMessage {
  return {
    content: text,
    role: "assistant",
    ...(calls.length > 0
      ? {
          toolCalls: calls.map((call) => ({
            id: call.id,
            name: call.name,
            input: call.input,
          })),
        }
      : {}),
  };
}

function toolErrorMessage(call: ModelToolCall, message: string): ModelInputMessage {
  return {
    content: message,
    isError: true,
    role: "tool",
    toolCallId: call.id,
    toolName: call.name,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
