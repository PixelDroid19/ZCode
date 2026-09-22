import {
  materializeLiveToolScript,
  type LiveTool,
  type LiveToolScriptLease,
} from "@zcode/adapters/live-tools";
import type { ExecutionEnvOverlay } from "@zcode/contracts";
import type { ToolEntry } from "@zcode/core";

const LIVE_TOOL_TIMEOUT_MS = 30_000;
const LIVE_TOOL_OUTPUT_BYTES = 64 * 1024;

export interface LiveToolNodeRuntime {
  /** Explicit Node/SEA/Electron-compatible executable supplied by the host bootstrap. */
  executable: string;
  /** Prefix arguments, for example a SEA internal script-host dispatch command. */
  args?: readonly string[];
  /** Host-required process flags such as Electron's Node-mode environment overlay. */
  env?: ExecutionEnvOverlay;
}

export interface PrepareLiveToolEntriesOptions {
  nodeRuntime: LiveToolNodeRuntime;
  temporaryDirectory?: string;
}

export interface PreparedLiveToolEntries {
  tools: readonly ToolEntry[];
  dispose(): Promise<void>;
}

/**
 * Converts already validated definitions into normal executor-owned tools. Node scripts
 * are snapshotted before publication so an adopted schema cannot execute edited bytes.
 */
export async function prepareLiveToolEntries(
  tools: readonly LiveTool[],
  options: PrepareLiveToolEntriesOptions,
): Promise<PreparedLiveToolEntries> {
  validateNodeRuntime(options.nodeRuntime);
  const leases = new Map<LiveTool, LiveToolScriptLease>();
  try {
    for (const tool of tools) {
      if (tool.command.kind !== "node-script") continue;
      leases.set(
        tool,
        await materializeLiveToolScript(tool.command, {
          temporaryDirectory: options.temporaryDirectory,
        }),
      );
    }
    const entries = tools.map((tool) =>
      createLiveToolEntry(tool, leases.get(tool), options.nodeRuntime),
    );
    return Object.freeze({
      dispose: createDisposer(leases),
      tools: Object.freeze(entries),
    });
  } catch (error) {
    await Promise.all([...leases.values()].map((lease) => lease.dispose()));
    throw error;
  }
}

function createLiveToolEntry(
  tool: LiveTool,
  scriptLease: LiveToolScriptLease | undefined,
  nodeRuntime: LiveToolNodeRuntime,
): ToolEntry {
  const command = tool.command;
  if (command.kind === "node-script" && scriptLease === undefined) {
    throw new Error(`Live tool ${tool.name} has no immutable script snapshot`);
  }

  return {
    capability: `Run the live programmable tool ${tool.name}`,
    cancellation: {
      cleanup: "bestEffort",
      supported: true,
      userVisibleMessage: `Live tool ${tool.name} was cancelled`,
    },
    handler: async (input, context) => {
      if (!context.executionPort) {
        throw new Error(`Live tool ${tool.name} requires an ExecutionPort`);
      }
      const stdin = serializeInput(input, tool.name);
      const execution = await context.executionPort.run(
        {
          command:
            command.kind === "argv"
              ? { args: [...command.args], file: command.file, mode: "argv" }
              : {
                  args: [...(nodeRuntime.args ?? []), scriptLease!.path, ...command.args],
                  file: nodeRuntime.executable,
                  mode: "argv",
                },
          cwd: context.workingDirectory,
          env: command.kind === "node-script" ? nodeRuntime.env : undefined,
          outputLimit: {
            killProcessOnPersistedLimit: true,
            maxBufferBytes: LIVE_TOOL_OUTPUT_BYTES,
            maxInlineBytes: LIVE_TOOL_OUTPUT_BYTES,
            maxPersistedBytes: LIVE_TOOL_OUTPUT_BYTES,
            persistOutput: "on_truncate",
          },
          stdin,
          timeoutMs: LIVE_TOOL_TIMEOUT_MS,
          trace: context.traceContext,
        },
        { signal: context.abortSignal },
      );
      return parseExecutionOutput(execution, tool.name);
    },
    inputSchema: tool.inputSchema,
    metadata: {
      concurrentSafe: false,
      destructive: true,
      description: tool.description,
      maxOutputBytes: LIVE_TOOL_OUTPUT_BYTES,
      name: tool.name,
      needsApproval: true,
      readOnly: false,
      riskLevel: "high",
      sideEffectScope: "system",
      timeoutMs: LIVE_TOOL_TIMEOUT_MS,
    },
    outputSchema: tool.outputSchema,
    permission: {
      denyPriority: "beforeAsk",
      needsApproval: true,
      patternSources: ["command"],
      permission: `liveTool:${tool.identity}`,
      reason: `Live tool ${tool.name} runs a configured local process`,
      riskLevel: "high",
      sideEffectScope: "system",
    },
    resultBudget: {
      maxInlineBytes: LIVE_TOOL_OUTPUT_BYTES,
      maxModelBytes: LIVE_TOOL_OUTPUT_BYTES,
      strategy: "truncate",
    },
    timeout: {
      allowCallOverride: false,
      defaultMs: LIVE_TOOL_TIMEOUT_MS,
      maxMs: LIVE_TOOL_TIMEOUT_MS,
    },
    trace: {
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
      required: true,
    },
  };
}

function parseExecutionOutput(
  execution: {
    cancelled: boolean;
    exitCode?: number;
    status: string;
    stderr: { bytes: number; text: string; truncated: boolean };
    stdout: { bytes: number; text: string; truncated: boolean };
    timedOut: boolean;
  },
  toolName: string,
): unknown {
  if (execution.cancelled) throw new Error(`Live tool ${toolName} was cancelled`);
  if (execution.timedOut) throw new Error(`Live tool ${toolName} timed out`);
  if (execution.status !== "completed" || execution.exitCode !== 0) {
    const detail = execution.stderr.text.trim();
    throw new Error(
      detail.length === 0
        ? `Live tool ${toolName} failed to run`
        : `Live tool ${toolName} failed to run: ${detail.slice(0, 1_024)}`,
    );
  }
  if (execution.stdout.truncated || execution.stdout.bytes > LIVE_TOOL_OUTPUT_BYTES) {
    throw new Error(`Live tool ${toolName} exceeded its stdout budget`);
  }
  try {
    return JSON.parse(execution.stdout.text);
  } catch (cause) {
    throw new Error(`Live tool ${toolName} must write exactly one JSON value to stdout`, { cause });
  }
}

function serializeInput(input: unknown, toolName: string): string {
  try {
    const serialized = JSON.stringify(input);
    if (serialized === undefined) throw new Error("Input is not JSON serializable");
    return serialized;
  } catch (cause) {
    throw new Error(`Live tool ${toolName} input cannot be encoded as JSON`, { cause });
  }
}

function validateNodeRuntime(runtime: LiveToolNodeRuntime): void {
  if (typeof runtime?.executable !== "string" || runtime.executable.trim().length === 0) {
    throw new Error("Live tool nodeRuntime.executable must be provided by the host");
  }
  if (runtime.args !== undefined && runtime.args.some((argument) => typeof argument !== "string")) {
    throw new Error("Live tool nodeRuntime.args must contain only strings");
  }
}

function createDisposer(leases: ReadonlyMap<LiveTool, LiveToolScriptLease>): () => Promise<void> {
  let disposed = false;
  return async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await Promise.all([...leases.values()].map((lease) => lease.dispose()));
  };
}
