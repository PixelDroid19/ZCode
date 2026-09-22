import { grantPermissionFullAccess } from "../permission-full-access.js";
import {
  createChildClientPorts,
  ensureSessionPersistedForExternalActivity,
  getActiveTurnInfo,
  getContextBuilder,
  getMode,
  getPendingPermissionRequests,
  getPlanEnabled,
  getProjectId,
  getProjection,
  getSessionEventStore,
  getExperienceMemoryRuntimeContext,
  getSessionId,
  getSessionModelSelection,
  getSessionShellSelection,
  getToolExecutor,
  getToolRegistry,
  getTools,
  initializeSessionShellEnvironmentIfNeeded,
  invalidateToolCache,
  notifyExternalChildSessionEvent,
  setExecutionState,
  setSessionModelSelection,
  setWorkingDirectory,
  subscribeEvents,
  updateConfig,
} from "./config.js";
import { recordDynamicWorkflowRunProgress } from "./dynamic-workflow-run-progress.js";
import { amendWorkflowRunSettings } from "./dynamic-workflow-run-settings.js";
import { startSavedWorkflowRun } from "./dynamic-workflow-run-start.js";
import { trackResumedDynamicWorkflowRun } from "./dynamic-workflow-run-track.js";
import { maybeStartGoalSummaryTitleGeneration } from "./goal-summary-title.js";
import { recordUserInputAutoResolutionUpdate } from "./interaction-auto-resolution.js";
import {
  acquireCapabilitiesLease,
  createInheritedCapabilitySource,
  disposeCapabilities,
  getCapabilitiesStatus,
  getPluginReferenceCatalog,
  refreshCapabilities,
  refreshCapabilitiesAtModelBoundary,
  subscribeCapabilities,
} from "./live-capabilities.js";
import {
  maybeStartSessionTitleGenerationFromExternalInput,
  setCustomSessionTitle,
} from "./session-title.js";
import { testModelConnectivity } from "./workspace-generate-text.js";

export function installRuntimeConfigurationMethods(proto: Record<string, unknown>): void {
  proto.updateConfig = updateConfig;
  proto.setExecutionState = setExecutionState;
  proto.grantPermissionFullAccess = grantPermissionFullAccess;
  proto.initializeSessionShellEnvironmentIfNeeded = initializeSessionShellEnvironmentIfNeeded;
  proto.getSessionShellSelection = getSessionShellSelection;
  proto.getMode = getMode;
  proto.getPlanEnabled = getPlanEnabled;
  proto.getSessionModelSelection = getSessionModelSelection;
  proto.setSessionModelSelection = setSessionModelSelection;
  proto.getProjectId = getProjectId;
  proto.setWorkingDirectory = setWorkingDirectory;
  proto.ensureSessionPersistedForExternalActivity = ensureSessionPersistedForExternalActivity;
  proto.maybeStartSessionTitleGenerationFromExternalInput =
    maybeStartSessionTitleGenerationFromExternalInput;
  proto.setCustomSessionTitle = setCustomSessionTitle;
  proto.maybeStartGoalSummaryTitleGeneration = maybeStartGoalSummaryTitleGeneration;
  proto.testModelConnectivity = testModelConnectivity;
  proto.getActiveTurnInfo = getActiveTurnInfo;
  proto.getTools = getTools;
  proto.invalidateToolCache = invalidateToolCache;
  proto.getToolRegistry = getToolRegistry;
  proto.getToolExecutor = getToolExecutor;
  proto.subscribeEvents = subscribeEvents;
  proto.getSessionEventStore = getSessionEventStore;
  proto.getExperienceMemoryRuntimeContext = getExperienceMemoryRuntimeContext;
  proto.notifyExternalChildSessionEvent = notifyExternalChildSessionEvent;
  proto.createChildClientPorts = createChildClientPorts;
  proto.getContextBuilder = getContextBuilder;
  proto.getPendingPermissionRequests = getPendingPermissionRequests;
  proto.getCapabilitiesStatus = getCapabilitiesStatus;
  proto.refreshCapabilities = refreshCapabilities;
  proto.subscribeCapabilities = subscribeCapabilities;
  proto.getPluginReferenceCatalog = getPluginReferenceCatalog;
  proto.createInheritedCapabilitySource = createInheritedCapabilitySource;
  proto.disposeCapabilities = disposeCapabilities;
  proto.refreshCapabilitiesAtModelBoundary = refreshCapabilitiesAtModelBoundary;
  proto.acquireCapabilitiesLease = acquireCapabilitiesLease;
  proto.recordUserInputAutoResolutionUpdate = recordUserInputAutoResolutionUpdate;
  proto.recordDynamicWorkflowRunProgress = recordDynamicWorkflowRunProgress;
  proto.trackResumedDynamicWorkflowRun = trackResumedDynamicWorkflowRun;
  proto.startSavedWorkflowRun = startSavedWorkflowRun;
  proto.amendWorkflowRunSettings = amendWorkflowRunSettings;
  proto.getProjection = getProjection;
  proto.getSessionId = getSessionId;
}
