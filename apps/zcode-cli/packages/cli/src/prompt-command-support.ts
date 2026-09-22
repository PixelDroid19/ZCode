import { formatJson } from "@zcode/core";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import { extname } from "node:path";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import type { CliPermissionMode, ModeCapableApp, RunDependencies } from "./cli-types.js";
import type { CommandCenterApp, SlashCommand } from "./command-center.js";
import { createCommandCenter } from "./command-center.js";

/**
 * Does this run print a JSON summary at the end?
 *
 * An explicit --output-format wins over the older --json flag, so that
 * `--output-format text` can turn the summary off again. Checking only
 * `options.json` here is a trap: `--output-format json` would parse fine and
 * then silently print plain text.
 */
export const wantsJsonSummary = (options: GlobalOptions): boolean =>
  options.outputFormat === undefined
    ? options.json
    : options.outputFormat === "json" || options.outputFormat === "stream-json";

/** Does this run write each session event as it happens? */
export const wantsEventStream = (options: GlobalOptions): boolean =>
  options.outputFormat === "stream-json";

const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"]);
export const EMPTY_PROMPT_ERROR = "--prompt requires non-empty text.";
export const MEMORY_BENCH_DISABLED_ERROR =
  "--memory-bench requires Project Memory to be enabled (features.memory=true and memory.use=true).";
const TARGET_SELECTION_UNAVAILABLE_ERROR =
  "Headless goal commands cannot open an interactive replacement picker. Re-run with --target-replace or use /goal replace <objective>.";

export function inferAttachmentTypeFromPath(path: string): "file" | "image" | "video" | "pdf" {
  const extension = extname(path).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (extension === ".pdf") return "pdf";
  return "file";
}

const customCommandNotFoundPattern = /not found/i;

/** headless 下这条 slash 命令该走 command-center 而不是普通 prompt 路径吗？ */
export async function routesToPromptCommandCenter(
  slashCommand: SlashCommand,
  deps: RunDependencies,
): Promise<boolean> {
  if (slashCommand.type === "known") {
    return slashCommand.name === "expert" || slashCommand.name === "goal";
  }
  return !(await isResolvableCustomCommand(deps, slashCommand.rawName));
}

export async function isResolvableCustomCommand(
  deps: RunDependencies,
  name: string,
): Promise<boolean> {
  // 保留名先问，再尝试加载——与 facade 那道 gate 的顺序逐字一致
  // （`bootstrap/src/custom-command-prompt.ts:31`）。判据必须是同一个：facade 对保留名
  // 直接返回 undefined、不做展开，所以这里若把一个保留名判成"可解析"，它就会以字面文本
  // `/compress …` 被当成普通 prompt 提交给模型——静默走错路，没有任何报错。
  //
  // 探测刻意用「保留名检查 + load」这一对，而不是直接调 resolveZCodeCustomCommandPrompt：
  // 后者会执行 `!` shell expansion，拿它探测等于把用户的 shell 片段跑两遍。
  // 这一对是它的无副作用等价物（load 只读文件）。
  if (await isReservedSlashCommandName(deps, name)) return false;
  try {
    await loadCustomCommandForPrompt(deps, name);
    return true;
  } catch (error) {
    // 只有"不存在"算不可解析（与 buildCustomCommandPrompt 同一判据）。读盘失败、
    // frontmatter 非法之类必须继续冒泡：把它们当成未知命令会用一句 "Unknown command"
    // 盖掉真正的失败原因。
    if (error instanceof Error && customCommandNotFoundPattern.test(error.message)) {
      return false;
    }
    throw error;
  }
}

async function isReservedSlashCommandName(deps: RunDependencies, name: string): Promise<boolean> {
  if (deps.isReservedSlashCommandName) return deps.isReservedSlashCommandName(name);
  const bootstrap = await loadBootstrapModule();
  return bootstrap.isReservedZCodeSlashCommandName(name);
}

