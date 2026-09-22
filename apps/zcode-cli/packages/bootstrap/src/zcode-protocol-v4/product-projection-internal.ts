import type {
  ConversationSnapshot,
  CuaAppIdentity,
  MutableConversationSnapshotAccumulator,
} from "@zcode/shared/zcode-protocol-v4";
import { type ConversationNormalizationDiagnostic } from "./event-normalizer.js";
import type { ProductProjectionMethods } from "./product-projection-methods.js";
import {
  ContextWindowProjectionState,
  ConversationEditTarget,
  FileToolInputPreviewState,
  PendingSessionHookInvocation,
  TurnModelBaseline,
} from "./product-projection-support.js";
export interface ProductProjectionInternal extends ProductProjectionMethods {
  snapshot: ConversationSnapshot;
  rowIndexById: Map<number, number>;
  hydrationAccumulator: MutableConversationSnapshotAccumulator | null;
  nextRowId: number;
  streamingTextRowId: number | null;
  streamingReasoningRowId: number | null;
  outputContinuationTextRowId: number | null;
  toolRowIdByCallId: Map<string, number>;
  latestListAppsSnapshot: Map<number, CuaAppIdentity>;
  openForegroundToolCallIds: Set<string>;
  fileToolInputPreviewByCallId: Map<string, FileToolInputPreviewState>;
  subagentRowIdByAgentId: Map<string, number>;
  hookRowIdByInvocationId: Map<string, number>;
  pendingSessionHookInvocations: Map<string, PendingSessionHookInvocation>;
  rewoundHookInvocationIds: Set<string>;
  invalidSubagentChildSessionIds: Set<string>;
  messageIdByRowId: Map<number, string>;
  outputContinuationRowIdByMessageId: Map<string, number>;
  entityIdByRowId: Map<number, string>;
  editTargetByEntityId: Map<string, ConversationEditTarget>;
  currentEditableEntityId: string | null;
  stableCompactCoverageBoundaryRowId: number | null;
  turnHeaderRowIdByTurnId: Map<string, number>;
  compactMarkerRowIdByOperationId: Map<string, number>;
  goalVerifyMarkerRowIdByLifecycleKey: Map<string, number>;
  productTurnIdByRuntimeTurnId: Map<string, string>;
  runtimeTurnIdByProductTurnId: Map<string, string>;
  productTurnSplitOrdinalByRuntimeTurnId: Map<string, number>;
  currentProductTurnStartedAtMs: number | null;
  deliveryByPendingInputId: Map<string, "guide" | "queue">;
  currentTurnId: string | null;
  currentTurnStartedModelOnly: boolean;
  contextWindowState: ContextWindowProjectionState;
  lastTurnModel: TurnModelBaseline;
  configModelTouchedByEvent: boolean;
  configThoughtLevelsTouchedByEvent: boolean;
  configModeTouchedByEvent: boolean;
  droppedContentStreamEventCount: number;
  normalizationDiagnostics: ConversationNormalizationDiagnostic[];
}
