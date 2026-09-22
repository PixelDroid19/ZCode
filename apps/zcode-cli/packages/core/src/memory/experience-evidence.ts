import {
  selectActiveConversationBranch,
  type MemoryEvidence,
  type MessageWithParts,
  type SessionId,
  type SessionStorePort,
  type ToolPart,
  type TurnId,
  type ExperienceMemoryEvidenceInput,
} from "@zcode/contracts";
import { analyzeBashCommand } from "../tool/handlers/bash-command-parser.js";

const MAX_USER_MESSAGE_SCAN = 100;
type TerminalToolPart = ToolPart & {
  state: Extract<ToolPart["state"], { status: "completed" | "error" }>;
};
const POSITIVE_TEST_SUMMARIES = [
  /\b[1-9]\d*\s+(?:tests?|test files?)\s+passed\b/iu,
  /\b(?:tests?|test files?)\s+[1-9]\d*\s+passed\b/iu,
  /\b[1-9]\d*\s+passing\b/iu,
  /\b[1-9]\d*\s+passed(?:\s+\([1-9]\d*\))?/iu,
  /\bpass(?:ed)?\s*[:=]\s*[1-9]\d*\b/iu,
  /\bpass\s+[1-9]\d*\b/iu,
  /\b100%\s+tests?\s+passed\b/iu,
  /\btest result:\s*ok\b/iu,
  /^\s*ok\s+\S+\s+[0-9.]+s\s*$/imu,
  /\bRan\s+[1-9]\d*\s+tests?\b[\s\S]{0,100}\bOK\b/iu,
  /\bPassed!\s*-\s*Failed:\s*0,\s*Passed:\s*[1-9]\d*\b/iu,
];
const FAILED_TEST_SUMMARIES = [
  /\b[1-9]\d*\s+(?:tests?|test files?)\s+failed\b/iu,
  /\b[1-9]\d*\s+failing\b/iu,
  /\bfail(?:ed)?\s*[:=]\s*[1-9]\d*\b/iu,
  /\bfail\s+[1-9]\d*\b/iu,
  /\b[1-9]\d*\s+failed\b/iu,
  /\btest result:\s*failed\b/iu,
];
const ZERO_TEST_SUMMARIES = [
  /^\s*#\s*tests?\s+0\b/imu,
  /\btests?\s+0\b/iu,
  /\b0\s+tests?\b/iu,
  /\btests?:\s*0\s+(?:total|passed)\b/iu,
  /\b0\s+passing\b/iu,
  /\bpassed:\s*0\b/iu,
];
const RECOGNIZED_TEST_RUNNER_SUMMARIES = [
  /#\s*tests\s+[1-9]\d*\b[\s\S]{0,240}#\s*pass\s+[1-9]\d*\b[\s\S]{0,120}#\s*fail\s+0\b/iu,
  /\bTest\s+Files?\s*[:.]?\s*[1-9]\d*\s+passed\b[\s\S]{0,300}\bTests?\s*[:.]?\s*[1-9]\d*\s+passed\b/iu,
  /\bTest\s+Suites?\s*:\s*[1-9]\d*\s+passed\b[\s\S]{0,300}\bTests?\s*:\s*[1-9]\d*\s+passed\b/iu,
  /\b[1-9]\d*\s+passed\s+in\s+\d+(?:\.\d+)?s\b/iu,
  /\btest\s+result:\s*ok\.\s*[1-9]\d*\s+passed;\s*0\s+failed\b/iu,
  /(?:^|\n)\s*ok\s+\S+\s+\d+(?:\.\d+)?s\s*$/imu,
  /\bPassed!\s*-\s*Failed:\s*0,\s*Passed:\s*[1-9]\d*\b/iu,
  /\b100%\s+tests?\s+passed,\s*0\s+tests?\s+failed\b/iu,
  /\bTests\s+run:\s*[1-9]\d*,\s*Failures:\s*0,\s*Errors:\s*0\b/iu,
  /\b[1-9]\d*\s+tests?\s+completed,\s*0\s+failed\b/iu,
];

