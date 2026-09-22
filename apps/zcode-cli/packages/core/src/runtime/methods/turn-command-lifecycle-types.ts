import type {
  MessageId,
  Model,
  SessionEvent,
  SessionGoal,
  TraceContext,
  TraceId,
  TurnId,
  TurnMachineImpl,
  TurnState,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ActiveTurnSteeringState, ExecuteTurnOptions } from "../types.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

/** Mutable facts for one admitted regular turn; AgentRuntime remains their owner. */
export interface RegularTurnLifecycleState {
  activeTurn: ActiveTurnSteeringState | undefined;
  loopState: RegularTurnLoopState | undefined;
  shouldRetryTitleGenerationAfterTurn: boolean;
  startedTarget: SessionGoal | null;
  turnMachine: TurnMachineImpl;
  userMessageId: MessageId | undefined;
}

/** Immutable inputs and phase hooks shared by the regular-turn lifecycle stages. */
export interface RegularTurnLifecycleContext {
  admittedModel: Model | undefined;
  admittedOutputStyle: AgentRuntimeInternal["config"]["outputStyle"];
  attachments: TurnState["attachments"] | undefined;
  displayInput: string;
  events: SessionEvent[];
  input: string;
  markTurnFailureHandled: () => void;
  options: ExecuteTurnOptions | undefined;
  submissionModel: Model | undefined;
  targetRunInputID: string;
  traceId: TraceId;
  turnAbortSignal: AbortSignal;
  turnId: TurnId;
  turnStartedAtMs: number;
  turnTraceContext: TraceContext;
  userMessageId: MessageId;
  completeTurnPhase: (phase: string, startedAt: number) => void;
  startTurnPhase: (phase: string) => number;
}
