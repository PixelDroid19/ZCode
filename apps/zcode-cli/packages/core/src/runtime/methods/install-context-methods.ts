import {
  buildContextUsageBreakdownFromSnapshot,
  buildContextUsageCategory,
  buildContextUsageSnapshot,
  buildMessageRoleBreakdown,
  buildModelMessageTailDiagnostics,
  buildSkillUsageDetails,
  buildToolUsageDetail,
  estimatedMetric,
  estimatedMetricFromKnown,
  logContextUsageSnapshot,
  logModelRequestSteeringContext,
  sumMetrics,
} from "./context-usage.js";
import {
  createConfigOnlyContextSnapshot,
  createContextBuilderFromSnapshot,
  discoverSkillsForContext,
  ensureContextInitialized,
  extractToolCallsFromResult,
  getSkillCatalog,
  initializeMessageHistoryFromContext,
  loadProjectMemoryRoot,
  logMemorySkipped,
  shouldStreamModelText,
} from "./context.js";
import { recordGoalStateChangeReminder } from "./goal-state-reminder.js";
import {
  injectHookAdditionalContextIntoMessageHistory,
  runSessionStartHooks,
  runStopHooks,
  runUserPromptSubmitHooks,
  shouldContinueAfterStopHooks,
} from "./hooks.js";
import { initializeMcp, startMcpStartup } from "./mcp.js";
import { createModelStatusSink, logModelNetworkStatus } from "./model-status.js";
import { emitModelStreamingEvent } from "./model-streaming-event.js";
import { runModelTextRequest } from "./model.js";
import { injectPluginReferenceReminderFromTurn } from "./plugin-reference.js";
import {
  injectTargetStateIntoMessageHistory,
  readSessionTargetForContext,
  readSessionTodosForContext,
  resumeFromStore,
  toScheduleState,
} from "./resume.js";
import { createDefaultSubagentPort } from "./subagent.js";
import { continueActiveTargetLoop } from "./target-continuation-loop.js";
import {
  accountTargetTurnCompletion,
  activatePausedTargetAfterResume,
  continueActiveTargetIfIdle,
  finishTargetTurnAccounting,
  heartbeatTargetTurnAccounting,
  pauseActiveTargetForCancellation,
  recordTargetChanged,
  startTargetTurnAccounting,
  targetContinuationCandidate,
} from "./target.js";

export function installRuntimeContextMethods(proto: Record<string, unknown>): void {
  proto.createDefaultSubagentPort = createDefaultSubagentPort;
  proto.ensureContextInitialized = ensureContextInitialized;
  proto.getSkillCatalog = getSkillCatalog;
  proto.createContextBuilderFromSnapshot = createContextBuilderFromSnapshot;
  proto.loadProjectMemoryRoot = loadProjectMemoryRoot;
  proto.logMemorySkipped = logMemorySkipped;
  proto.injectPluginReferenceReminderFromTurn = injectPluginReferenceReminderFromTurn;
  proto.initializeMcp = initializeMcp;
  proto.startMcpStartup = startMcpStartup;
  proto.discoverSkillsForContext = discoverSkillsForContext;
  proto.createConfigOnlyContextSnapshot = createConfigOnlyContextSnapshot;
  proto.initializeMessageHistoryFromContext = initializeMessageHistoryFromContext;
  proto.extractToolCallsFromResult = extractToolCallsFromResult;
  proto.shouldStreamModelText = shouldStreamModelText;
  proto.runModelTextRequest = runModelTextRequest;
  proto.emitModelStreamingEvent = emitModelStreamingEvent;
  proto.createModelStatusSink = createModelStatusSink;
  proto.logModelNetworkStatus = logModelNetworkStatus;
  proto.logContextUsageSnapshot = logContextUsageSnapshot;
  proto.logModelRequestSteeringContext = logModelRequestSteeringContext;
  proto.buildModelMessageTailDiagnostics = buildModelMessageTailDiagnostics;
  proto.buildContextUsageSnapshot = buildContextUsageSnapshot;
  proto.buildContextUsageBreakdownFromSnapshot = buildContextUsageBreakdownFromSnapshot;
  proto.buildContextUsageCategory = buildContextUsageCategory;
  proto.buildToolUsageDetail = buildToolUsageDetail;
  proto.buildSkillUsageDetails = buildSkillUsageDetails;
  proto.buildMessageRoleBreakdown = buildMessageRoleBreakdown;
  proto.estimatedMetric = estimatedMetric;
  proto.estimatedMetricFromKnown = estimatedMetricFromKnown;
  proto.sumMetrics = sumMetrics;
  proto.toScheduleState = toScheduleState;
  proto.resumeFromStore = resumeFromStore;
  proto.readSessionTodosForContext = readSessionTodosForContext;
  proto.readSessionTargetForContext = readSessionTargetForContext;
  proto.injectTargetStateIntoMessageHistory = injectTargetStateIntoMessageHistory;
  proto.recordTargetChanged = recordTargetChanged;
  proto.recordGoalStateChangeReminder = recordGoalStateChangeReminder;
  proto.continueActiveTargetIfIdle = continueActiveTargetIfIdle;
  proto.continueActiveTargetLoop = continueActiveTargetLoop;
  proto.targetContinuationCandidate = targetContinuationCandidate;
  proto.accountTargetTurnCompletion = accountTargetTurnCompletion;
  proto.startTargetTurnAccounting = startTargetTurnAccounting;
  proto.heartbeatTargetTurnAccounting = heartbeatTargetTurnAccounting;
  proto.finishTargetTurnAccounting = finishTargetTurnAccounting;
  proto.pauseActiveTargetForCancellation = pauseActiveTargetForCancellation;
  proto.activatePausedTargetAfterResume = activatePausedTargetAfterResume;
  proto.runSessionStartHooks = runSessionStartHooks;
  proto.runUserPromptSubmitHooks = runUserPromptSubmitHooks;
  proto.runStopHooks = runStopHooks;
  proto.injectHookAdditionalContextIntoMessageHistory =
    injectHookAdditionalContextIntoMessageHistory;
  proto.shouldContinueAfterStopHooks = shouldContinueAfterStopHooks;
}