export class ExperienceMemoryEvidenceError extends Error {
  constructor(
    public readonly code: "evidence_invalid" | "unavailable" | "storage_error",
    message: string,
  ) {
    super(message);
    this.name = "ExperienceMemoryEvidenceError";
  }
}

export async function validateExperienceMemoryEvidence(input: {
  evidence: readonly ExperienceMemoryEvidenceInput[] | undefined;
  outcome: string | undefined;
  sessionId: string;
  currentTurnId?: TurnId;
  sessionStore?: SessionStorePort;
  signal: AbortSignal;
}): Promise<MemoryEvidence[]> {
  const evidence = input.evidence ?? [];
  const needsUserSource = input.outcome === "user_confirmed";
  const needsTestSource = input.outcome === "tests_passed";
  if (
    (needsUserSource && !evidence.some((item) => item.kind === "user")) ||
    (needsTestSource && !evidence.some((item) => item.kind === "tool"))
  ) {
    throw new ExperienceMemoryEvidenceError(
      "evidence_invalid",
      needsUserSource
        ? "user_confirmed requires a verifiable quote from a real user message in this session."
        : "tests_passed requires a verifiable test result from a completed test tool call in this session.",
    );
  }

  const requiresTranscript = evidence.some((item) => item.kind !== "agent");
  if (!requiresTranscript) {
    return evidence.map((item) => ({ ...item, sessionId: input.sessionId }));
  }
  if (!input.sessionStore) {
    throw new ExperienceMemoryEvidenceError(
      "unavailable",
      "Durable session messages are unavailable, so source evidence cannot be verified.",
    );
  }
  checkAbort(input.signal);

  let messages: MessageWithParts[];
  try {
    const [storedMessages, session] = await Promise.all([
      input.sessionStore.messages({ sessionID: input.sessionId as SessionId }),
      input.sessionStore.getSession(input.sessionId as SessionId),
    ]);
    messages = selectActiveConversationBranch(storedMessages, {
      branchCutAfterMessageId: session?.revert?.branchCutAfterMessageID,
      rewindCreatedMessageId: session?.revert?.createdMessageID,
      rewindKeptMessageIds: session?.revert?.keptMessageIDs,
      rewindTargetMessageId: session?.revert?.targetMessageID,
    });
  } catch {
    checkAbort(input.signal);
    throw new ExperienceMemoryEvidenceError(
      "storage_error",
      "Durable session messages could not be read, so source evidence cannot be verified.",
    );
  }
  checkAbort(input.signal);

  return evidence.map((item) => {
    checkAbort(input.signal);
    if (item.kind === "agent") return { ...item, sessionId: input.sessionId };
    if (item.kind === "user") {
      const source = resolveUserMessage(messages, item.messageId, item.quote, input.currentTurnId);
      return {
        kind: "user",
        sessionId: input.sessionId,
        messageId: source.info.id,
        quote: item.quote,
        summary: item.summary,
      };
    }

    const source = resolveToolMessage(messages, item.messageId, item.toolCallId);
    const quotedOutput = toolEvidenceText(source.part);
    if (!quotedOutput.includes(item.quote)) {
      throw new ExperienceMemoryEvidenceError(
        "evidence_invalid",
        "The cited tool call does not contain the exact quote.",
      );
    }
    if (needsTestSource && !isSuccessfulTestEvidence(source, item.quote)) {
      throw new ExperienceMemoryEvidenceError(
        "evidence_invalid",
        "The cited tool call does not contain a successful test result matching the quote.",
      );
    }
    return {
      kind: "tool",
      sessionId: input.sessionId,
      messageId: source.message.info.id,
      toolCallId: source.part.callID,
      quote: item.quote,
      summary: item.summary,
    };
  });
}

