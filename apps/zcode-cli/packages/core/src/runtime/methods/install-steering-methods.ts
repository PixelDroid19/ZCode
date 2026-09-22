import {
  enqueueBackgroundTaskNotification,
  sealBackgroundTaskNotifications,
} from "./background-notifications.js";
import { hasResidencyBlockingWork, trackResidencyBlockingWork } from "./residency.js";
import { drainPendingRuntimeCommandsForActiveLoop } from "./runtime-command-active-loop.js";
import {
  acquireForegroundPromotionLease,
  drainRuntimeCommandQueue,
  enqueueRuntimeCommand,
  getActiveForegroundExecutionId,
  hasActiveOrQueuedTurnWork,
  releaseForegroundPromotionLease,
  stopActiveForegroundExecution,
} from "./runtime-command-queue.js";
import {
  beginActiveTurn,
  clearAllPendingInputs,
  completeExternalQueueDrain,
  createPendingInputId,
  discardHeldPendingInputById,
  discardPendingInput,
  discardPersistedPendingSteerInputs,
  drainPendingInput,
  editPendingInputById,
  emitModeChanged,
  emitModelSelected,
  enqueueDeferredInput,
  fallbackPendingGuidesToQueue,
  finishActiveTurn,
  hasInlineGuidePendingInput,
  hasPendingInput,
  markPendingInputPromoting,
  rejectTurnSteer,
  releasePendingInputReservation,
  releaseTurnStart,
  removePendingInputById,
  reorderPendingInput,
  reservePendingInputById,
  reserveTurnStart,
  setFollowupMode,
  setQueueAutoDrain,
  steerTurn,
} from "./steering.js";
import { enqueueSubagentMessage } from "./subagent-messages.js";

export function installRuntimeSteeringMethods(proto: Record<string, unknown>): void {
  proto.enqueueDeferredInput = enqueueDeferredInput;
  proto.steerTurn = steerTurn;
  proto.beginActiveTurn = beginActiveTurn;
  proto.reserveTurnStart = reserveTurnStart;
  proto.releaseTurnStart = releaseTurnStart;
  proto.finishActiveTurn = finishActiveTurn;
  proto.createPendingInputId = createPendingInputId;
  proto.rejectTurnSteer = rejectTurnSteer;
  proto.hasPendingInput = hasPendingInput;
  proto.hasInlineGuidePendingInput = hasInlineGuidePendingInput;
  proto.fallbackPendingGuidesToQueue = fallbackPendingGuidesToQueue;
  proto.drainPendingInput = drainPendingInput;
  proto.enqueueRuntimeCommand = enqueueRuntimeCommand;
  proto.drainRuntimeCommandQueue = drainRuntimeCommandQueue;
  proto.hasActiveOrQueuedTurnWork = hasActiveOrQueuedTurnWork;
  proto.hasResidencyBlockingWork = hasResidencyBlockingWork;
  proto.trackResidencyBlockingWork = trackResidencyBlockingWork;
  proto.acquireForegroundPromotionLease = acquireForegroundPromotionLease;
  proto.getActiveForegroundExecutionId = getActiveForegroundExecutionId;
  proto.releaseForegroundPromotionLease = releaseForegroundPromotionLease;
  proto.stopActiveForegroundExecution = stopActiveForegroundExecution;
  proto.enqueueBackgroundTaskNotification = enqueueBackgroundTaskNotification;
  proto.enqueueSubagentMessage = enqueueSubagentMessage;
  proto.drainPendingRuntimeCommandsForActiveLoop = drainPendingRuntimeCommandsForActiveLoop;
  proto.sealBackgroundTaskNotifications = sealBackgroundTaskNotifications;
  proto.discardPendingInput = discardPendingInput;
  proto.removePendingInputById = removePendingInputById;
  proto.reservePendingInputById = reservePendingInputById;
  proto.markPendingInputPromoting = markPendingInputPromoting;
  proto.releasePendingInputReservation = releasePendingInputReservation;
  proto.editPendingInputById = editPendingInputById;
  proto.reorderPendingInput = reorderPendingInput;
  proto.setQueueAutoDrain = setQueueAutoDrain;
  proto.completeExternalQueueDrain = completeExternalQueueDrain;
  proto.setFollowupMode = setFollowupMode;
  proto.emitModelSelected = emitModelSelected;
  proto.emitModeChanged = emitModeChanged;
  proto.discardPersistedPendingSteerInputs = discardPersistedPendingSteerInputs;
  proto.discardHeldPendingInputById = discardHeldPendingInputById;
  proto.clearAllPendingInputs = clearAllPendingInputs;
}
