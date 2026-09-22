import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExploreSubagentPort } from "../../src/subagent/runner.js";
import { InMemoryRuntimeTaskRegistry } from "../../src/runtime-task/registry.js";

export const CHILD_MESSAGE = "inspect the latest change and report back";

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function createHarness(
  runExploreAgent: Parameters<typeof createExploreSubagentPort>[0]["runExploreAgent"],
) {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-message-"));
  const registry = new InMemoryRuntimeTaskRegistry();
  const notifications: string[] = [];
  const events: Array<{ type: string; status: unknown }> = [];
  const profile = {
    name: "probe-agent",
    description: "message coordination integration",
    source: "project" as const,
    systemPrompt: "",
    tools: ["Read"],
  };
  const port = createExploreSubagentPort({
    runtimeTaskRegistry: registry,
    createAgentId: () => "agent_message_race",
    outputRootDir,
    profiles: [profile],
    runExploreAgent,
    emitParentEvent: async (event) => {
      events.push({ type: event.type, status: (event.payload as Record<string, unknown>).status });
    },
    enqueueParentTaskNotification: (notification) => {
      notifications.push(notification.text);
      return undefined;
    },
  });
  const request = {
    sessionId: "parent_message_race" as never,
    parentToolCallId: "tool_parent_message_race",
    agentType: profile.name,
    description: "message admission race",
    prompt: "start a child task",
    workingDirectory: process.cwd(),
    workspaceRoot: process.cwd(),
    trace: {
      traceId: "trace_message_race" as never,
      spanId: "span_parent_message_race" as never,
      sessionId: "parent_message_race" as never,
    },
  };
  const messageRequest = (agentId: string, message = CHILD_MESSAGE) => ({
    sessionId: request.sessionId,
    parentToolCallId: "tool_send_message",
    to: agentId,
    summary: "follow up with the child",
    message,
    workingDirectory: request.workingDirectory,
    workspaceRoot: request.workspaceRoot,
    trace: request.trace,
  });
  return { events, messageRequest, notifications, outputRootDir, port, registry, request };
}
