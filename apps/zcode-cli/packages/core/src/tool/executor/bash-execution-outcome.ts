import { BashOutputSchema } from "@zcode/contracts";
import type { ToolExecutionResult } from "../types.js";

type BashExecutionOutcome = NonNullable<ToolExecutionResult["executionOutcome"]>;

export function readBashExecutionOutcome(
  output: unknown,
  toolSuccess: boolean,
  signal: AbortSignal,
): BashExecutionOutcome {
  const parsed = BashOutputSchema.safeParse(output);
  const bashOutput = parsed.success ? parsed.data : undefined;
  return {
    toolSuccess,
    ...(bashOutput?.exitCode === undefined ? {} : { exitCode: bashOutput.exitCode }),
    aborted:
      signal.aborted ||
      bashOutput?.cancelled === true ||
      bashOutput?.timedOut === true ||
      bashOutput?.interrupted === true ||
      bashOutput?.status === "cancelled" ||
      bashOutput?.status === "timed_out",
  };
}

export function failedBashExecutionOutcome(
  previous: BashExecutionOutcome | undefined,
  aborted: boolean,
): BashExecutionOutcome {
  return {
    ...(previous ?? {}),
    toolSuccess: false,
    aborted: aborted || previous?.aborted === true,
  };
}
