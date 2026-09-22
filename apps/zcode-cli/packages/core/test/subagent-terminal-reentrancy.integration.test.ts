import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { SubagentPort } from "@zcode/contracts";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test(
  "stop can cancel a resumed worker waiting before session readiness",
  { timeout: 10_000 },
  async () => {
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-resume-stop-"));
    const registry = new InMemoryRuntimeTaskRegistry();
    const notifications: string[] = [];
    const events: Array<{ type: string; status: unknown }> = [];
    const resumedWorkerStarted = deferred<void>();
    let invocation = 0;
    const profile = {
      name: "probe-agent",
      description: "terminal readiness cancellation",
      source: "project" as const,
      systemPrompt: "",
      tools: ["Read"],
    };
    const port = createExploreSubagentPort({
      runtimeTaskRegistry: registry,
      createAgentId: () => "agent_resume_stop",
      outputRootDir,
      profiles: [profile],
      runExploreAgent: async (request, options) => {
        invocation += 1;
        if (invocation === 1) {
          await request.onSessionReady?.();
          return {
            response: "initial completed result",
            traceId: request.traceContext.traceId,
            events: [],
          };
        }

        resumedWorkerStarted.resolve();
        await new Promise<never>((_resolve, reject) => {
          const signal = options?.signal;
          if (!signal) throw new Error("resumed worker did not receive an abort signal");
          const rejectOnAbort = () => reject(signal.reason ?? new Error("aborted"));
          if (signal.aborted) rejectOnAbort();
          else signal.addEventListener("abort", rejectOnAbort, { once: true });
        });
        throw new Error("unreachable after stop abort");
      },
      emitParentEvent: async (event) => {
        events.push({
          type: event.type,
          status: (event.payload as Record<string, unknown>).status,
        });
      },
      enqueueParentTaskNotification: (notification) => {
        notifications.push(notification.text);
        return undefined;
      },
    });
    const request = {
      sessionId: "parent_resume_stop" as never,
      parentToolCallId: "tool_resume_stop",
      agentType: profile.name,
      description: "resume then stop",
      prompt: "first execution",
      workingDirectory: process.cwd(),
      workspaceRoot: process.cwd(),
      trace: {
        traceId: "trace_resume_stop" as never,
        spanId: "span_resume_parent" as never,
        sessionId: "parent_resume_stop" as never,
      },
    };

    try {
      const launched = await port.start!(request);
      await port.waitForTask!(launched.agentId);
      assert.equal((await port.stopTask!(launched.agentId))?.status, "completed");

      const resumeRequest = port.sendMessage!({
        sessionId: request.sessionId,
        parentToolCallId: "tool_resume_message",
        to: launched.agentId,
        summary: "resume the completed agent",
        message: "continue the work",
        workingDirectory: request.workingDirectory,
        workspaceRoot: request.workspaceRoot,
        trace: request.trace,
      });
      const resumeSettled = resumeRequest.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      await resumedWorkerStarted.promise;

      const stopped = await port.stopTask!(launched.agentId);
      assert.equal(stopped?.status, "killed");
      await resumeSettled;
      await nextEventLoopTurn();

      assert.equal(registry.get(launched.agentId)?.status, "killed");
      assert.equal(await readFile(launched.outputFile, "utf8"), "Background agent task stopped.\n");
      const metadata = JSON.parse(
        await readFile(join(dirname(launched.outputFile), "metadata.json"), "utf8"),
      ) as { status: string };
      assert.equal(metadata.status, "stopped");
      assert.deepEqual(
        events
          .filter(
            (event) =>
              event.type === "background_task_completed" || event.type === "subagent_stopped",
          )
          .map((event) => event.status),
        ["completed", "completed", "cancelled", "stopped"],
      );
      assert.deepEqual(
        notifications.map((text) => text.match(/<status>([^<]+)<\/status>/)?.[1]),
        ["completed", "stopped"],
      );
    } finally {
      await rm(outputRootDir, { recursive: true, force: true });
    }
  },
);

test(
  "a terminal event sink can await a reentrant stop for the same agent",
  { timeout: 10_000 },
  async () => {
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-reentrant-stop-"));
    const registry = new InMemoryRuntimeTaskRegistry();
    const nestedStop = deferred<string | undefined>();
    const workerWaiting = deferred<void>();
    const terminalEvents: string[] = [];
    let port: SubagentPort;
    const profile = {
      name: "probe-agent",
      description: "reentrant terminal event",
      source: "project" as const,
      systemPrompt: "",
      tools: ["Read"],
    };
    port = createExploreSubagentPort({
      runtimeTaskRegistry: registry,
      createAgentId: () => "agent_reentrant_stop",
      outputRootDir,
      profiles: [profile],
      runExploreAgent: async (request, options) => {
        const signal = options?.signal;
        if (!signal) throw new Error("background worker did not receive an abort signal");
        const abortPromise = new Promise<never>((_resolve, reject) => {
          const rejectOnAbort = () => reject(signal.reason ?? new Error("aborted"));
          if (signal.aborted) rejectOnAbort();
          else signal.addEventListener("abort", rejectOnAbort, { once: true });
        });
        await request.onSessionReady?.();
        workerWaiting.resolve();
        await abortPromise;
        throw new Error("unreachable after stop abort");
      },
      emitParentEvent: async (event) => {
        const payload = event.payload as Record<string, unknown>;
        if (event.type !== "background_task_completed" && event.type !== "subagent_stopped") return;
        terminalEvents.push(`${event.type}:${String(payload.status)}`);
        if (event.type === "subagent_stopped" && payload.status === "stopped") {
          nestedStop.resolve((await port.stopTask!("agent_reentrant_stop"))?.status);
        }
      },
      enqueueParentTaskNotification: () => undefined,
    });
    const request = {
      sessionId: "parent_reentrant_stop" as never,
      parentToolCallId: "tool_reentrant_stop",
      agentType: profile.name,
      description: "reentrant stop",
      prompt: "return a short result",
      workingDirectory: process.cwd(),
      workspaceRoot: process.cwd(),
      trace: {
        traceId: "trace_reentrant_stop" as never,
        spanId: "span_reentrant_parent" as never,
        sessionId: "parent_reentrant_stop" as never,
      },
    };

    try {
      const launched = await port.start!(request);
      await workerWaiting.promise;
      const stop = await port.stopTask!(launched.agentId);
      assert.equal(stop?.status, "killed");
      assert.equal(await nestedStop.promise, "killed");
      assert.deepEqual(terminalEvents, [
        "background_task_completed:cancelled",
        "subagent_stopped:stopped",
      ]);
      assert.equal(registry.get(launched.agentId)?.status, "killed");
    } finally {
      await rm(outputRootDir, { recursive: true, force: true });
    }
  },
);
