import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { CompactPhase, CompactReason, CompactTrigger, Model } from "../deps.js";
import type { CompactAttemptOutcome } from "./turn-loop-state.js";

export interface ActiveCompactOptions {
  abortSignal?: AbortSignal;
  compactContextTelemetry?: {
    inputTokens: number;
    policyContextWindowTokens: number;
    thresholdTokens?: number;
    tokenSource: "estimate" | "provider_usage";
  };
  autoCompactThreshold?: number;
  compactReason?: CompactReason;
  initialPromptTooLongCause?: unknown;
  phase?: CompactPhase;
  sourceCommandId?: string;
  trigger?: CompactTrigger;
  model?: Model;
  activeEntries?: readonly RuntimeMessageEntry[];
}

export interface ActiveCompactResult {
  displayText: string;
  entries: readonly RuntimeMessageEntry[];
  outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
  tokenCount: number;
}
