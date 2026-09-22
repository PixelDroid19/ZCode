import {
  drainMemoryExtractions,
  isProjectMemoryEnabled,
} from "../helpers/project-memory-extraction.js";
import { readBackgroundBashOutput } from "./background-bash-output.js";
import { buildBackgroundTaskPayload } from "./background-task-payload.js";
import {
  cancelBackgroundTask,
  cancelRunningRuntimeBackgroundTasks,
  hasRunningBackgroundTasks,
  stopBackgroundTask,
} from "./background.js";
import { compactActiveConversation } from "./compact-active.js";
import {
  buildCompactTimelinePayload,
  finishCompactTimelineFailure,
  persistCompactSummary,
  persistCompactTimeline,
  recoverInterruptedCompactTimelines,
} from "./compact-persistence.js";
import {
  autoCompactIfNeeded,
  executeManualCompact,
  reactiveCompactAfterContextExceeded,
} from "./compact.js";
import { recordExternalUserPrompt } from "./control-only-turn.js";
import {
  appendEvent,
  createEvent,
  ensureSessionPersisted,
  isSessionPersisted,
  notifyEventSinks,
} from "./events.js";
import { applyWorkspaceFileRewind, previewWorkspaceFileRewind } from "./file-rewind.js";
import {
  persistAssistantMessage,
  persistMessage,
  persistPart,
  persistSyntheticUserNotice,
  persistSyntheticUserNoticeForSession,
  persistUserPrompt,
  rebuildProjection,
} from "./message-persistence.js";
import { microcompactIfNeeded } from "./microcompact.js";
import { admitPrompt } from "./prompt-admission.js";
import {
  rewindCascadeToMessage,
  rewindConversationToMessage,
  rewindToMessage,
  rewindWorkspaceToMessage,
} from "./rewind-message.js";
import {
  executeRewindCommand,
  finishUnavailableRewind,
  formatRewindStatus,
  rewindWorkspaceToCheckpoint,
} from "./rewind.js";
import {
  createSelectionSideConversation,
  forkConversationBeforeMessage,
  forkStableConversationAtMessage,
} from "./session-fork.js";
import {
  persistAssistantTimelinePartForSession,
  persistPendingModelChangeTimeline,
  recordPendingModelChange,
} from "./timeline-persistence.js";
import {
  emitFileMutationCheckpoint,
  emitPermissionRequest,
  emitToolScheduledEvents,
  executeTools,
  resolvePermission,
  scheduleTools,
} from "./tools.js";
import { executeTurn, executeTurnCommand } from "./turn.js";
import {
  copySessionMessagesForFork,
  forkWorkspaceFromCheckpoint,
  listWorkspaceCheckpoints,
  loadCheckpointMessagePreviews,
  restoreWorkspaceCheckpointArtifact,
} from "./workspace-checkpoints.js";
import { generateWorkspaceText } from "./workspace-generate-text.js";

export function installRuntimeTurnExecutionMethods(proto: Record<string, unknown>): void {
  proto.recordExternalUserPrompt = recordExternalUserPrompt;
  proto.executeTurn = executeTurn;
  proto.admitPrompt = admitPrompt;
  proto.executeTurnCommand = executeTurnCommand;
  proto.executeManualCompact = executeManualCompact;
  proto.autoCompactIfNeeded = autoCompactIfNeeded;
  proto.microcompactIfNeeded = microcompactIfNeeded;
  proto.reactiveCompactAfterContextExceeded = reactiveCompactAfterContextExceeded;
  proto.compactActiveConversation = compactActiveConversation;
  proto.executeRewindCommand = executeRewindCommand;
  proto.formatRewindStatus = formatRewindStatus;
  proto.rewindWorkspaceToCheckpoint = rewindWorkspaceToCheckpoint;
  proto.rewindToMessage = rewindToMessage;
  proto.rewindCascadeToMessage = rewindCascadeToMessage;
  proto.rewindConversationToMessage = rewindConversationToMessage;
  proto.rewindWorkspaceToMessage = rewindWorkspaceToMessage;
  proto.finishUnavailableRewind = finishUnavailableRewind;
  proto.restoreWorkspaceCheckpointArtifact = restoreWorkspaceCheckpointArtifact;
  proto.copySessionMessagesForFork = copySessionMessagesForFork;
  proto.listWorkspaceCheckpoints = listWorkspaceCheckpoints;
  proto.forkWorkspaceFromCheckpoint = forkWorkspaceFromCheckpoint;
  proto.forkStableConversationAtMessage = forkStableConversationAtMessage;
  proto.createSelectionSideConversation = createSelectionSideConversation;
  proto.forkConversationBeforeMessage = forkConversationBeforeMessage;
  proto.loadCheckpointMessagePreviews = loadCheckpointMessagePreviews;
  proto.previewWorkspaceFileRewind = previewWorkspaceFileRewind;
  proto.applyWorkspaceFileRewind = applyWorkspaceFileRewind;
  proto.scheduleTools = scheduleTools;
  proto.executeTools = executeTools;
  proto.emitToolScheduledEvents = emitToolScheduledEvents;
  proto.emitFileMutationCheckpoint = emitFileMutationCheckpoint;
  proto.emitPermissionRequest = emitPermissionRequest;
  proto.resolvePermission = resolvePermission;
  proto.readBackgroundBashOutput = readBackgroundBashOutput;
  proto.cancelBackgroundTask = cancelBackgroundTask;
  proto.stopBackgroundTask = stopBackgroundTask;
  proto.cancelRunningRuntimeBackgroundTasks = cancelRunningRuntimeBackgroundTasks;
  proto.hasRunningBackgroundTasks = hasRunningBackgroundTasks;
  proto.buildBackgroundTaskPayload = buildBackgroundTaskPayload;
  proto.createEvent = createEvent;
  proto.appendEvent = appendEvent;
  proto.notifyEventSinks = notifyEventSinks;
  proto.ensureSessionPersisted = ensureSessionPersisted;
  proto.isSessionPersisted = isSessionPersisted;
  proto.buildCompactTimelinePayload = buildCompactTimelinePayload;
  proto.persistCompactTimeline = persistCompactTimeline;
  proto.finishCompactTimelineFailure = finishCompactTimelineFailure;
  proto.recoverInterruptedCompactTimelines = recoverInterruptedCompactTimelines;
  proto.persistCompactSummary = persistCompactSummary;
  proto.persistUserPrompt = persistUserPrompt;
  proto.recordPendingModelChange = recordPendingModelChange;
  proto.persistPendingModelChangeTimeline = persistPendingModelChangeTimeline;
  proto.persistSyntheticUserNotice = persistSyntheticUserNotice;
  proto.persistSyntheticUserNoticeForSession = persistSyntheticUserNoticeForSession;
  proto.persistAssistantTimelinePartForSession = persistAssistantTimelinePartForSession;
  proto.persistAssistantMessage = persistAssistantMessage;
  proto.persistMessage = persistMessage;
  proto.persistPart = persistPart;
  proto.rebuildProjection = rebuildProjection;
  proto.generateWorkspaceText = generateWorkspaceText;
  proto.drainMemoryExtractions = drainMemoryExtractions;
  proto.isProjectMemoryEnabled = isProjectMemoryEnabled;
}
