import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { ModelToolContract } from "../deps.js";
import type { DrainedPendingInputDiagnostics, RunModelTextRequestOptions } from "../types.js";

export type ModelStepResult = "continue" | "output_continuation" | "break";

export interface ModelStepOptions {
  drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
  latestRealUserMessageIndex?: number;
  messages: RunModelTextRequestOptions["messages"];
  sourceEntries: readonly (RuntimeMessageEntry | undefined)[];
  recordedMessages: RunModelTextRequestOptions["messages"];
  requestEntries: readonly RuntimeMessageEntry[];
  tools: ModelToolContract[];
}
