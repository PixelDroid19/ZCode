import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import {
  HookEventName,
  SessionEventType,
  TurnMachineImpl,
  createModelUsageSummaryFromEvents,
  type HookRunResult,
  type MessagePart,
} from "../deps.js";
import {
  buildRuntimeUserEntriesFromTurn,
  buildUserContentFromTurn,
  logResolvedTurnAttachments,
  resolveTurnAttachments,
  runtimeMetadataForSyntheticUserMessageSource,
} from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { TurnResult } from "../types.js";
import { maybeStartSessionTitleGeneration } from "./session-title.js";
import type {
  RegularTurnLifecycleContext,
  RegularTurnLifecycleState,
} from "./turn-command-lifecycle-types.js";
import {
  injectDateChangeReminderIntoMessageHistory,
  injectReferencedSessionContextReminderIntoMessageHistory,
} from "./turn-reminders.js";
import { recordTurnUsageFact } from "./usage-observability.js";

/** Runs hook admission, user-message persistence, and loop-state construction in causal order. */
export async function prepareRegularTurnLoop(
  runtime: AgentRuntimeInternal,
  context: RegularTurnLifecycleContext,
  state: RegularTurnLifecycleState,
): Promise<TurnResult | undefined> {
  let phaseStartedAt = context.startTurnPhase("user_prompt_hooks");
  const userPromptHookResult: HookRunResult = context.options?.skipUserPromptSubmitHooks
    ? { additionalContexts: [] }
    : await runtime.runUserPromptSubmitHooks(
        context.input,
        context.attachments,
        context.turnTraceContext,
        context.turnAbortSignal,
      );
  context.completeTurnPhase("user_prompt_hooks", phaseStartedAt);
  if (userPromptHookResult.preventContinuation) {
    const response = userPromptHookResult.stopReason ?? "Prompt blocked by UserPromptSubmit hook.";
    if (state.activeTurn) state.activeTurn.steerable = false;
    state.turnMachine = new TurnMachineImpl(state.turnMachine.complete(response, "success"));
    const turnUsage = createModelUsageSummaryFromEvents(context.events);
    const completeEvent = runtime.createEvent(
      SessionEventType.TurnComplete,
      {
        response,
        tokenCount: 0,
        usage: turnUsage,
        toolCallCount: 0,
        duration: Date.now() - state.turnMachine.state.startedAt.getTime(),
        resultType: "success",
        cacheStats: runtime.messageHistory.getCacheStats(),
        inputId: context.options?.inputId,
      },
      context.turnTraceContext,
    );
    await runtime.appendEvent(completeEvent, context.turnTraceContext);
    context.events.push(completeEvent);
    await recordTurnUsageFact(runtime, {
      completedAt: Date.now(),
      events: context.events,
      startedAt: context.turnStartedAtMs,
      status: "completed",
      traceContext: context.turnTraceContext,
      turnId: context.turnId,
    });
    runtime.turnNumber++;
    const projection = await runtime.rebuildProjection();
    await runtime.accountTargetTurnCompletion({
      inputID: context.targetRunInputID,
      startedAtMs: context.turnStartedAtMs,
      startedTarget: state.startedTarget,
      traceContext: context.turnTraceContext,
      usage: turnUsage,
    });
    return {
      response,
      turnId: context.turnId,
      traceId: context.traceId,
      usage: turnUsage,
      events: context.events,
      projection,
    };
  }

  runtime.injectHookAdditionalContextIntoMessageHistory(
    HookEventName.UserPromptSubmit,
    userPromptHookResult.additionalContexts,
  );
  injectReferencedSessionContextReminderIntoMessageHistory(runtime, context.input, context.options);
  injectDateChangeReminderIntoMessageHistory(runtime);
  const resolvedAttachments = await resolveTurnAttachments(context.attachments, {
    abortSignal: context.turnAbortSignal,
    artifactStore: runtime.artifactStore,
    fileSystemPort: runtime.fileSystemPort,
    imageProcessorPort: runtime.imageProcessorPort,
    sessionId: runtime.sessionId,
    traceContext: context.turnTraceContext,
    turnId: context.turnId,
    workingDirectory: runtime.workingDirectory,
  });
  logResolvedTurnAttachments(runtime.logger, context.turnTraceContext, resolvedAttachments);
  await hydrateSharedContextIfNeeded(runtime, context);
  await runtime.persistPendingModelChangeTimeline(context.turnTraceContext);
  await persistTurnUserInput(runtime, context, resolvedAttachments, state);
  await injectPluginReminder(runtime, context);

  runtime.messageHistory.setCacheMiss();
  const loopModel = context.submissionModel ?? context.admittedModel;
  if (!loopModel) {
    throw new Error("Turn model was not created before execution");
  }
  state.loopState = {
    activeTurn: state.activeTurn,
    ...(context.options?.automationId ? { automationId: context.options.automationId } : {}),
    // 闲时派发轮的身份进入 loop state，供工具执行边界 deny OffPeakCreate。
    ...(context.options?.offPeakTaskId ? { offPeakTaskId: context.options.offPeakTaskId } : {}),
    anomalyWarningsInjected: 0,
    backgroundSubagentResultConsumed: context.options?.backgroundSubagentResultConsumed === true,
    workflowResultConsumed: context.options?.workflowResultConsumed === true,
    currentUserMessageId: context.userMessageId,
    events: context.events,
    input: context.input,
    modelResponse: "",
    model: loopModel,
    ...(context.options?.modelExecution?.selectionScope === "execution"
      ? { modelSelectionScope: "execution" as const }
      : {}),
    ...(context.options?.modelExecution?.subagents && context.options.intent?.modelSelection
      ? {
          subagentModelOverride: {
            selection: context.options.intent.modelSelection,
            requestDependencies: context.options.modelExecution.requestDependencies,
            background: context.options.modelExecution.subagents.background,
          },
        }
      : {}),
    modelStepCount: 0,
    historyRoundCount: 0,
    reactiveCompactAttemptedInCurrentModelStep: false,
    repeatedToolCallSignature: undefined,
    repeatedToolCallStreakCount: 0,
    stopHookContinuationCount: 0,
    streamRecoveryRetryCount: 0,
    tokenCount: 0,
    toolCallCount: 0,
    turnRequestState: {
      // Turn 只借一次 canonical 成员集合，之后由显式 commit 推进；entry 本身遵循不可变约定。
      entries: [...runtime.messageHistory.borrowReadOnlyRuntimeEntries()],
      outputTokenContinuationCount: 0,
    },
    toolDisallowlist: context.options?.toolDisallowlist,
    traceId: context.traceId,
    turnAbortSignal: context.turnAbortSignal,
    turnId: context.turnId,
    turnMachine: state.turnMachine,
    turnOutputStyle: context.admittedOutputStyle,
    turnTraceContext: context.turnTraceContext,
    userMessageId: context.userMessageId,
  };
  return undefined;
}