export async function runPromptCommandCenterCommand(
  ctx: RunContext,
  options: GlobalOptions,
  app: ModeCapableApp,
  prompt: string,
  mode: CliPermissionMode | undefined,
  traceId: string | undefined,
  abortSignal: AbortSignal,
  deps: RunDependencies,
): Promise<number> {
  const commandCenter = createCommandCenter({
    getApp: async () => app as unknown as CommandCenterApp,
    getMode: () => app.getMode?.() ?? mode ?? "build",
    listCustomCommands: () => listCustomCommandsForPrompt(deps),
    loadCustomCommand: (name) => loadCustomCommandForPrompt(deps, name),
    recordInputHistory: async (input, kind) => {
      await app.recordInputHistory?.(input, kind);
    },
    resumeApp: async () => app as unknown as CommandCenterApp,
    setLocale: async (locale) => {
      if (!app.setLocale) {
        throw new Error("Locale switching is not available in this client.");
      }
      return await app.setLocale(locale);
    },
    setMode: async (nextMode) => {
      if (app.setMode) {
        const result = await app.setMode(nextMode);
        return result.mode;
      }
      app.runtime.updateConfig({ mode: nextMode });
      return nextMode;
    },
  });
  const result = await commandCenter(prompt, {
    abortSignal,
  });
  const nextTraceId = result.traceId ?? traceId;
  if (result.selection) {
    ctx.stderr.write(
      `Error: ${result.response}\n${TARGET_SELECTION_UNAVAILABLE_ERROR}${nextTraceId ? ` (traceId: ${nextTraceId})` : ""}\n`,
    );
    return 1;
  }

  if (options.memoryBench) {
    await app.runtime.drainMemoryExtractions(null);
    abortSignal.throwIfAborted();
  } else if (!result.selection) {
    await app.runtime.drainMemoryExtractions();
    abortSignal.throwIfAborted();
  }

  if (wantsJsonSummary(options)) {
    ctx.stdout.write(
      formatJson({
        sessionId: String(app.sessionId),
        ...(nextTraceId ? { traceId: nextTraceId } : {}),
        response: result.response,
      }),
    );
    return 0;
  }

  ctx.stdout.write(`${result.response}\n`);
  return 0;
}

export async function listCustomCommandsForPrompt(deps: RunDependencies) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  if (deps.listCustomCommands) {
    return await deps.listCustomCommands({ env, logger: deps.logger, workingDirectory });
  }
  const bootstrap = await loadBootstrapModule();
  return await bootstrap.listZCodeCustomCommands({ env, logger: deps.logger, workingDirectory });
}

async function loadCustomCommandForPrompt(deps: RunDependencies, name: string) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  if (deps.loadCustomCommand) {
    return await deps.loadCustomCommand({ env, logger: deps.logger, name, workingDirectory });
  }
  const bootstrap = await loadBootstrapModule();
  return await bootstrap.loadZCodeCustomCommand({
    env,
    logger: deps.logger,
    name,
    workingDirectory,
  });
}

const HEADLESS_WORKSPACE_HOOK_BLOCK_REASONS = [
  "workspace_hooks_pending_trust",
  "workspace_hooks_require_trust_capable_host",
  "workspace_hooks_feature_disabled",
] as const;
type HeadlessWorkspaceHookBlockReason = (typeof HEADLESS_WORKSPACE_HOOK_BLOCK_REASONS)[number];

export async function resolveHeadlessWorkspaceHookTrustDiagnostic(input: {
  bootstrapModule: Awaited<ReturnType<typeof loadBootstrapModule>> | undefined;
  deps: RunDependencies;
  events: readonly unknown[];
  workingDirectory: string;
}) {
  let reasonCode: HeadlessWorkspaceHookBlockReason | undefined;
  for (const event of input.events) {
    if (!event || typeof event !== "object") continue;
    const value = event as {
      type?: string;
      payload?: { errorCode?: string; descriptor?: { sourceKind?: string } };
    };
    if (value.type !== "hook_run_blocked" || value.payload?.descriptor?.sourceKind !== "project") {
      continue;
    }
    const errorCode = value.payload.errorCode;
    if (isHeadlessWorkspaceHookBlockReason(errorCode)) {
      reasonCode = errorCode;
      break;
    }
  }
  if (!reasonCode) return undefined;
  const inspect =
    input.deps.inspectWorkspaceHookTrust ?? input.bootstrapModule?.inspectWorkspaceHookTrust;
  if (!inspect) return undefined;
  const status = await inspect({
    workspacePath: input.workingDirectory,
    ...(input.deps.userConfigPath ? { userConfigPath: input.deps.userConfigPath } : {}),
  });
  return { ...status, reasonCode };
}

function isHeadlessWorkspaceHookBlockReason(
  value: string | undefined,
): value is HeadlessWorkspaceHookBlockReason {
  return HEADLESS_WORKSPACE_HOOK_BLOCK_REASONS.some((candidate) => candidate === value);
}

export function writeHeadlessWorkspaceHookTrustDiagnostic(
  ctx: RunContext,
  status: Awaited<ReturnType<NonNullable<RunDependencies["inspectWorkspaceHookTrust"]>>>,
): void {
  ctx.stderr.write(
    [
      `Workspace Hooks skipped: ${status.reasonCode}`,
      `workspace: ${status.workspaceIdentity}`,
      `bundle: ${status.bundleDigest ?? "none"}`,
      ...status.items
        .filter((item) => item.configuredEnabled && item.trustState !== "trusted_persistent")
        .map((item) => `pending digest: ${item.hookDeclarationDigest}`),
      `Review with: zcode hooks trust review --workspace ${JSON.stringify(status.workspaceIdentity)}`,
    ].join("\n") + "\n",
  );
}