function resolveUserMessage(
  messages: readonly MessageWithParts[],
  messageId: string | undefined,
  quote: string,
  currentTurnId: TurnId | undefined,
): MessageWithParts {
  const candidates = messages
    .filter((message) => isRealUserMessage(message) && hasUserQuote(message, quote))
    .slice(-MAX_USER_MESSAGE_SCAN);
  if (messageId) {
    const exact = candidates.find((message) => message.info.id === messageId);
    if (exact) return exact;
    throw invalidEvidence(
      "The cited user message is not a real, visible user message containing the exact quote.",
    );
  }

  if (currentTurnId) {
    const currentTurnMatches = candidates.filter(
      (message) => message.info.anchor?.turnId === currentTurnId,
    );
    if (currentTurnMatches.length === 1) return currentTurnMatches[0]!;
    if (currentTurnMatches.length > 1) {
      throw invalidEvidence(
        "The quote matches more than one real user message in the current turn; supply messageId.",
      );
    }
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    throw invalidEvidence("The exact quote was not found in a real user message in this session.");
  }
  throw invalidEvidence(
    "The quote matches more than one recent real user message; supply messageId.",
  );
}

function isRealUserMessage(message: MessageWithParts): boolean {
  const info = message.info;
  if (info.role !== "user" || info.synthetic === true || info.source !== undefined) return false;
  if (info.visibility === "model-only") return false;
  if (info.semantics && info.semantics.origin !== "real_user") return false;
  if (
    info.semantics &&
    (info.semantics.uiVisibility !== "visible" ||
      info.semantics.providerVisibility !== "visible" ||
      info.semantics.transcriptVisibility !== "visible")
  ) {
    return false;
  }
  if (info.anchor && info.anchor.origin !== "realUser") return false;
  return info.semantics?.origin === "real_user" || info.anchor?.origin === "realUser";
}

function hasUserQuote(message: MessageWithParts, quote: string): boolean {
  return message.parts.some(
    (part) =>
      part.type === "text" &&
      part.synthetic !== true &&
      part.ignored !== true &&
      part.text.includes(quote),
  );
}

function resolveToolMessage(
  messages: readonly MessageWithParts[],
  messageId: string | undefined,
  toolCallId: string,
): {
  message: MessageWithParts;
  part: TerminalToolPart;
} {
  const matches: Array<{ message: MessageWithParts; part: TerminalToolPart }> = [];
  for (const message of messages) {
    if (message.info.role !== "assistant" || (messageId && message.info.id !== messageId)) continue;
    for (const part of message.parts) {
      if (
        part.type === "tool" &&
        part.callID === toolCallId &&
        part.tool !== "Memory" &&
        (part.state.status === "completed" || part.state.status === "error")
      ) {
        matches.push({ message, part: part as TerminalToolPart });
      }
    }
  }
  if (matches.length !== 1) {
    throw invalidEvidence(
      matches.length === 0
        ? "The cited tool call is not completed successfully in this session."
        : "The cited tool call is ambiguous in this session.",
    );
  }
  return matches[0]!;
}

function isSuccessfulTestEvidence(
  source: {
    message: MessageWithParts;
    part: TerminalToolPart;
  },
  quote: string,
): boolean {
  if (source.part.tool !== "Bash" || source.part.state.status !== "completed") return false;
  const outcome = readBashExecutionOutcome(source.part.state.metadata.executionOutcome);
  if (
    !outcome ||
    outcome.toolSuccess !== true ||
    outcome.exitCode !== 0 ||
    outcome.aborted !== false
  ) {
    return false;
  }
  const command = source.part.state.input.command;
  if (typeof command !== "string" || !containsTestRunnerInvocation(command)) return false;

  const output = source.part.state.output;
  if (
    !output.includes(quote) ||
    /\bExit code\s+[1-9]\d*\b|<error>|Command was aborted/iu.test(output) ||
    /(?:^|\n)\s*(?:FAIL\b|not ok\b|✗|×|❌)|\b(?:Error|Exception):/iu.test(output)
  ) {
    return false;
  }
  if (FAILED_TEST_SUMMARIES.some((pattern) => pattern.test(output))) return false;
  if (ZERO_TEST_SUMMARIES.some((pattern) => pattern.test(output))) return false;
  return (
    POSITIVE_TEST_SUMMARIES.some((pattern) => pattern.test(quote)) &&
    RECOGNIZED_TEST_RUNNER_SUMMARIES.some((pattern) => pattern.test(output))
  );
}