async function hydrateSharedContextIfNeeded(
  runtime: AgentRuntimeInternal,
  context: RegularTurnLifecycleContext,
): Promise<void> {
  const sharedContextRefs =
    context.options?.sharedContextRefs ?? context.options?.intent?.sharedContextRefs;
  if (!sharedContextRefs || sharedContextRefs.length === 0) return;
  const [reference] = sharedContextRefs;
  if (!reference || reference.kind !== "shared_context_import") {
    throw new Error("invalid shared context reference");
  }
  if (!runtime.sessionStore) throw new Error("shared context import storage is unavailable");
  const alreadyHydrated = runtime.messageHistory
    .borrowReadOnlyRuntimeEntries()
    .some((entry) => entry.kind !== "attachment" && entry.metadata?.source === "shared_context");
  if (alreadyHydrated) return;
  const importedMessages = await runtime.sessionStore.messages({ sessionID: runtime.sessionId });
  const contextMessage = importedMessages.find(
    (message) =>
      message.info.role === "user" &&
      message.info.source === "shared_context" &&
      message.info.metadata &&
      typeof message.info.metadata === "object" &&
      (message.info.metadata as Record<string, unknown>).contextId === reference.context_id,
  );
  const contextText = contextMessage?.parts
    .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (!contextText) throw new Error("shared context content is unavailable");
  runtime.messageHistory.addUser(
    contextText,
    runtimeMetadataForSyntheticUserMessageSource("shared_context"),
  );
}

async function persistTurnUserInput(
  runtime: AgentRuntimeInternal,
  context: RegularTurnLifecycleContext,
  resolvedAttachments: Awaited<ReturnType<typeof resolveTurnAttachments>>,
  state: RegularTurnLifecycleState,
): Promise<void> {
  if (
    context.options?.skipInputRecord !== true &&
    context.options?.inputVisibility === "model-only"
  ) {
    const inputSource = context.options.inputSource ?? "goal-continuation";
    const userContent = buildUserContentFromTurn(context.input, resolvedAttachments);
    runtime.messageHistory.addUser(
      userContent,
      runtimeInputMetadata(context.options.inputPresentation) ??
        runtimeMetadataForSyntheticUserMessageSource(inputSource),
    );
    await runtime.persistSyntheticUserNoticeForSession({
      messageID: context.userMessageId,
      metadata: {
        ...(context.options.targetId ? { targetId: context.options.targetId } : {}),
        ...(context.options.inputPresentation
          ? { inputPresentation: context.options.inputPresentation }
          : {}),
        visibility: "model-only",
      },
      sessionId: runtime.sessionId,
      source: inputSource,
      text: context.input,
      traceContext: context.turnTraceContext,
      visibility: "model-only",
    });
    return;
  }
  if (context.options?.skipInputRecord === true) return;
  runtime.messageHistory.addEntries(
    buildRuntimeUserEntriesFromTurn(context.input, resolvedAttachments, {
      browserAmbientContext: context.options?.browserAmbientContext,
    }).map((entry) => {
      const metadata = runtimeInputMetadata(context.options?.inputPresentation);
      return entry.kind !== "attachment" && metadata ? { ...entry, metadata } : entry;
    }),
  );
  await runtime.persistUserPrompt(
    context.userMessageId,
    context.displayInput,
    resolvedAttachments,
    context.turnTraceContext,
    {
      intent: context.options?.intent,
      inputPresentation: context.options?.inputPresentation,
      sessionInputId: context.options?.intent?.queueItemId,
      sourceCommandId: context.options?.inputId,
      ...(context.options?.epilogueStart === undefined
        ? {}
        : { epilogueStart: context.options.epilogueStart }),
    },
  );
  const titleGenerationStarted = maybeStartSessionTitleGeneration.call(
    runtime,
    context.displayInput,
    context.userMessageId,
    context.turnTraceContext,
    { deferIfProviderRuntimeHeadersRefresh: true },
  );
  state.shouldRetryTitleGenerationAfterTurn = !titleGenerationStarted;
}

async function injectPluginReminder(
  runtime: AgentRuntimeInternal,
  context: RegularTurnLifecycleContext,
): Promise<void> {
  // Only a persisted canonical user input may create a plugin-reference reminder.
  if (context.options?.inputVisibility === "model-only") return;
  await runtime.injectPluginReferenceReminderFromTurn(
    context.displayInput,
    context.turnTraceContext,
    context.options?.toolDisallowlist,
  );
}
