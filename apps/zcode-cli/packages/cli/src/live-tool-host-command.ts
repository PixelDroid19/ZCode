import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { ZCODE_LIVE_TOOL_HOST_COMMAND } from "@zcode/contracts";
import type { RunContext } from "@zcode/shared-types";
import { redactFeedbackText } from "@zcode/shared";

const MAX_DIAGNOSTIC_CHARS = 4_000;
const MAX_ERROR_DETAIL_CHARS = 1_000;
const MAX_CAUSE_DEPTH = 3;

export function isLiveToolHostInvocation(argv: readonly string[]): boolean {
  return argv[0] === ZCODE_LIVE_TOOL_HOST_COMMAND;
}

/** Only runs in the already permission-admitted child process, never during discovery. */
export async function runLiveToolHostCommand(ctx: RunContext, argv: string[]): Promise<number> {
  const [script, ...args] = argv;
  if (!script) {
    ctx.stderr.write("Live tool script path is required.\n");
    return 1;
  }
  try {
    const entrypoint = resolve(script);
    process.argv = [process.execPath, entrypoint, ...args];
    // 不恢复任何捕获的 broker 凭据；普通扩展不能冒充官方 plugin host。
    await import(pathToFileURL(entrypoint).href);
    return 0;
  } catch (error) {
    // 修复：固定错误串让 SEA 工具无法定位脚本故障；保留有界、脱敏的原因，不污染 JSON stdout。
    ctx.stderr.write(formatLiveToolFailure(script, error));
    return 1;
  }
}

function formatLiveToolFailure(script: string, error: unknown): string {
  const entrypoint = resolve(script);
  const details = [`Live tool script failed (${safeDetail(basename(entrypoint))}).`];
  const seen = new Set<Error>();
  let cause = error;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && cause instanceof Error && !seen.has(cause);
    depth++
  ) {
    seen.add(cause);
    details.push(
      `${depth ? "Caused by " : ""}${safeDetail(cause.name)}: ${safeDetail(cause.message)}`,
    );
    const stack = typeof cause.stack === "string" ? cause.stack.slice(0, MAX_DIAGNOSTIC_CHARS) : "";
    const frame = stack
      .split("\n")
      .find((line) => line.includes(entrypoint) || line.includes(pathToFileURL(entrypoint).href));
    const location = frame?.match(/:(\d+)(?::(\d+))?\)?$/u);
    if (location)
      details.push(
        `  at ${safeDetail(basename(entrypoint))}:${location[1]}${location[2] ? `:${location[2]}` : ""}`,
      );
    cause = cause.cause;
  }
  if (!(error instanceof Error)) {
    details.push(typeof error === "string" ? safeDetail(error) : "Script threw a non-Error value.");
  }
  return `${details.join("\n").slice(0, MAX_DIAGNOSTIC_CHARS)}\n`;
}

function safeDetail(value: string): string {
  return redactFeedbackText(stripVTControlCharacters(value.slice(0, MAX_ERROR_DETAIL_CHARS)), {
    diagnostic: true,
  }).replace(/\p{Cc}/gu, " ");
}