function containsTestRunnerInvocation(command: string): boolean {
  const analysis = analyzeBashCommand(command);
  if (
    analysis.hasParseErrors ||
    analysis.hasUnsupportedSyntax ||
    analysis.hasDynamicWords ||
    analysis.hasRedirects ||
    analysis.commands.length !== 1
  ) {
    return false;
  }
  const invocation = analysis.commands[0];
  if (!invocation || invocation.hasAssignmentPrefix || invocation.argv.length === 0) return false;
  const args = invocation.argv.slice(1).map((arg) => arg.toLowerCase());
  if (
    args.some((arg) =>
      /^(?:--?help|-h|-v|--version|-V|--list(?:-tests)?|--listtests|--collect-only|--dry-run|--show-only)$/u.test(
        arg,
      ),
    )
  ) {
    return false;
  }
  const executable = invocation.name.toLowerCase();
  if (["vitest", "jest", "mocha", "pytest", "ctest", "tox", "nox"].includes(executable)) {
    return true;
  }
  if (["pnpm", "npm", "yarn", "bun"].includes(executable)) {
    return args.some((arg) => arg === "test" || /^test:[a-z0-9_-]+$/u.test(arg));
  }
  if (executable === "npx" || executable === "bunx") {
    return args.some((arg) => ["vitest", "jest", "mocha", "playwright", "cypress"].includes(arg));
  }
  if (executable === "node") return args.includes("--test");
  if (/^python(?:\d+(?:\.\d+)*)?$/u.test(executable)) {
    const moduleIndex = args.indexOf("-m");
    return moduleIndex >= 0 && ["pytest", "unittest"].includes(args[moduleIndex + 1] ?? "");
  }
  return (
    (executable === "go" && args[0] === "test") ||
    (executable === "cargo" && args[0] === "test") ||
    (executable === "swift" && args[0] === "test") ||
    (executable === "dotnet" && args[0] === "test") ||
    (executable === "gradle" && args.some((arg) => /^(?:test|test[a-z0-9_-]+)$/u.test(arg))) ||
    (executable === "mvn" && args.some((arg) => /^(?:test|verify)$/u.test(arg))) ||
    (executable === "make" && args.some((arg) => /^(?:test|check)$/u.test(arg)))
  );
}

function readBashExecutionOutcome(value: unknown):
  | {
      toolSuccess: boolean;
      exitCode?: number | null;
      aborted?: boolean;
    }
  | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.toolSuccess !== "boolean") return undefined;
  if (
    candidate.exitCode !== undefined &&
    candidate.exitCode !== null &&
    typeof candidate.exitCode !== "number"
  ) {
    return undefined;
  }
  if (candidate.aborted !== undefined && typeof candidate.aborted !== "boolean") return undefined;
  return {
    toolSuccess: candidate.toolSuccess,
    ...(candidate.exitCode === undefined ? {} : { exitCode: candidate.exitCode as number | null }),
    ...(candidate.aborted === undefined ? {} : { aborted: candidate.aborted }),
  };
}

function toolEvidenceText(part: TerminalToolPart): string {
  return part.state.status === "completed" ? part.state.output : part.state.error;
}

function invalidEvidence(message: string): ExperienceMemoryEvidenceError {
  return new ExperienceMemoryEvidenceError("evidence_invalid", message);
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Memory evidence validation was cancelled.");
}
