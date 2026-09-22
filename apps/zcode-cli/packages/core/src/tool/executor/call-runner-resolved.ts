import type {
  SessionEvent,
  SkillTelemetryMetadata,
  ToolExecutionSpanWriter,
  TraceContext,
  TraceId,
  TurnId,
} from "@zcode/contracts";
import { CoreErrorType, createCoreError, traceContextToLogContext } from "@zcode/contracts";
import {
  OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  attestOfficialCuaFrameContent,
} from "@zcode/zcode-cua/frame-contract";
import { resolveEmbeddedSearchBranchCapability } from "../../embedded-search/capability.js";
import { mergeToolExecutionTelemetry, readToolExecutionTelemetry } from "../handlers/tool-perf.js";
import type {
  ExecutableToolCall,
  ToolEntry,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../types.js";
import type { BackgroundTaskTracker } from "./background-tasks.js";
import { resolveModelOutputEntry } from "./call-runner-model-output.js";
import { finishToolCallFailure } from "./call-runner-failure.js";
import { failedBashExecutionOutcome, readBashExecutionOutcome } from "./bash-execution-outcome.js";
import {
  createErrorResult,
  createToolHandlerFailureError,
  isToolHandlerFailure,
  isToolHandlerFailureError,
} from "./errors.js";
import { emitToolCallError, emitToolCallResult, emitToolCallStarted } from "./events.js";
import {
  formatHookAdditionalContexts,
  runPostToolUseFailureHooks,
  runPostToolUseHooks,
  runPreToolUseHooks,
} from "./hook-flow.js";
import { createToolModelStatusSink, withDefaultToolModelStatusSink } from "./model-status-sink.js";
import { resolveToolCallCapabilityFlags } from "./permission-capability.js";
import { createMcpToolDisplay, createToolResultDisplay } from "./result-display.js";
import { appendHookAdditionalContexts, serializeOutput } from "./result-serialization.js";
import {
  ToolDeadline,
  executeWithTimeout,
  linkAbortSignal,
  observeToolAdmissionClock,
  resolveTimeoutMs,
} from "./timeout.js";
import { withAutomationCreateLimitTurnStop, withTerminalToolTurnStop } from "./turn-control.js";
import type { ToolExecuteOptions, ToolExecutorDeps } from "./types.js";
import { validateOutput } from "./validation.js";

export async function executeResolvedToolCall(
  deps: ToolExecutorDeps,
  backgroundTasks: BackgroundTaskTracker,
  canonicalToolCall: ExecutableToolCall,
  entry: ToolEntry,
  executionInput: unknown,
  preToolHookResult: Awaited<ReturnType<typeof runPreToolUseHooks>>,
  permissionWaitMs: number | undefined,
  totalStartedAt: number,
  traceContext: TraceContext,
  traceId: TraceId,
  turnId: TurnId | undefined,
  options?: ToolExecuteOptions,
  telemetry?: ToolExecutionSpanWriter,
): Promise<ToolExecutionResult> {
  const startTime = Date.now();
  const model = options?.model ?? deps.model;
  // 按**执行入参**解析一次副作用旗标（Bash 的只读命令判定就在这里落定），随 ToolCallStarted 发出：
  // 事件先于 handler，所以订阅者（dynamic-workflow driver 的导入缓存关门）在第一个字节落盘前就知道。
  await emitToolCallStarted(
    deps,
    canonicalToolCall,
    traceContext,
    turnId,
    startTime,
    createMcpToolDisplay(entry.metadata.mcpPresentation),
    resolveToolCallCapabilityFlags(deps, entry, executionInput),
  );

  deps.logger?.info("Tool call started", {
    ...traceContextToLogContext(traceContext),
    event: "tool.call.started",
    module: "core.tool.executor",
    status: "started",
    toolCallId: canonicalToolCall.id,
    toolName: canonicalToolCall.name,
  });

  const timeoutMs = resolveTimeoutMs(entry, executionInput, deps.defaultTimeoutMs, {
    model,
  });
  const executionAbortController = new AbortController();
  const unlinkParentAbort = linkAbortSignal(options?.signal, executionAbortController);
  // 可暂停的 deadline：本次调用内部的模型请求在准入闸门前排队时暂停计时。排队的两端
  // 以本 toolCallId 的 ModelNetworkStatus 会话事件到达，所以在事件出口拦一层即可，handler 无感。
  const deadline = new ToolDeadline(timeoutMs);
  const emitEvent =
    deps.emitEvent === undefined
      ? undefined
      : async (event: SessionEvent): Promise<void> => {
          observeToolAdmissionClock(event, canonicalToolCall.id, deadline);
          await deps.emitEvent(event);
        };
  let readFileStateMetadata: ToolExecutionResult["readFileStateMetadata"];
  let bashExecutionOutcome: ToolExecutionResult["executionOutcome"];
  let failureStage: "handler" | "serialize" | "post_hook" = "handler";
  let skillTelemetryMetadata: SkillTelemetryMetadata | undefined;

  try {
    const suppliedMemoryAccess = deps.getMemoryAccess?.();
    const bashShellSelection = deps.getBashShellSelection?.() ?? deps.bashShellSelection;
    const embeddedSearchDecision = resolveEmbeddedSearchBranchCapability({
      bashAvailable: deps.registry.has("Bash"),
    });
    const context: ToolExecutionContext = {
      toolCallId: canonicalToolCall.id,
      telemetry,
      automationTurn: options?.automationTurn,
      offPeakTurn: options?.offPeakTurn,
      traceContext,
      traceId,
      spanId: traceContext.spanId,
      parentSpanId: traceContext.parentSpanId,
      abortSignal: executionAbortController.signal,
      backgroundTaskControlPort: deps.backgroundTaskControlPort,
      emitEvent,
      executionPort: deps.executionPort,
      browserControlPort: deps.getBrowserControlPort
        ? deps.getBrowserControlPort()
        : deps.browserControlPort,
      browserDocumentationRoot: deps.getBrowserDocumentationRoot
        ? deps.getBrowserDocumentationRoot()
        : deps.browserDocumentationRoot,
      fileSystemPort: deps.fileSystemPort,
      httpClientPort: deps.httpClientPort,
      imageProcessorPort: deps.imageProcessorPort,
      pdfDocumentPort: deps.pdfDocumentPort,
      // 工具内部的模型请求默认把状态事件发进会话：deadline 暂停与 driver 相位都靠这条流。
      model: withDefaultToolModelStatusSink(
        model,
        createToolModelStatusSink({ emitEvent, sessionId: deps.sessionId, turnId, traceId }),
      ),
      subagentModelOverride: options?.subagentModelOverride,
      embeddedSearch: {
        ...(deps.embeddedSearchBackend ? { backend: deps.embeddedSearchBackend } : {}),
        enabled: embeddedSearchDecision?.useEmbeddedSearchBranch ?? false,
        ...(deps.nativeSearchEnhancementsEnabled === false ? { findAndGrepEnabled: false } : {}),
      },
      skillPort: deps.getSkillPort ? deps.getSkillPort() : deps.skillPort,
      subagentPort: deps.getSubagentPort ? deps.getSubagentPort() : deps.subagentPort,
      coordinatorResponsePort: deps.coordinatorResponsePort,
      workflowSubmitPort: deps.workflowSubmitPort,
      workflowEscalatePort: deps.workflowEscalatePort,
      artifactStore: deps.artifactStore,
      automationPort: deps.automationPort,
      offPeakPort: deps.offPeakPort,
      sessionStore: deps.sessionStore,
      sessionModePort: deps.sessionModePort,
      workflowPort: deps.workflowPort,
      dynamicWorkflowRunPort: deps.dynamicWorkflowRunPort,
      dynamicWorkflowSnippetPort: deps.dynamicWorkflowSnippetPort,
      modelCatalogPort: deps.modelCatalogPort,
      runtimeTaskRegistry: deps.runtimeTaskRegistry,
      readFileState: deps.readFileState,
      recordReadFileStateMetadata: (metadata) => {
        readFileStateMetadata = metadata;
      },
      recordSkillTelemetryMetadata: (metadata) => {
        skillTelemetryMetadata = metadata;
      },
      bashShellSelection,
      setWorkingDirectory: deps.setWorkingDirectory,
      workingDirectory: deps.getWorkingDirectory(),
      workspaceRoot: deps.getWorkspaceRoot(),
      workspaceIdentity: deps.workspaceIdentity,
      remoteSessionId: deps.remoteSessionId,
      clientMode: deps.clientMode,
      deliveryKind: deps.deliveryKind,
      memoryRoot: deps.getMemoryRoot?.(),
      memoryStore: deps.memoryStore,
      memoryAccess: suppliedMemoryAccess
        ? {
            ...suppliedMemoryAccess,
            traceContext,
            signal: executionAbortController.signal,
          }
        : undefined,
      runtimeScope: deps.runtimeScope,
      providerVisibleToolNames: deps.registry
        .list()
        .filter((name) => deps.registry.getMetadata(name)?.providerVisible !== false),
      sessionId: deps.sessionId,
      turnId,
    };

    const output = await executeWithTimeout(
      entry.handler,
      executionInput,
      context,
      deadline,
      executionAbortController,
      entry,
    );
    if (canonicalToolCall.name === "Bash") {
      bashExecutionOutcome = readBashExecutionOutcome(
        output,
        true,
        executionAbortController.signal,
      );
    }
    const durationMs = Date.now() - startTime;
    if (isToolHandlerFailure(output)) {
      // handler 用返回值表达可预期业务失败；这里只转换到既有异常控制流，
      // 继续复用原来的 failure hook、事件和日志，不引入第二套执行生命周期。
      throw createToolHandlerFailureError(canonicalToolCall, output);
    }
    validateOutput(output, entry);
    // node_repl 同时承载 Browser Use 与 CUA，不能在注册时把整个 server 标成 official。
    // CUA SDK 结果带 producer integrity metadata 时，才为本次序列化临时打开原子帧保护；
    // 否则通用 resultBudget 会截断/重排 image_ref，或非 authority 路径会把引用剥掉。
    const modelOutputEntry = resolveModelOutputEntry(entry, output);
    failureStage = "serialize";
    let serialization = await serializeOutput(
      deps,
      output,
      modelOutputEntry,
      traceContext,
      canonicalToolCall.id,
      executionAbortController.signal,
    );
    failureStage = "post_hook";
    const postToolHookResult = await runPostToolUseHooks(
      deps,
      canonicalToolCall,
      executionInput,
      output,
      serialization.artifactPath,
      traceContext,
      options?.signal,
    );
    serialization = appendHookAdditionalContexts(
      serialization,
      [...preToolHookResult.additionalContexts, ...postToolHookResult.additionalContexts],
      modelOutputEntry,
    );
    const display = createToolResultDisplay(canonicalToolCall.name, output, {
      mcp: entry.metadata.mcpPresentation,
      officialCua: entry.modelContentProtection === OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
    });
    const perf = mergeToolExecutionTelemetry(readToolExecutionTelemetry(output), {
      permissionWaitMs,
      // totalMs 是用户感知的工具生命周期：registry lookup、校验、Hook、权限等待、
      // handler、序列化与 PostToolUse。durationMs 继续只表示 handler 主执行段。
      totalMs: Date.now() - totalStartedAt,
    });

    const finalModelContent = serialization.modelContent ?? serialization.content;
    const modelContentProtection = modelOutputEntry.modelContentProtection
      ? attestOfficialCuaFrameContent(finalModelContent, modelOutputEntry.modelContentProtection)
      : undefined;
    if (
      modelOutputEntry.modelContentProtection &&
      Array.isArray(finalModelContent) &&
      finalModelContent.some((block) => block.type === "image") &&
      !modelContentProtection
    ) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        "Official CUA frame failed final model-content attestation",
        { recoverable: true },
      );
    }

    const result: ToolExecutionResult = withTerminalToolTurnStop(
      {
        toolCallId: canonicalToolCall.id,
        toolName: canonicalToolCall.name,
        success: true,
        output,
        ...(bashExecutionOutcome ? { executionOutcome: bashExecutionOutcome } : {}),
        display,
        modelContent: finalModelContent,
        ...(readFileStateMetadata ? { readFileStateMetadata } : {}),
        performance: perf,
        serialization,
        durationMs,
        startedAt: new Date(startTime),
        completedAt: new Date(),
      },
      { entry },
    );

    await emitToolCallResult(
      deps,
      canonicalToolCall,
      traceContext,
      turnId,
      serialization,
      durationMs,
      display,
      perf,
      skillTelemetryMetadata,
    );

    await backgroundTasks.trackBackgroundTask(canonicalToolCall, output, traceContext, turnId);

    deps.logger?.info("Tool call completed", {
      ...traceContextToLogContext(traceContext),
      durationMs,
      event: "tool.call.completed",
      module: "core.tool.executor",
      status: "completed",
      toolCallId: canonicalToolCall.id,
      toolName: canonicalToolCall.name,
    });

    telemetry?.setOutputBytes(serialization.returnedBytes);
    telemetry?.setOutputTruncated(serialization.truncated);
    telemetry?.finishCompleted();
    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const failureHookResult = await runPostToolUseFailureHooks(
      deps,
      canonicalToolCall,
      executionInput,
      error,
      traceContext,
      options?.signal,
    );
    let result = createErrorResult(
      canonicalToolCall,
      error instanceof Error ? error : new Error(String(error)),
      durationMs,
    );
    if (canonicalToolCall.name === "Bash") {
      const aborted =
        executionAbortController.signal.aborted ||
        options?.signal?.aborted === true ||
        result.error?.type === CoreErrorType.ToolCancelled ||
        (error instanceof Error && error.name === "AbortError");
      result.executionOutcome = failedBashExecutionOutcome(bashExecutionOutcome, aborted);
    }
    const baseModelContent = result.error
      ? isToolHandlerFailureError(error) && typeof result.modelContent === "string"
        ? result.modelContent
        : result.error.message
      : undefined;
    if (failureHookResult.additionalContexts.length > 0 && baseModelContent) {
      result.modelContent = [
        baseModelContent,
        formatHookAdditionalContexts([
          ...preToolHookResult.additionalContexts,
          ...failureHookResult.additionalContexts,
        ]),
      ].join("\n\n");
    } else if (preToolHookResult.additionalContexts.length > 0 && baseModelContent) {
      result.modelContent = [
        baseModelContent,
        formatHookAdditionalContexts(preToolHookResult.additionalContexts),
      ].join("\n\n");
    }
    result = withAutomationCreateLimitTurnStop(result, {
      error,
      toolName: canonicalToolCall.name,
    });

    // Skill 已解析成功后，serialize/post_hook 仍可能失败；错误事件也要保留
    // resolved metadata，否则失败的 Skill agent_step 无法归因到具体 skill。
    await emitToolCallError(
      deps,
      canonicalToolCall.id,
      traceContext,
      turnId,
      result.error,
      skillTelemetryMetadata,
    );

    finishToolCallFailure({
      deps,
      toolCall: canonicalToolCall,
      traceContext,
      result,
      error,
      durationMs,
      failureStage,
      options,
      telemetry,
    });
    return result;
  } finally {
    unlinkParentAbort();
  }
}
