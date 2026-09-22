import {
  ExperienceMemoryOutputSchema,
  MemoryStoreError,
  type ExperienceMemoryInput,
  type ExperienceMemoryOutput,
} from "@zcode/contracts";
import type { ToolHandlerFailure } from "../types.js";
import { ExperienceMemoryEvidenceError } from "../../memory/experience-evidence.js";

const MEMORY_ERROR_CODE = {
  conflict: 71,
  not_found: 72,
  invalid: 73,
  operation_conflict: 74,
  evidence_invalid: 75,
  unavailable: 76,
  storage_error: 77,
} as const;

type MemoryOutputErrorCode = Extract<ExperienceMemoryOutput, { status: "error" }>["code"];

export function normalizeMemoryError(error: unknown): {
  code: MemoryOutputErrorCode;
  message: string;
  recordId?: string;
} {
  if (error instanceof MemoryStoreError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.recordId ? { recordId: error.recordId } : {}),
    };
  }
  if (error instanceof ExperienceMemoryEvidenceError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "storage_error",
    message:
      "The memory operation could not be confirmed. Read the current record before retrying.",
  };
}

export function createMemoryFailure(
  action: ExperienceMemoryInput["action"],
  code: MemoryOutputErrorCode,
  message: string,
  recordId?: string,
): ToolHandlerFailure {
  const envelope = ExperienceMemoryOutputSchema.parse({
    status: "error",
    action,
    code,
    message: boundedErrorMessage(message),
    ...(recordId === undefined ? {} : { recordId }),
  });
  return {
    result: false,
    errorCode: MEMORY_ERROR_CODE[code],
    message: `memory_error:${JSON.stringify(envelope)}`,
  };
}

function boundedErrorMessage(value: string): string {
  const cleaned = value.replace(/\p{Cc}/gu, " ").trim();
  return Array.from(cleaned).slice(0, 499).join("") || "Memory operation failed.";
}
