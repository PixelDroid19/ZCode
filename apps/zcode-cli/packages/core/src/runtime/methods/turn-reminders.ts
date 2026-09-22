import { buildReferencedSessionContextReminderBody } from "../../session-context/read-session-context.js";
import { formatLocalIsoDate } from "../deps.js";
import { buildDateChangeReminderBody } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ExecuteTurnOptions } from "../types.js";

export function injectDateChangeReminderIntoMessageHistory(runtime: AgentRuntimeInternal): void {
  const currentDate = formatLocalIsoDate(runtime.now());
  const previousDate = runtime.lastEmittedLocalDate;
  runtime.lastEmittedLocalDate = currentDate;

  if (!previousDate || previousDate === currentDate) return;
  runtime.messageHistory.addAttachment(
    "date_change",
    buildDateChangeReminderBody(previousDate, currentDate),
  );
}

export function injectReferencedSessionContextReminderIntoMessageHistory(
  runtime: AgentRuntimeInternal,
  input: string,
  options?: ExecuteTurnOptions,
): void {
  if (options?.inputVisibility === "model-only") return;
  const reminderBody = buildReferencedSessionContextReminderBody(input);
  if (!reminderBody) return;
  runtime.messageHistory.addAttachment("referenced_session_context", reminderBody);
}
