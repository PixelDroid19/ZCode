import type { AgentRuntimeInternal } from "../internal.js";
import type { TurnResult } from "../types.js";
import { completeRegularTurn } from "./turn-command-completion.js";
import { failRegularTurn } from "./turn-command-failure.js";
import { prepareRegularTurnLoop } from "./turn-command-input.js";
import type {
  RegularTurnLifecycleContext,
  RegularTurnLifecycleState,
} from "./turn-command-lifecycle-types.js";

/** Keeps the regular-loop try/catch boundary intact while stages live in focused modules. */
export async function executeRegularTurnLifecycle(
  runtime: AgentRuntimeInternal,
  context: RegularTurnLifecycleContext,
  state: RegularTurnLifecycleState,
): Promise<TurnResult> {
  try {
    const stoppedByHook = await prepareRegularTurnLoop(runtime, context, state);
    if (stoppedByHook) return stoppedByHook;
    return await completeRegularTurn(runtime, context, state);
  } catch (error) {
    return await failRegularTurn(runtime, context, state, error);
  }
}
